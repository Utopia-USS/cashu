// Security rules (/firestore.rules) against the Firestore + Auth emulators, through our own REST client
// and anonymous auth (no Firebase SDK). Skipped unless the emulators run. Run with:
// JAVA_HOME=/opt/homebrew/opt/openjdk/libexec/openjdk.jdk/Contents/Home PATH=/opt/homebrew/opt/openjdk/bin:$PATH firebase emulators:exec --only firestore,auth --project demo-cashu 'pnpm --filter @cashu/sync exec vitest run src/transports/firestore'
// (Java 21+; project id `demo-cashu` only, no login.) Synthetic ids and bytes only. Delete the
// `*-debug.log` files the emulators leave in the repo root afterwards.
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MemoryAuthStore } from "../../testing/firestore-fake.js";
import { AnonymousAuth } from "./auth.js";
import {
  clearData,
  type EmulatorHosts,
  emulatorEndpoint,
  emulatorHosts,
  emulatorIdentity,
  ownerRest,
} from "./emulator.js";
import {
  bytes,
  FirestoreRest,
  FirestoreRestError,
  type FsPrecondition,
  type FsValue,
  type FsWrite,
  int,
  str,
  ts,
} from "./rest.js";

const hosts = emulatorHosts();

const V = "a1".repeat(16);
/** A second vault where only the admin a is a member. */
const W = "a2".repeat(16);
const DA = "da".repeat(16);
const DB = "db".repeat(16);
const DC = "dc".repeat(16);
const DX = "dd".repeat(16);
const SID = "5e".repeat(16);
const MAX_CHUNK = 716_800;
/** The transport's cap of chunk writes per commit (besides the meta), see the rules header. */
const MAX_CHUNKS_PER_COMMIT = 9;

interface Actor {
  readonly uid: string;
  readonly rest: FirestoreRest;
}

interface World {
  readonly owner: FirestoreRest;
  /** Admin (the Mac, device DA). */
  readonly a: Actor;
  /** Member (a phone, device DB). */
  readonly b: Actor;
  /** Member (another phone, device DC). */
  readonly c: Actor;
  /** Signed in, not a member yet: the phone DB after it lost its anonymous identity. */
  readonly b2: Actor;
  /** Signed in, not a member. */
  readonly x: Actor;
  /** Another signed-in stranger. */
  readonly y: Actor;
}

async function actor(h: EmulatorHosts): Promise<Actor> {
  const auth = new AnonymousAuth({ endpoint: emulatorIdentity(h), store: new MemoryAuthStore() });
  const rest = new FirestoreRest({ endpoint: emulatorEndpoint(h), auth, retries: 0 });
  return { uid: await auth.uid(), rest };
}

/** "ok" or the REST error code of the call. */
async function outcome(call: Promise<unknown>): Promise<string> {
  try {
    await call;
    return "ok";
  } catch (error) {
    if (error instanceof FirestoreRestError) return error.code;
    throw error;
  }
}

const DENIED = "permission-denied";
const NULL: FsValue = { nullValue: null };
const at = (offsetMs: number) => ts(new Date(Date.now() + offsetMs).toISOString());
const vaultPath = (v = V) => `vaults/${v}`;
const memberPath = (uid: string, v = V) => `vaults/${v}/members/${uid}`;
const segPath = (device: string, seg: number, id = `${device}_${String(seg).padStart(10, "0")}`) =>
  `vaults/${V}/segments/${id}`;
const chunkPath = (seg: string, start: number, id = String(start).padStart(12, "0")) =>
  `${seg}/chunks/${id}`;
const pairingPath = `vaults/${V}/pairings/${SID}`;
const messagePath = (n: number) => `${pairingPath}/messages/${String(n).padStart(4, "0")}`;

