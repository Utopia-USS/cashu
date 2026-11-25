// FirestoreRelayAdmin against the in-memory fake Firebase (no security rules: the emulator suite
// rules.emulator.test.ts runs the same helper under them): the documents each call writes, the outcomes
// read back after a refusal or a lost response, retries of an interrupted recovery, id validation.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createFakeFirebase, MemoryAuthStore } from "../../testing/firestore-fake.js";
import { AnonymousAuth } from "./auth.js";
import { FirestoreRelayAdmin, relayRecoveryHash } from "./relayAdmin.js";
import { bytes, type FetchLike, type FetchResponse, FirestoreRest, int, str } from "./rest.js";

// Synthetic ids and bytes.
const VAULT = "0123456789abcdef0123456789abcdef";
const MAC = "ac".repeat(16);
const PHONE = "bd".repeat(16);
const HASH_1 = new Uint8Array(32).fill(1);
const HASH_2 = new Uint8Array(32).fill(2);
const PROOF = new Uint8Array(32).fill(9);
const AT = Date.UTC(2026, 10, 14, 12, 0, 0);

function denied(): FetchResponse {
  const text = JSON.stringify({ error: { code: 403, status: "PERMISSION_DENIED", message: "x" } });
  return { status: 403, text: async () => text, json: async () => JSON.parse(text) as unknown };
}

/** One fake Firebase; `refuse` (a request body substring) makes matching commits answer 403. */
function rig() {
  const fake = createFakeFirebase();
  const control = { refuse: undefined as string | undefined, commits: 0, bodies: [] as string[] };
  const fetch: FetchLike = async (url, init) => {
    if (url.endsWith(":commit")) {
      control.commits++;
      control.bodies.push(init.body ?? "");
      if (control.refuse && (init.body ?? "").includes(control.refuse)) return denied();
    }
    return fake.fetch(url, init);
  };
  const user = async () => {
    const auth = new AnonymousAuth({
      endpoint: fake.identity,
      store: new MemoryAuthStore(),
      fetch: fake.fetch,
    });
    const rest = new FirestoreRest({ endpoint: fake.endpoint, auth, fetch, retries: 0 });
    return {
      uid: await auth.uid(),
      rest,
      admin: new FirestoreRelayAdmin({ rest, now: () => AT }),
    };
  };
  const doc = (path: string) => fake.documents().get(path);
  return { fake, control, user, doc };
}

