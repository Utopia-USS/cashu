// FirestorePairingLink against the in-memory fake Firebase (no security rules: pairingLink.emulator.test.ts
// runs it under them): a full QR pairing over the relay with the device testkit, claims, expiry, a split
// box, a lost send response, cancel and ordering. Synthetic vault, devices and bytes only.
import { describe, expect, it } from "vitest";
import { PairingInviter, PairingJoiner } from "../../devices/pairing.js";
import { runInviter, runJoiner } from "../../devices/pairingLink.js";
import { createSimVault, newEid, SimDevice, sodium } from "../../testing/devices/testkit.js";
import { createFakeFirebase, MemoryAuthStore } from "../../testing/firestore-fake.js";
import { AnonymousAuth } from "./auth.js";
import { FirestorePairingLink, PairingLinkError, pairingSessionId } from "./pairingLink.js";
import { FirestoreRelayAdmin } from "./relayAdmin.js";
import { bytes, FirestoreRest, int, str, ts } from "./rest.js";

const VAULT = "0123456789abcdef0123456789abcdef";
const MAC = "ac".repeat(16);
const SID = "5e".repeat(16);
const T0 = Date.UTC(2026, 10, 14, 12, 0, 0);
const MiB = 1024 * 1024;
const PAIRING = `vaults/${VAULT}/pairings/${SID}`;
const msg = (n: number) => `${PAIRING}/messages/${String(n).padStart(4, "0")}`;

/** A deterministic synthetic payload (no randomness, no real data). */
function payload(length: number, seed = 1): Uint8Array {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) out[i] = (i * 31 + seed) & 0xff;
  return out;
}

/** "ok" or the PairingLinkError code of the call. */
async function code(call: Promise<unknown>): Promise<string> {
  try {
    await call;
    return "ok";
  } catch (error) {
    if (error instanceof PairingLinkError) {
      expect(error.message).toBe(`pairing link ${error.code}`);
      return error.code;
    }
    throw error;
  }
}