const vaultDoc = (admin: string) => ({
  createdAt: at(0),
  admins: { arrayValue: { values: [str(admin)] } },
});
const memberDoc = (device: string, role: "admin" | "member") => ({
  device: str(device),
  role: str(role),
  addedAt: at(0),
});
const metaDoc = (device: string, seg: number, size: number, writer: string, rev: number) => ({
  device: str(device),
  seg: int(seg),
  size: int(size),
  updatedAt: at(0),
  writer: str(writer),
  rev: int(rev),
});
const chunkDoc = (start: number, length: number, end = start + length) => ({
  start: int(start),
  end: int(end),
  bytes: bytes(new Uint8Array(length).fill(7)),
});
const pairingDoc = (inviter: string, joiner: string | null, expiresInMs: number) => ({
  inviter: str(inviter),
  joiner: joiner === null ? NULL : str(joiner),
  expiresAt: at(expiresInMs),
  createdAt: at(0),
});
const messageDoc = (from: string, n: number, box: FsValue = bytes(new Uint8Array(48).fill(9))) => ({
  from: str(from),
  n: int(n),
  box,
  part: int(0),
  parts: int(1),
  createdAt: at(0),
});

describe.skipIf(!hosts)("firestore security rules (emulator)", () => {
  let world: World;
  const set = (path: string, fields: Record<string, FsValue>, pre?: FsPrecondition): FsWrite => ({
    update: { name: world.owner.fullName(path), fields },
    ...(pre ? { currentDocument: pre } : {}),
  });
  const del = (path: string): FsWrite => ({ delete: world.owner.fullName(path) });
  const commit = (who: Actor, ...writes: FsWrite[]) => outcome(who.rest.commit(writes));
  const claim = (who: Actor, path = pairingPath) =>
    commit(who, {
      update: { name: world.owner.fullName(path), fields: { joiner: str(who.uid) } },
      updateMask: { fieldPaths: ["joiner"] },
    });

  beforeAll(async () => {
    if (!hosts) return;
    const [a, b, c, b2, x, y] = (await Promise.all(
      Array.from({ length: 6 }, () => actor(hosts)),
    )) as [Actor, Actor, Actor, Actor, Actor, Actor];
    world = { owner: ownerRest(hosts), a, b, c, b2, x, y };
  });

  // Every test starts from: vault V with admin a (device DA), members b (DB) and c (DC), b's segment 0
  // (10 bytes in one chunk, rev 1), and vault W with only a. Seeded as the owner (rules skipped).
  beforeEach(async () => {
    if (!hosts) return;
    await clearData(hosts);
    const { a, b, c } = world;
    const seg0 = segPath(DB, 0);
    await world.owner.commit([
      set(vaultPath(), vaultDoc(a.uid)),
      set(memberPath(a.uid), memberDoc(DA, "admin")),
      set(memberPath(b.uid), memberDoc(DB, "member")),
      set(memberPath(c.uid), memberDoc(DC, "member")),
      set(seg0, metaDoc(DB, 0, 10, b.uid, 1)),
      set(chunkPath(seg0, 0), chunkDoc(0, 10)),
      set(vaultPath(W), vaultDoc(a.uid)),
      set(memberPath(a.uid, W), memberDoc(DA, "admin")),
      set(`vaults/${W}/segments/${DA}_0000000000`, metaDoc(DA, 0, 0, a.uid, 1)),
    ]);
  });

  it("lets a vault be created only by its first admin, with its admin member doc", async () => {
    const { x, y } = world;
    const w = "b2".repeat(16);
    expect(
      await commit(
        x,
        set(vaultPath(w), vaultDoc(x.uid), { exists: false }),
        set(memberPath(x.uid, w), memberDoc(DX, "admin"), { exists: false }),
      ),
    ).toBe("ok");
    const w2 = "b3".repeat(16);
    // Naming someone else as admin, or a vault without its admin member doc.
    expect(
      await commit(
        y,
        set(vaultPath(w2), vaultDoc(x.uid)),
        set(memberPath(y.uid, w2), memberDoc(DX, "admin")),
      ),
    ).toBe(DENIED);
    expect(await commit(y, set(vaultPath(w2), vaultDoc(y.uid)))).toBe(DENIED);
    // A vault id that is not 32 hex.
    expect(
      await commit(
        y,
        set("vaults/not-a-vault", vaultDoc(y.uid)),
        set(memberPath(y.uid, "not-a-vault"), memberDoc(DX, "admin")),
      ),
    ).toBe(DENIED);
    // The creation path cannot be replayed on an existing vault to make oneself admin.
    expect(await commit(y, set(memberPath(y.uid), memberDoc(DX, "admin")))).toBe(DENIED);
    expect(
      await commit(
        y,
        set(vaultPath(), vaultDoc(y.uid)),
        set(memberPath(y.uid), memberDoc(DX, "admin")),
      ),
    ).toBe(DENIED);
  });

  it("never deletes the vault doc, so a known vault id cannot be re-bootstrapped", async () => {
    const { a, b, c, y } = world;
    expect(await commit(b, set(vaultPath(), vaultDoc(b.uid)))).toBe(DENIED);
    expect(await commit(b, del(vaultPath()))).toBe(DENIED);
    expect(await commit(a, del(vaultPath()))).toBe(DENIED);
    expect(await commit(a, set(vaultPath(), vaultDoc(a.uid)))).toBe("ok");
    // Even with every member removed (the admin deletes the others, then itself), the vault doc stays and
    // a stranger cannot become the first admin of the known id.
    expect(
      await commit(a, del(memberPath(b.uid)), del(memberPath(c.uid)), del(memberPath(a.uid))),
    ).toBe("ok");
    expect(await world.owner.get(vaultPath())).toBeDefined();
    expect(
      await commit(
        y,
        set(vaultPath(), vaultDoc(y.uid), { exists: false }),
        set(memberPath(y.uid), memberDoc(DX, "admin"), { exists: false }),
      ),
    ).not.toBe("ok");
    expect(
      await commit(
        y,
        set(vaultPath(), vaultDoc(y.uid)),
        set(memberPath(y.uid), memberDoc(DX, "admin")),
      ),
    ).toBe(DENIED);
    expect(await commit(y, set(memberPath(y.uid), memberDoc(DX, "admin")))).toBe(DENIED);
  });

  it("shows a non-member nothing: vault, members, segments, chunks, other vaults", async () => {
    const { x, a, b } = world;
    const seg0 = segPath(DB, 0);
    expect(await outcome(x.rest.get(vaultPath()))).toBe(DENIED);
    expect(await outcome(x.rest.get(memberPath(a.uid)))).toBe(DENIED);
    expect(await outcome(x.rest.get(seg0))).toBe(DENIED);
    expect(await outcome(x.rest.get(chunkPath(seg0, 0)))).toBe(DENIED);
    expect(await outcome(x.rest.runQuery(vaultPath(), { collectionId: "members" }))).toBe(DENIED);
    expect(await outcome(x.rest.runQuery(vaultPath(), { collectionId: "segments" }))).toBe(DENIED);
    expect(await outcome(x.rest.runQuery(seg0, { collectionId: "chunks" }))).toBe(DENIED);
    // The member b reads all of V, and nothing of W (a vault it does not belong to).
    expect(await b.rest.get(vaultPath())).toBeDefined();
    expect(await b.rest.get(memberPath(a.uid))).toBeDefined();
    expect(await b.rest.get(seg0)).toBeDefined();
    expect(await b.rest.runQuery(vaultPath(), { collectionId: "segments" })).toHaveLength(1);
    expect(await b.rest.runQuery(seg0, { collectionId: "chunks" })).toHaveLength(1);
    expect(await outcome(b.rest.get(vaultPath(W)))).toBe(DENIED);
    expect(await outcome(b.rest.get(`vaults/${W}/segments/${DA}_0000000000`))).toBe(DENIED);
    expect(await outcome(b.rest.runQuery(vaultPath(W), { collectionId: "segments" }))).toBe(DENIED);
    expect(await a.rest.runQuery(vaultPath(W), { collectionId: "segments" })).toHaveLength(1);
  });

  it("lets a member create and grow only its own device's segment", async () => {
    const { a, b } = world;
    const seg1 = segPath(DB, 1);
    expect(
      await commit(
        b,
        set(seg1, metaDoc(DB, 1, 4, b.uid, 1), { exists: false }),
        set(chunkPath(seg1, 0), chunkDoc(0, 4)),
      ),
    ).toBe("ok");
    const seg0 = segPath(DB, 0);
    expect(
      await commit(
        b,
        set(seg0, metaDoc(DB, 0, 15, b.uid, 2)),
        set(chunkPath(seg0, 10), chunkDoc(10, 5)),
      ),
    ).toBe("ok");
    // Another device's segment, a foreign writer, a seg number that disagrees with the id, an unpadded id.
    expect(await commit(b, set(segPath(DA, 0), metaDoc(DA, 0, 4, b.uid, 1)))).toBe(DENIED);
    expect(await commit(b, set(segPath(DB, 2), metaDoc(DB, 2, 4, a.uid, 1)))).toBe(DENIED);
    expect(await commit(b, set(segPath(DB, 3), metaDoc(DB, 4, 4, b.uid, 1)))).toBe(DENIED);
    expect(await commit(b, set(segPath(DB, 5, `${DB}_5`), metaDoc(DB, 5, 4, b.uid, 1)))).toBe(
      DENIED,
    );
    // The admin is bound to its own device too.
    expect(await commit(a, set(segPath(DB, 6), metaDoc(DB, 6, 4, a.uid, 1)))).toBe(DENIED);
    expect(await commit(a, set(segPath(DA, 0), metaDoc(DA, 0, 0, a.uid, 1)))).toBe("ok");
  });

  it("refuses a meta with an extra key, a non-int field or a rev out of step", async () => {
    const { b } = world;
    const seg0 = segPath(DB, 0);
    const seg8 = segPath(DB, 8);
    expect(await commit(b, set(seg8, { ...metaDoc(DB, 8, 4, b.uid, 1), note: str("x") }))).toBe(
      DENIED,
    );
    expect(await commit(b, set(seg8, { ...metaDoc(DB, 8, 4, b.uid, 1), size: str("4") }))).toBe(
      DENIED,
    );
    expect(await commit(b, set(seg8, { ...metaDoc(DB, 8, 4, b.uid, 1), seg: str("8") }))).toBe(
      DENIED,
    );
    const { rev: _rev, ...noRev } = metaDoc(DB, 8, 4, b.uid, 1);
    expect(await commit(b, set(seg8, noRev))).toBe(DENIED);
    expect(await commit(b, set(seg8, metaDoc(DB, 8, 4, b.uid, 2)))).toBe(DENIED);
    // An update must count up by exactly one, so every commit changes the meta.
    expect(await commit(b, set(seg0, metaDoc(DB, 0, 12, b.uid, 1)))).toBe(DENIED);
    expect(await commit(b, set(seg0, metaDoc(DB, 0, 12, b.uid, 3)))).toBe(DENIED);
    expect(await commit(b, set(seg0, { ...metaDoc(DB, 0, 12, b.uid, 2), note: str("x") }))).toBe(
      DENIED,
    );
    expect(await commit(b, set(seg0, { ...metaDoc(DB, 0, 12, b.uid, 2), size: str("12") }))).toBe(
      DENIED,
    );
    expect(await commit(b, set(seg0, metaDoc(DB, 0, 12, b.uid, 2)))).toBe("ok");
  });

  it("never shrinks a segment and lets no other member update it", async () => {
    const { a, b, c } = world;
    const seg0 = segPath(DB, 0);
    expect(await commit(b, set(seg0, metaDoc(DB, 0, 5, b.uid, 2)))).toBe(DENIED);
    expect(await commit(a, set(seg0, metaDoc(DB, 0, 20, b.uid, 2)))).toBe(DENIED);
    expect(await commit(a, set(seg0, metaDoc(DB, 0, 20, a.uid, 2)))).toBe(DENIED);
    expect(await commit(c, set(seg0, metaDoc(DB, 0, 20, c.uid, 2)))).toBe(DENIED);
    // Same size: an intermediate commit of a multi-commit append.
    expect(await commit(b, set(seg0, metaDoc(DB, 0, 10, b.uid, 2)))).toBe("ok");
  });

  it("accepts a chunk only from the segment's device, with its meta, as bytes, <= 716800, end - start == size", async () => {
    const { a, b, c, x } = world;
    const seg0 = segPath(DB, 0);
    // A chunk needs its segment meta (in the same commit or before): no chunks under a missing meta.
    const seg7 = segPath(DB, 7);
    expect(await commit(b, set(chunkPath(seg7, 0), chunkDoc(0, 4)))).toBe(DENIED);
    expect(
      await commit(
        b,
        set(seg7, metaDoc(DB, 7, 0, b.uid, 1), { exists: false }),
        set(chunkPath(seg7, 0), chunkDoc(0, MAX_CHUNK)),
      ),
    ).toBe("ok");
    expect(
      await commit(
        b,
        set(seg7, metaDoc(DB, 7, 0, b.uid, 2)),
        set(chunkPath(seg7, MAX_CHUNK), chunkDoc(MAX_CHUNK, MAX_CHUNK + 1)),
      ),
    ).toBe(DENIED);
    expect(await commit(b, set(chunkPath(seg0, 10), chunkDoc(10, 5)))).toBe("ok");
    expect(await commit(a, set(chunkPath(seg0, 15), chunkDoc(15, 5)))).toBe(DENIED);
    expect(await commit(c, set(chunkPath(seg0, 15), chunkDoc(15, 5)))).toBe(DENIED);
    expect(await commit(x, set(chunkPath(seg0, 15), chunkDoc(15, 5)))).toBe(DENIED);
    expect(await commit(b, set(chunkPath(seg0, 15), chunkDoc(15, 5, 21)))).toBe(DENIED);
    expect(await commit(b, set(chunkPath(seg0, 15, "000000000016"), chunkDoc(15, 5)))).toBe(DENIED);
    expect(await commit(b, set(chunkPath(seg0, 15), { ...chunkDoc(15, 5), note: str("x") }))).toBe(
      DENIED,
    );
    expect(
      await commit(
        b,
        set(chunkPath(seg0, 15), { start: int(15), end: int(20), bytes: str("AAAAA") }),
      ),
    ).toBe(DENIED);
    // A segment id that is not `<device>_<10 digits>` (seeded meta, so only the chunk rule decides).
    const odd = segPath(DB, 0, `${DB}_0`);
    await world.owner.commit([set(odd, metaDoc(DB, 0, 0, b.uid, 1))]);
    expect(await commit(b, set(chunkPath(odd, 0), chunkDoc(0, 4)))).toBe(DENIED);
  });

  it("lets a device re-granted under a new uid keep writing its segments (identity loss)", async () => {
    const { a, b, b2, c } = world;
    const seg1 = segPath(DB, 1);
    // b writes a segment through the rules.
    expect(
      await commit(
        b,
        set(seg1, metaDoc(DB, 1, 8, b.uid, 1), { exists: false }),
        set(chunkPath(seg1, 0), chunkDoc(0, 8)),
      ),
    ).toBe("ok");
    // Before the re-grant the new uid is a stranger.
    expect(
      await commit(
        b2,
        set(seg1, metaDoc(DB, 1, 12, b2.uid, 2)),
        set(chunkPath(seg1, 8), chunkDoc(8, 4)),
      ),
    ).toBe(DENIED);
    // The Mac moves device DB from b's uid to b2's.
    expect(
      await commit(a, del(memberPath(b.uid)), set(memberPath(b2.uid), memberDoc(DB, "member"))),
    ).toBe("ok");
    // b2 grows both of DB's segments; the writer moves to b2.
    expect(
      await commit(
        b2,
        set(seg1, metaDoc(DB, 1, 12, b2.uid, 2)),
        set(chunkPath(seg1, 8), chunkDoc(8, 4)),
      ),
    ).toBe("ok");
    const seg0 = segPath(DB, 0);
    expect(
      await commit(
        b2,
        set(seg0, metaDoc(DB, 0, 13, b2.uid, 2)),
        set(chunkPath(seg0, 10), chunkDoc(10, 3)),
      ),
    ).toBe("ok");
    // ...and opens a new one.
    const seg2 = segPath(DB, 2);
    expect(
      await commit(
        b2,
        set(seg2, metaDoc(DB, 2, 4, b2.uid, 1), { exists: false }),
        set(chunkPath(seg2, 0), chunkDoc(0, 4)),
      ),
    ).toBe("ok");
    // b2 cannot keep the old uid as writer.
    expect(await commit(b2, set(seg1, metaDoc(DB, 1, 12, b.uid, 3)))).toBe(DENIED);
    // The old uid has no membership left; another device's member is still refused.
    expect(
      await commit(
        b,
        set(seg1, metaDoc(DB, 1, 16, b.uid, 3)),
        set(chunkPath(seg1, 12), chunkDoc(12, 4)),
      ),
    ).toBe(DENIED);
    expect(await outcome(b.rest.get(seg1))).toBe(DENIED);
    expect(
      await commit(
        c,
        set(seg1, metaDoc(DB, 1, 16, c.uid, 3)),
        set(chunkPath(seg1, 12), chunkDoc(12, 4)),
      ),
    ).toBe(DENIED);
    expect(await commit(c, set(chunkPath(seg1, 12), chunkDoc(12, 4)))).toBe(DENIED);
    const meta = await world.owner.get(seg1);
    expect(meta?.fields.writer).toEqual(str(b2.uid));
    expect(meta?.fields.size).toEqual(int(12));
  });

  it(`takes meta + ${MAX_CHUNKS_PER_COMMIT} full chunks in one commit (the transport's cap)`, async () => {
    const { b } = world;
    const seg3 = segPath(DB, 3);
    const chunks = (from: number) =>
      Array.from({ length: MAX_CHUNKS_PER_COMMIT }, (_, k) =>
        set(chunkPath(seg3, from + k * MAX_CHUNK), chunkDoc(from + k * MAX_CHUNK, MAX_CHUNK)),
      );
    const size = MAX_CHUNKS_PER_COMMIT * MAX_CHUNK;
    // A first commit that creates the meta, then a second that grows it (the update rule).
    expect(
      await commit(b, set(seg3, metaDoc(DB, 3, size, b.uid, 1), { exists: false }), ...chunks(0)),
    ).toBe("ok");
    expect(await commit(b, set(seg3, metaDoc(DB, 3, 2 * size, b.uid, 2)), ...chunks(size))).toBe(
      "ok",
    );
    expect(await b.rest.runQuery(seg3, { collectionId: "chunks", select: ["start"] })).toHaveLength(
      2 * MAX_CHUNKS_PER_COMMIT,
    );
  }, 60_000);

  it("lets only an admin delete segments, chunks, members and pairings, in purge-sized batches", async () => {
    const { a, b, c } = world;
    const seg0 = segPath(DB, 0);
    await world.owner.commit([set(pairingPath, pairingDoc(a.uid, null, 600_000))]);
    expect(await commit(b, del(seg0))).toBe(DENIED);
    expect(await commit(b, del(chunkPath(seg0, 0)))).toBe(DENIED);
    expect(await commit(b, del(memberPath(c.uid)))).toBe(DENIED);
    expect(await commit(b, del(memberPath(b.uid)))).toBe(DENIED);
    expect(await commit(b, del(pairingPath))).toBe(DENIED);
    expect(await commit(a, del(pairingPath))).toBe("ok");
    // A purge batch of 400 deletes (one segment meta and 399 chunks) by the admin.
    const seg9 = segPath(DB, 9);
    const docs = [
      set(seg9, metaDoc(DB, 9, 399, b.uid, 1)),
      ...Array.from({ length: 399 }, (_, k) => set(chunkPath(seg9, k), chunkDoc(k, 1))),
    ];
    await world.owner.commit(docs);
    const deletes = docs.map((w) => ("update" in w ? { delete: w.update.name } : w));
    // 20 for the member: the emulator's denial message for 400 writes overflows its HTTP/2 stream (500).
    expect(await commit(b, ...deletes.slice(0, 20))).toBe(DENIED);
    expect(await commit(a, ...deletes)).toBe("ok");
    expect(await world.owner.get(seg9)).toBeUndefined();
    expect(await commit(a, del(chunkPath(seg0, 0)), del(seg0), del(memberPath(c.uid)))).toBe("ok");
  }, 60_000);

  it("lets an admin add members and a member none", async () => {
    const { a, b, x } = world;
    const xMember = memberPath(x.uid);
    expect(await commit(b, set(xMember, memberDoc(DX, "member")))).toBe(DENIED);
    expect(await commit(b, set(memberPath(b.uid), memberDoc(DB, "admin")))).toBe(DENIED);
    expect(await commit(x, set(xMember, memberDoc(DX, "member")))).toBe(DENIED);
    expect(await commit(a, set(xMember, { ...memberDoc(DX, "member"), note: str("x") }))).toBe(
      DENIED,
    );
    expect(await commit(a, set(xMember, memberDoc(DX, "member")))).toBe("ok");
    expect(await x.rest.get(vaultPath())).toBeDefined();
  });

  it("lets an admin open a pairing that one signed-in device claims once before expiry", async () => {
    const { a, b, x, y } = world;
    expect(await commit(b, set(pairingPath, pairingDoc(b.uid, null, 600_000)))).toBe(DENIED);
    expect(await commit(a, set(pairingPath, pairingDoc(a.uid, x.uid, 600_000)))).toBe(DENIED);
    expect(
      await commit(a, set(pairingPath, { ...pairingDoc(a.uid, null, 600_000), note: str("x") })),
    ).toBe(DENIED);
    const { expiresAt: _expiresAt, ...noExpiry } = pairingDoc(a.uid, null, 600_000);
    expect(await commit(a, set(pairingPath, noExpiry))).toBe(DENIED);
    expect(await commit(a, set(pairingPath, pairingDoc(a.uid, null, 600_000)))).toBe("ok");
    expect(await y.rest.get(pairingPath)).toBeDefined();
    // A claim that also moves the expiry is not a claim.
    expect(
      await commit(x, {
        update: {
          name: world.owner.fullName(pairingPath),
          fields: { joiner: str(x.uid), expiresAt: at(3_600_000) },
        },
        updateMask: { fieldPaths: ["joiner", "expiresAt"] },
      }),
    ).toBe(DENIED);
    expect(await claim(x)).toBe("ok");
    expect(await claim(y)).toBe(DENIED);
    expect(await outcome(y.rest.get(pairingPath))).toBe(DENIED);
    expect(await x.rest.get(pairingPath)).toBeDefined();
    const expired = `vaults/${V}/pairings/${"e7".repeat(16)}`;
    await world.owner.commit([set(expired, pairingDoc(a.uid, null, -60_000))]);
    expect(await claim(y, expired)).toBe(DENIED);
  });

  it("takes pairing messages only from the two parties as themselves, while open, never updated", async () => {
    const { a, x, y } = world;
    await world.owner.commit([set(pairingPath, pairingDoc(a.uid, x.uid, 600_000))]);
    expect(await commit(x, set(messagePath(0), messageDoc(x.uid, 0)))).toBe("ok");
    expect(await commit(a, set(messagePath(1), messageDoc(a.uid, 1)))).toBe("ok");
    expect(await commit(a, set(messagePath(2), messageDoc(x.uid, 2)))).toBe(DENIED);
    expect(await commit(y, set(messagePath(2), messageDoc(y.uid, 2)))).toBe(DENIED);
    expect(await commit(x, set(messagePath(3), messageDoc(x.uid, 4)))).toBe(DENIED);
    expect(await commit(x, set(messagePath(0), messageDoc(x.uid, 0)))).toBe(DENIED);
    // The box: bytes of at most 716800; part / parts ints with part < parts; no extra key.
    expect(
      await commit(
        x,
        set(messagePath(2), messageDoc(x.uid, 2, bytes(new Uint8Array(716_801).fill(1)))),
      ),
    ).toBe(DENIED);
    expect(await commit(x, set(messagePath(2), messageDoc(x.uid, 2, str("AAAA"))))).toBe(DENIED);
    expect(await commit(x, set(messagePath(2), { ...messageDoc(x.uid, 2), part: int(1) }))).toBe(
      DENIED,
    );
    expect(await commit(x, set(messagePath(2), { ...messageDoc(x.uid, 2), parts: str("1") }))).toBe(
      DENIED,
    );
    expect(await commit(x, set(messagePath(2), { ...messageDoc(x.uid, 2), note: str("x") }))).toBe(
      DENIED,
    );
    expect(
      await commit(
        x,
        set(messagePath(2), messageDoc(x.uid, 2, bytes(new Uint8Array(716_800).fill(1)))),
      ),
    ).toBe("ok");
    expect(await x.rest.get(messagePath(1))).toBeDefined();
    expect(await outcome(y.rest.get(messagePath(1)))).toBe(DENIED);
    // Deleted by the admin only.
    expect(await commit(x, del(messagePath(0)))).toBe(DENIED);
    expect(await commit(a, del(messagePath(0)))).toBe("ok");
    // After expiry the pairing takes no more messages.
    await world.owner.commit([set(pairingPath, pairingDoc(a.uid, x.uid, -60_000))]);
    expect(await commit(x, set(messagePath(3), messageDoc(x.uid, 3)))).toBe(DENIED);
  });
});