describe("FirestoreRelayAdmin", () => {
  it("creates the vault doc and its first admin in one commit, with the recovery hash", async () => {
    const r = await rig();
    const mac = await r.user();
    expect(
      await mac.admin.createVault(VAULT, { uid: mac.uid, device: MAC, recoveryHash: HASH_1 }),
    ).toBe("created");
    expect(r.fake.counters.commit).toBe(1);
    const vault = r.doc(`vaults/${VAULT}`);
    expect(vault?.fields).toEqual({
      createdAt: { timestampValue: new Date(AT).toISOString() },
      admins: { arrayValue: { values: [str(mac.uid)] } },
      recoveryHash: bytes(HASH_1),
    });
    expect(r.doc(`vaults/${VAULT}/members/${mac.uid}`)?.fields).toEqual({
      device: str(MAC),
      role: str("admin"),
      addedAt: { timestampValue: new Date(AT).toISOString() },
    });
  });

  it("writes no recovery hash when none is given (the transitional creation)", async () => {
    const r = await rig();
    const mac = await r.user();
    expect(await mac.admin.createVault(VAULT, { uid: mac.uid, device: MAC })).toBe("created");
    expect(Object.keys(r.doc(`vaults/${VAULT}`)?.fields ?? {}).sort()).toEqual([
      "admins",
      "createdAt",
    ]);
  });

  it("answers already-admin on a retry after a lost response, and taken for another uid", async () => {
    const r = await rig();
    const mac = await r.user();
    r.fake.faults.loseNextCommitResponse();
    await expect(mac.admin.createVault(VAULT, { uid: mac.uid, device: MAC })).rejects.toMatchObject(
      {
        code: "unavailable",
      },
    );
    expect(await mac.admin.createVault(VAULT, { uid: mac.uid, device: MAC })).toBe("already-admin");
    const other = await r.user();
    expect(await other.admin.createVault(VAULT, { uid: other.uid, device: PHONE })).toBe("taken");
    // The same uid bound to another device is not this device's admin either.
    expect(await mac.admin.createVault(VAULT, { uid: mac.uid, device: PHONE })).toBe("taken");
    expect(r.doc(`vaults/${VAULT}/members/${other.uid}`)).toBeUndefined();
  });

  it("adds, lists and removes members; removing also drops a recovery proof", async () => {
    const r = await rig();
    const mac = await r.user();
    const phone = await r.user();
    await mac.admin.createVault(VAULT, { uid: mac.uid, device: MAC });
    await mac.admin.addMember(VAULT, { uid: phone.uid, device: PHONE });
    expect(
      (await mac.admin.listMembers(VAULT)).sort((a, b) => a.device.localeCompare(b.device)),
    ).toEqual([
      { uid: mac.uid, device: MAC, role: "admin" },
      { uid: phone.uid, device: PHONE, role: "member" },
    ]);
    const recovery = `vaults/${VAULT}/recoveries/${phone.uid}`;
    await mac.rest.commit([{ update: { name: recovery, fields: { proof: bytes(PROOF) } } }]);
    expect(r.doc(recovery)).toBeDefined();
    await mac.admin.removeMember(VAULT, phone.uid);
    expect(r.doc(`vaults/${VAULT}/members/${phone.uid}`)).toBeUndefined();
    expect(r.doc(recovery)).toBeUndefined();
    expect(await mac.admin.listMembers(VAULT)).toEqual([
      { uid: mac.uid, device: MAC, role: "admin" },
    ]);
  });

  it("skips malformed member documents when listing", async () => {
    const r = await rig();
    const mac = await r.user();
    await mac.admin.createVault(VAULT, { uid: mac.uid, device: MAC });
    await mac.admin.addMember(VAULT, { uid: "bad-role", device: PHONE });
    await mac.rest.commit([
      {
        update: { name: `vaults/${VAULT}/members/bad-role`, fields: { role: int(1) } },
        updateMask: { fieldPaths: ["role"] },
      },
    ]);
    expect(await mac.admin.listMembers(VAULT)).toEqual([
      { uid: mac.uid, device: MAC, role: "admin" },
    ]);
  });

  it("recovers the admin under a new uid, rotates the hash and deletes the proof", async () => {
    const r = await rig();
    const lost = await r.user();
    await lost.admin.createVault(VAULT, { uid: lost.uid, device: MAC, recoveryHash: HASH_1 });
    const mac = await r.user();
    const commits = r.control.commits;
    expect(
      await mac.admin.recoverAdmin(VAULT, {
        uid: mac.uid,
        device: MAC,
        proof: PROOF,
        nextRecoveryHash: HASH_2,
      }),
    ).toBe("recovered");
    // Proof + member doc + rotation in ONE commit (the rules require it), then the proof delete.
    expect(r.control.commits - commits).toBe(2);
    const [recovery, cleanup] = r.control.bodies
      .slice(-2)
      .map((b) => JSON.parse(b) as { writes: { update?: { name: string }; delete?: string }[] });
    expect(recovery?.writes.map((w) => w.update?.name.split("/").slice(-2).join("/"))).toEqual([
      `recoveries/${mac.uid}`,
      `members/${mac.uid}`,
      `vaults/${VAULT}`,
    ]);
    expect(cleanup?.writes.map((w) => w.delete?.split("/").slice(-2).join("/"))).toEqual([
      `recoveries/${mac.uid}`,
    ]);
    expect(r.doc(`vaults/${VAULT}/members/${mac.uid}`)?.fields.role).toEqual(str("admin"));
    expect(r.doc(`vaults/${VAULT}/recoveries/${mac.uid}`)).toBeUndefined();
    const vault = r.doc(`vaults/${VAULT}`);
    expect(vault?.fields.recoveryHash).toEqual(bytes(HASH_2));
    // createdAt and admins untouched (the rules allow only recoveryHash and admins to change).
    expect(vault?.fields.admins).toEqual({ arrayValue: { values: [str(lost.uid)] } });
    expect(vault?.fields.createdAt).toEqual({ timestampValue: new Date(AT).toISOString() });
  });

  it("finishes an interrupted recovery on retry (already admin: re-writes the hash, drops the proof)", async () => {
    const r = await rig();
    const lost = await r.user();
    await lost.admin.createVault(VAULT, { uid: lost.uid, device: MAC, recoveryHash: HASH_1 });
    const mac = await r.user();
    // The proof delete fails: the recovery commit landed (admin, hash rotated), the proof doc is left.
    r.control.refuse = '"delete"';
    await expect(
      mac.admin.recoverAdmin(VAULT, {
        uid: mac.uid,
        device: MAC,
        proof: PROOF,
        nextRecoveryHash: HASH_2,
      }),
    ).rejects.toMatchObject({ code: "permission-denied" });
    expect(r.doc(`vaults/${VAULT}/recoveries/${mac.uid}`)).toBeDefined();
    expect(r.doc(`vaults/${VAULT}`)?.fields.recoveryHash).toEqual(bytes(HASH_2));
    expect(r.doc(`vaults/${VAULT}/members/${mac.uid}`)?.fields.role).toEqual(str("admin"));
    r.control.refuse = undefined;
    expect(
      await mac.admin.recoverAdmin(VAULT, {
        uid: mac.uid,
        device: MAC,
        proof: PROOF,
        nextRecoveryHash: HASH_2,
      }),
    ).toBe("already-admin");
    expect(r.doc(`vaults/${VAULT}/recoveries/${mac.uid}`)).toBeUndefined();
    expect(r.doc(`vaults/${VAULT}`)?.fields.recoveryHash).toEqual(bytes(HASH_2));
  });

  it("reads a lost response of the recovery commit back as recovered", async () => {
    const r = await rig();
    const lost = await r.user();
    await lost.admin.createVault(VAULT, { uid: lost.uid, device: MAC, recoveryHash: HASH_1 });
    const mac = await r.user();
    r.fake.faults.loseNextCommitResponse();
    await expect(
      mac.admin.recoverAdmin(VAULT, {
        uid: mac.uid,
        device: MAC,
        proof: PROOF,
        nextRecoveryHash: HASH_2,
      }),
    ).rejects.toMatchObject({ code: "unavailable" });
    expect(
      await mac.admin.recoverAdmin(VAULT, {
        uid: mac.uid,
        device: MAC,
        proof: PROOF,
        nextRecoveryHash: HASH_2,
      }),
    ).toBe("already-admin");
    expect(r.doc(`vaults/${VAULT}/recoveries/${mac.uid}`)).toBeUndefined();
    expect(r.doc(`vaults/${VAULT}`)?.fields.recoveryHash).toEqual(bytes(HASH_2));
  });

  it("replaces a demoted member doc of the recovering uid in the same commit", async () => {
    const r = await rig();
    const lost = await r.user();
    await lost.admin.createVault(VAULT, { uid: lost.uid, device: MAC, recoveryHash: HASH_1 });
    const mac = await r.user();
    // The uid is a plain member bound to another device (demoted, or a stale grant).
    await lost.admin.addMember(VAULT, { uid: mac.uid, device: PHONE });
    expect(
      await mac.admin.recoverAdmin(VAULT, {
        uid: mac.uid,
        device: MAC,
        proof: PROOF,
        nextRecoveryHash: HASH_2,
      }),
    ).toBe("recovered");
    const member = r.doc(`vaults/${VAULT}/members/${mac.uid}`);
    expect(member?.fields.role).toEqual(str("admin"));
    expect(member?.fields.device).toEqual(str(MAC));
  });

  it("answers refused when the proof commit is refused and this uid is no admin", async () => {
    const r = await rig();
    const lost = await r.user();
    await lost.admin.createVault(VAULT, { uid: lost.uid, device: MAC, recoveryHash: HASH_1 });
    const mac = await r.user();
    r.control.refuse = "/recoveries/";
    expect(
      await mac.admin.recoverAdmin(VAULT, {
        uid: mac.uid,
        device: MAC,
        proof: PROOF,
        nextRecoveryHash: HASH_2,
      }),
    ).toBe("refused");
    expect(r.doc(`vaults/${VAULT}`)?.fields.recoveryHash).toEqual(bytes(HASH_1));
    expect(r.doc(`vaults/${VAULT}/members/${mac.uid}`)).toBeUndefined();
  });

  it("validates ids and lengths before any request", async () => {
    const r = await rig();
    const mac = await r.user();
    const before = r.control.commits;
    await expect(
      mac.admin.createVault("not-a-vault", { uid: mac.uid, device: MAC }),
    ).rejects.toThrow("firestore_invalid_id");
    await expect(mac.admin.createVault(VAULT, { uid: "a/b", device: MAC })).rejects.toThrow(
      "firestore_invalid_id",
    );
    await expect(mac.admin.addMember(VAULT, { uid: mac.uid, device: "XY" })).rejects.toThrow(
      "firestore_invalid_id",
    );
    await expect(
      mac.admin.createVault(VAULT, { uid: mac.uid, device: MAC, recoveryHash: new Uint8Array(31) }),
    ).rejects.toThrow(RangeError);
    await expect(
      mac.admin.recoverAdmin(VAULT, {
        uid: mac.uid,
        device: MAC,
        proof: new Uint8Array(15),
        nextRecoveryHash: HASH_2,
      }),
    ).rejects.toThrow(RangeError);
    expect(r.control.commits).toBe(before);
    expect(r.fake.counters.get).toBe(0);
  });

  it("hashes a recovery secret with sha256", () => {
    const secret = new Uint8Array(32).map((_, i) => i);
    const expected = createHash("sha256").update(secret).digest();
    expect(Buffer.from(relayRecoveryHash(secret)).equals(expected)).toBe(true);
    expect(() => relayRecoveryHash(new Uint8Array(8))).toThrow(RangeError);
  });
});