/** One fake Firebase and a shared fake clock; `sleep` advances it (and yields to the event loop). */
function rig() {
  const clock = { t: T0 };
  const fake = createFakeFirebase({ now: () => clock.t });
  const sleep = async (ms: number) => {
    clock.t += ms;
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  const user = async (retries = 0) => {
    const auth = new AnonymousAuth({
      endpoint: fake.identity,
      store: new MemoryAuthStore(),
      fetch: fake.fetch,
    });
    const uid = await auth.uid();
    const rest = new FirestoreRest({
      endpoint: fake.endpoint,
      auth,
      fetch: fake.fetch,
      retries,
      sleep: async () => {},
    });
    const link = (side: "inviter" | "joiner", sessionId = SID, receiveTimeoutMs?: number) =>
      new FirestorePairingLink({
        rest,
        uid: () => auth.uid(),
        vault: VAULT,
        sessionId,
        side,
        now: () => clock.t,
        sleep,
        ...(receiveTimeoutMs === undefined ? {} : { receiveTimeoutMs }),
      });
    return { uid, rest, link };
  };
  const docs = (prefix = PAIRING) => [...fake.documents(prefix).keys()].sort();
  return { fake, clock, sleep, user, docs };
}

/** The Mac (admin of VAULT) with an open session, and a phone that claimed it. */
async function opened(r: ReturnType<typeof rig>, ttl = 5 * 60_000) {
  const mac = await r.user();
  await new FirestoreRelayAdmin({ rest: mac.rest, now: () => r.clock.t }).createVault(VAULT, {
    uid: mac.uid,
    device: MAC,
  });
  const phone = await r.user();
  const inviter = mac.link("inviter");
  await inviter.open(r.clock.t + ttl);
  const joiner = phone.link("joiner");
  return { mac, phone, inviter, joiner };
}

describe("pairingSessionId", () => {
  it("is hex(BLAKE2b-16) of the QR's ephemeral public key", () => {
    const eph = payload(32, 7);
    // Oracle: libsodium's generichash, independent of the @noble implementation under test.
    const expected = Buffer.from(sodium.hash(16, eph)).toString("hex");
    expect(pairingSessionId({ ephemeralPublicKey: eph })).toBe(expected);
    expect(expected).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe("FirestorePairingLink (fake relay)", () => {
  it("runs a full QR pairing between the inviter and the joiner, then close leaves nothing", async () => {
    const r = rig();
    const { creator } = createSimVault();
    const created = PairingInviter.create({
      sodium,
      identity: creator.identity,
      ring: creator.ring,
      registry: creator.devices.registry,
      now: creator.now(),
    });
    if (!created.ok) throw new Error(created.reason);
    const vault = created.value.inviter.invite.vaultId;
    const sid = pairingSessionId(created.value.inviter.invite);
    const mac = await r.user();
    await new FirestoreRelayAdmin({ rest: mac.rest }).createVault(vault, {
      uid: mac.uid,
      device: creator.id,
    });
    const phoneUser = await r.user();
    const inviterLink = new FirestorePairingLink({
      rest: mac.rest,
      uid: async () => mac.uid,
      vault,
      sessionId: sid,
      side: "inviter",
      now: () => r.clock.t,
      sleep: r.sleep,
    });
    const joinerLink = new FirestorePairingLink({
      rest: phoneUser.rest,
      uid: async () => phoneUser.uid,
      vault,
      sessionId: sid,
      side: "joiner",
      now: () => r.clock.t,
      sleep: r.sleep,
    });
    await inviterLink.open(r.clock.t + 5 * 60_000);

    const phone = new SimDevice("phone", creator.remote);
    const started = PairingJoiner.start(
      { sodium, identity: phone.identity, name: "phone" },
      created.value.qr,
      phone.now(),
    );
    if (!started.ok) throw new Error(started.reason);
    await joinerLink.claim();
    let sas: string | undefined;
    let boundUid: string | undefined;
    const [inv, join] = await Promise.all([
      runInviter(created.value.inviter, inviterLink, {
        now: () => creator.now(),
        eid: newEid,
        enterCode: async () => sas,
        afterHello: async () => {
          boundUid = await inviterLink.joinerUid();
        },
      }),
      runJoiner(started.value.joiner, started.value.hello, joinerLink, {
        now: () => phone.now(),
        showSas: (shown) => {
          sas = shown;
        },
      }),
    ]);
    expect(inv.ok && join.ok).toBe(true);
    if (!inv.ok || !join.ok) return;
    expect(boundUid).toBe(phoneUser.uid);
    expect(join.value.ring.vaultId).toBe(vault);
    expect(inv.value.deviceAdded).toBeDefined();
    const prefix = `vaults/${vault}/pairings/${sid}`;
    const messages = [...r.fake.documents(`${prefix}/messages/`).entries()];
    // hello (1), challenge (0), reveal (3), welcome + pages (2, 4, ...): each side on its own parity.
    for (const [path, doc] of messages) {
      const n = Number(path.slice(-4));
      expect(doc.fields.from).toEqual(str(n % 2 === 0 ? mac.uid : phoneUser.uid));
      expect(doc.fields.n).toEqual(int(n));
      expect(Object.keys(doc.fields).sort()).toEqual(
        ["box", "createdAt", "from", "n", "part", "parts"].sort(),
      );
    }
    expect(messages.length).toBeGreaterThanOrEqual(4);
    await inviterLink.close();
    expect([...r.fake.documents(prefix).keys()]).toEqual([]);
  });

  it("writes the session document the rules expect", async () => {
    const r = rig();
    const { mac } = await opened(r, 60_000);
    expect(r.fake.documents().get(PAIRING)?.fields).toEqual({
      inviter: str(mac.uid),
      joiner: { nullValue: null },
      expiresAt: ts(new Date(T0 + 60_000).toISOString()),
      createdAt: ts(new Date(T0).toISOString()),
    });
  });

  it("lets one device claim the session: a second claimer gets taken, sequential or concurrent", async () => {
    const r = rig();
    const { inviter, joiner, phone } = await opened(r);
    await joiner.claim();
    expect(await inviter.joinerUid()).toBe(phone.uid);
    // A retried claim of the same device (its first response lost) finds itself the joiner.
    await joiner.claim();
    const other = await r.user();
    expect(await code(other.link("joiner").claim())).toBe("taken");
    expect(r.fake.documents().get(PAIRING)?.fields.joiner).toEqual(str(phone.uid));

    const r2 = rig();
    const second = await opened(r2);
    const rival = await r2.user();
    const outcomes = await Promise.all([
      code(second.joiner.claim()),
      code(rival.link("joiner").claim()),
    ]);
    expect(outcomes.sort()).toEqual(["ok", "taken"]);
    const winner = outcomes[0] === "ok" ? second.phone.uid : rival.uid;
    expect(r2.fake.documents().get(PAIRING)?.fields.joiner).toEqual(str(winner));
  });

  it("refuses an expired session: claim, send and receive end with expired", async () => {
    const r = rig();
    const { inviter, joiner } = await opened(r, 60_000);
    r.clock.t += 60_000;
    expect(await code(joiner.claim())).toBe("expired");
    expect(r.fake.documents().get(PAIRING)?.fields.joiner).toEqual({ nullValue: null });
    expect(await code(inviter.send(payload(10)))).toBe("expired");
    expect(await code(inviter.receive())).toBe("expired");
    expect(await code(inviter.open(r.clock.t))).toBe("expired");
  });

  it("ends a wait for the peer with timeout", async () => {
    const r = rig();
    const mac = await r.user();
    const phone = await r.user();
    const a = mac.link("inviter");
    await a.open(T0 + 60 * 60_000);
    const b = phone.link("joiner", SID, 30_000);
    await b.claim();
    expect(await code(b.receive())).toBe("timeout");
  });

  it("splits a 2 MiB box into parts and reassembles it, in order with the next message", async () => {
    const r = rig();
    const { inviter, joiner } = await opened(r);
    await joiner.claim();
    const big = payload(2 * MiB, 3);
    await inviter.send(big);
    await inviter.send(payload(5, 9));
    // 2 MiB = 3 parts on the inviter's numbers 0, 2, 4; the next message is 6.
    const parts = r.docs(`${PAIRING}/messages/`).map((p) => p.slice(-4));
    expect(parts).toEqual(["0000", "0002", "0004", "0006"]);
    const part1 = r.fake.documents().get(msg(2));
    expect(part1?.fields.part).toEqual(int(1));
    expect(part1?.fields.parts).toEqual(int(3));
    const received = await joiner.receive();
    expect(received.length).toBe(2 * MiB);
    expect(Buffer.compare(Buffer.from(received), Buffer.from(big))).toBe(0);
    expect(await joiner.receive()).toEqual(payload(5, 9));
    // The other direction starts at 1.
    await joiner.send(payload(4, 2));
    expect(await inviter.receive()).toEqual(payload(4, 2));
  });

  it("waits for the peer's next number even when a later one is already there", async () => {
    const r = rig();
    const { inviter, joiner, phone } = await opened(r);
    await joiner.claim();
    const raw = (n: number, box: Uint8Array) =>
      phone.rest.commit([
        {
          update: {
            name: msg(n),
            fields: {
              from: str(phone.uid),
              n: int(n),
              box: bytes(box),
              part: int(0),
              parts: int(1),
              createdAt: ts(new Date(T0).toISOString()),
            },
          },
        },
      ]);
    await raw(3, payload(3, 3));
    const first = inviter.receive();
    await r.sleep(0);
    await raw(1, payload(3, 1));
    expect(await first).toEqual(payload(3, 1));
    expect(await inviter.receive()).toEqual(payload(3, 3));
  });

  it("refuses parts out of order and a sender that is not the claimant", async () => {
    const r = rig();
    const { inviter, joiner, phone } = await opened(r);
    await joiner.claim();
    const part = (n: number, p: number, parts: number, from = phone.uid) =>
      phone.rest.commit([
        {
          update: {
            name: msg(n),
            fields: {
              from: str(from),
              n: int(n),
              box: bytes(payload(8, n)),
              part: int(p),
              parts: int(parts),
              createdAt: ts(new Date(T0).toISOString()),
            },
          },
        },
      ]);
    // Part 1 where part 0 belongs.
    await part(1, 1, 2);
    expect(await code(inviter.receive())).toBe("malformed");

    // Part 0 of 3, then part 2 where part 1 belongs.
    const r1 = rig();
    const s1 = await opened(r1);
    await s1.joiner.claim();
    for (const [n, p] of [
      [1, 0],
      [3, 2],
      [5, 1],
    ] as const) {
      await s1.phone.rest.commit([
        {
          update: {
            name: msg(n),
            fields: {
              from: str(s1.phone.uid),
              n: int(n),
              box: bytes(payload(8, n)),
              part: int(p),
              parts: int(3),
              createdAt: ts(new Date(T0).toISOString()),
            },
          },
        },
      ]);
    }
    expect(await code(s1.inviter.receive())).toBe("malformed");

    const r2 = rig();
    const s2 = await opened(r2);
    await s2.joiner.claim();
    const stranger = await r2.user();
    await s2.phone.rest.commit([
      {
        update: {
          name: msg(1),
          fields: {
            from: str(stranger.uid),
            n: int(1),
            box: bytes(payload(8)),
            part: int(0),
            parts: int(1),
            createdAt: ts(new Date(T0).toISOString()),
          },
        },
      },
    ]);
    expect(await code(s2.inviter.receive())).toBe("malformed");
  });

  it("survives a lost send response: the message lands once and the next one follows", async () => {
    const r = rig();
    const { inviter, joiner } = await opened(r);
    await joiner.claim();
    r.fake.faults.loseNextCommitResponse();
    await joiner.send(payload(100, 4));
    expect(r.docs(`${PAIRING}/messages/`).map((p) => p.slice(-4))).toEqual(["0001"]);
    await joiner.send(payload(50, 5));
    expect(await inviter.receive()).toEqual(payload(100, 4));
    expect(await inviter.receive()).toEqual(payload(50, 5));
  });

  it("cancel: the inviter's close deletes every document and ends the joiner's wait", async () => {
    const r = rig();
    const { inviter, joiner } = await opened(r);
    await joiner.claim();
    await joiner.send(payload(20, 1));
    await inviter.send(payload(20, 2));
    await joiner.send(payload(PAIRING_SPLIT, 3));
    expect(r.docs(`${PAIRING}/messages/`).length).toBe(4);
    expect(await joiner.receive()).toEqual(payload(20, 2));
    // The joiner waits for a message the inviter never sends; the inviter cancels.
    const waiting = code(joiner.receive());
    await inviter.close();
    expect(r.docs()).toEqual([]);
    expect(await waiting).toBe("closed");
    expect(await code(inviter.receive())).toBe("closed");
    expect(await code(inviter.send(payload(1)))).toBe("closed");
    expect(r.docs()).toEqual([]);
  });

  it("an aborted receive makes no further relay request and consumes no message", async () => {
    const r = rig();
    const { inviter, joiner } = await opened(r);
    await joiner.claim();
    const requests = () => Object.values(r.fake.counters).reduce((sum, n) => sum + n, 0);
    const watch = new AbortController();
    const waiting = code(inviter.receive({ signal: watch.signal }));
    // The wait polls the relay (message reads, and the session every few empty polls).
    const polling = requests();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(requests()).toBeGreaterThan(polling + 4);
    watch.abort();
    const settled = new Promise<string>((resolve) => setTimeout(() => resolve("waiting"), 1_000));
    expect(await Promise.race([waiting, settled])).toBe("closed");
    const after = requests();
    // Real time passes (each poll would also move the fake clock): not one request more.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(requests()).toBe(after);
    // The link stays open: the joiner's next message is still the inviter's next one.
    await joiner.send(payload(20, 9));
    expect(await inviter.receive()).toEqual(payload(20, 9));
    // A receive given an already aborted signal makes no request at all.
    const before = requests();
    expect(await code(inviter.receive({ signal: watch.signal }))).toBe("closed");
    expect(requests()).toBe(before);
  });

  it("a joiner's close stops it locally and deletes nothing", async () => {
    const r = rig();
    const { joiner } = await opened(r);
    await joiner.claim();
    await joiner.close();
    expect(await code(joiner.send(payload(1)))).toBe("closed");
    expect(r.docs()).toEqual([PAIRING]);
  });
});

/** A box just over one part (two message documents). */
const PAIRING_SPLIT = 716_801;
