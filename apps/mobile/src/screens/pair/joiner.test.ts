// The phone's pairing against the fake relay and a Node Mac (the real protocol, `FirestorePairingLink`
// on both sides): nothing durable before the phone read its own member document (the commit point),
// a cancel on every step before storing leaves nothing behind, and the QR checks and relay failures map
// to the flow's states. Synthetic vault, devices and names only.
import { betterSqlite3Driver, type SqlDriver } from "@cashu/store";
import type { PairedVault } from "@cashu/store/device";
import {
  crypto,
  FirestorePairingLink,
  FirestoreRelayAdmin,
  pairingSessionId,
  devices as syncDevices,
} from "@cashu/sync";
import { createFakeFirebase, type FakeFirebase } from "@cashu/sync/testing/firestore";
import Database from "better-sqlite3";
import { memoryKeyStore, runtime } from "../../selftest/testing/runtime";
import { createVaultQueue } from "../../services/commandQueue";
import { readVaultBootstrap, storeJoinedInQueue } from "../../services/vaultBootstrap";
import { type PairingPorts, PhonePairing } from "./joiner";
import { initialPairState, type PairEvent, type PairState, pairReducer } from "./pairState";
import { createTestMac, openInvite, relayUser, type TestMac } from "./testing/mac";

let sodium: crypto.Sodium;
beforeAll(async () => {
  sodium = crypto.fromLibsodium(await runtime(), { aead: "noble" });
});

const NAME = "iPhone 16 Pro";
const quick = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, Math.min(ms, 5)));

/** Every table of a log database (none: nothing was written). */
function tables(log: SqlDriver): string[] {
  return log
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all<{ name: string }>()
    .map((row) => row.name);
}

/** The phone: its relay identity, KeyStore and log file, with every durable write recorded. */
async function createPhone(fake: FakeFirebase, over: Partial<PairingPorts> = {}) {
  const user = await relayUser(fake);
  const inner = memoryKeyStore(sodium);
  const sets: string[] = [];
  const keyStore: crypto.KeyStore = {
    get: (name) => inner.get(name),
    set: async (name, value) => {
      sets.push(name);
      await inner.set(name, value);
    },
    delete: (name) => inner.delete(name),
  } as crypto.KeyStore;
  const log = betterSqlite3Driver(new Database(":memory:"));
  const added: PairedVault[] = [];
  const events: PairEvent[] = [];
  let state: PairState = initialPairState(NAME);
  const ports: PairingPorts = {
    sodium,
    relay: { projectId: "demo-cashu", rest: user.rest, uid: () => user.auth.uid() },
    now: () => Date.now(),
    sleep: quick,
    pollMs: 5,
    memberWaitMs: 1500,
    held: () => undefined,
    pushHeld: async () => true,
    store: (joined, options) =>
      storeJoinedInQueue(
        { queue: createVaultQueue(), session: undefined, keyStore, driver: log, now: Date.now },
        joined,
        options,
      ),
    add: async (entry) => {
      added.push(entry);
    },
    placeholderName: "Nowy profil",
    ...over,
  };
  /** Durable state the phone holds now: KeyStore writes, log tables, list entries. */
  const durable = () => ({ keys: [...sets], tables: tables(log), added: [...added] });
  return {
    uid: user.uid,
    keyStore,
    log,
    added,
    events,
    state: () => state,
    durable,
    pairing(onEvent: (event: PairEvent, pairing: PhonePairing) => void = () => {}) {
      const pairing: PhonePairing = new PhonePairing(ports, (event) => {
        events.push(event);
        state = pairReducer(state, event);
        onEvent(event, pairing);
      });
      return pairing;
    },
  };
}

const NOTHING = { keys: [], tables: [], added: [] };

describe("a pairing with the Mac over the relay", () => {
  let fake: FakeFirebase;
  let mac: TestMac;
  beforeEach(async () => {
    fake = createFakeFirebase();
    mac = await createTestMac(fake, sodium);
  });

  it("stores nothing until the phone read its member document, then the vault and its entry", async () => {
    const phone = await createPhone(fake);
    let beforeAdmit: ReturnType<typeof phone.durable> | undefined;
    let polled = 0;
    const invite = await openInvite(mac, sodium, {
      beforeAdmit: async () => {
        // The welcome left and the phone is waiting for its membership: give it several polls.
        const at = fake.counters.get;
        while (fake.counters.get < at + 4) await new Promise((r) => setTimeout(r, 5));
        polled = fake.counters.get - at;
        beforeAdmit = phone.durable();
        return true;
      },
    });
    const pairing = phone.pairing((event) => {
      if (event.type === "sas") invite.typeCode(event.sas);
    });
    const [macSide] = await Promise.all([
      invite.run(),
      pairing.start(invite.qr, NAME, { discardUnpushed: false }),
    ]);

    expect(macSide).toEqual({ ok: true, admitted: true });
    expect(polled).toBeGreaterThanOrEqual(4);
    expect(beforeAdmit).toEqual(NOTHING);
    const types = phone.events.map((e) => e.type);
    expect(types.slice(0, 2)).toEqual(["connecting", "sas"]);
    expect(types).toContain("part");
    expect(types.slice(-2)).toEqual(["storing", "stored"]);
    expect(phone.state()).toEqual({ kind: "role", vault: mac.vault, role: "owner" });
    // The six digits are the same on both sides only through the protocol; the code shown is six digits.
    const sas = phone.events.find((e) => e.type === "sas");
    expect(sas?.type === "sas" && /^\d{6}$/.test(sas.sas)).toBe(true);

    // Stored: identity + keyring in the KeyStore, the log with this device's bootstrap, one entry.
    const [entry] = phone.added;
    expect(phone.added).toHaveLength(1);
    expect(entry).toMatchObject({ vaultId: mac.vault, role: "owner", name: "Nowy profil" });
    expect(phone.durable().keys.sort()).toEqual(
      [crypto.keyringName(mac.vault), crypto.deviceIdentityName(entry?.deviceId as string)].sort(),
    );
    const ring = await crypto.loadKeyring(phone.keyStore, sodium, mac.vault);
    expect(ring?.vaultId).toBe(mac.vault);
    const bootstrap = readVaultBootstrap(phone.log);
    expect(bootstrap).toMatchObject({ vault: mac.vault, device: entry?.deviceId, kind: "paired" });
    // The Mac's registry names the phone under the name it offered.
    const members = await fake.documents(`vaults/${mac.vault}/members/`);
    expect([...members.keys()]).toContain(`vaults/${mac.vault}/members/${phone.uid}`);
  });

  it("keeps nothing when the Mac never admits the phone", async () => {
    const phone = await createPhone(fake);
    const invite = await openInvite(mac, sodium, { beforeAdmit: async () => false });
    const pairing = phone.pairing((event) => {
      if (event.type === "sas") invite.typeCode(event.sas);
    });
    await Promise.all([invite.run(), pairing.start(invite.qr, NAME, { discardUnpushed: false })]);
    expect(phone.state()).toEqual({ kind: "failed", name: NAME, reason: "failed" });
    expect(phone.durable()).toEqual(NOTHING);
    await invite.link.close();
  });

  it.each(["connecting", "sas", "part"] as const)(
    "a cancel at %s leaves nothing behind on the phone",
    async (at) => {
      const phone = await createPhone(fake);
      const invite = await openInvite(mac, sodium);
      const mac$ = invite.run().catch(() => ({ ok: false, admitted: false }));
      const pairing = phone.pairing((event, self) => {
        if (event.type === "sas" && at !== "sas") invite.typeCode(event.sas);
        if (event.type === at) self.cancel();
      });
      await pairing.start(invite.qr, NAME, { discardUnpushed: false });
      // Let the in-flight polls and the Mac's side settle a little.
      await new Promise((r) => setTimeout(r, 50));
      expect(phone.state()).toEqual({ kind: "closed" });
      expect(phone.events.map((e) => e.type)).not.toContain("failed");
      expect(phone.durable()).toEqual(NOTHING);
      await invite.link.close();
      await mac$;
    },
  );
});

/** Wait (bounded) until `ready` holds; false when it never did. */
async function until(ready: () => boolean | Promise<boolean>, ms = 3000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (!(await ready())) {
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, 5));
  }
  return true;
}

describe("a re-pairing, a cancel the Mac hears and a wipe mid-pairing", () => {
  let fake: FakeFirebase;
  let mac: TestMac;
  beforeEach(async () => {
    fake = createFakeFirebase();
    mac = await createTestMac(fake, sodium);
  });

  it("re-pairs over the previous pairing's member document until it names the new device", async () => {
    const phone = await createPhone(fake);
    // The same relay identity paired this vault before: its member document names an older device id.
    const previous = crypto.createDeviceIdentity(sodium).deviceId;
    await new FirestoreRelayAdmin({ rest: mac.rest }).addMember(mac.vault, {
      uid: phone.uid,
      device: previous,
    });
    let polledOld = false;
    const invite = await openInvite(mac, sodium, {
      // The phone reads the old document several times before the Mac overwrites it.
      beforeAdmit: async () => {
        const at = fake.counters.get;
        polledOld = await until(() => fake.counters.get >= at + 4);
        return true;
      },
    });
    const pairing = phone.pairing((event) => {
      if (event.type === "sas") invite.typeCode(event.sas);
    });
    const [macSide] = await Promise.all([
      invite.run(),
      pairing.start(invite.qr, NAME, { discardUnpushed: false }),
    ]);
    expect(polledOld).toBe(true);
    expect(macSide).toEqual({ ok: true, admitted: true });
    expect(phone.state()).toEqual({ kind: "role", vault: mac.vault, role: "owner" });
    const [entry] = phone.added;
    expect(entry?.deviceId).not.toBe(previous);
    const members = await new FirestoreRelayAdmin({ rest: mac.rest }).listMembers(mac.vault);
    expect(members.find((m) => m.uid === phone.uid)?.device).toBe(entry?.deviceId);
  });

  it("tells the Mac when the phone cancels before the six digits, so the Mac ends at once", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    // The Mac does not read the session until the phone has cancelled.
    const invite = await openInvite(mac, sodium, {
      sleep: async (ms) => {
        await gate;
        await quick(ms);
      },
    });
    const invitation = syncDevices.decodeInvite(invite.qr);
    if (invitation === undefined) throw new Error("no invite");
    const messages = `vaults/${mac.vault}/pairings/${pairingSessionId(invitation)}/messages/`;
    const phone = await createPhone(fake);
    const mac$ = invite.run();
    const pairing = phone.pairing();
    const start$ = pairing.start(invite.qr, NAME, { discardUnpushed: false });
    // The hello left: the phone waits for the challenge, no digits yet.
    expect(await until(async () => (await fake.documents(messages)).size >= 1)).toBe(true);
    pairing.cancel();
    await start$;
    expect(await until(async () => (await fake.documents(messages)).size >= 2)).toBe(true);
    release();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ended = await Promise.race([
      mac$,
      new Promise<"waiting">((resolve) => {
        timer = setTimeout(() => resolve("waiting"), 5000);
      }),
    ]);
    clearTimeout(timer);
    expect(ended).toEqual({ ok: false, admitted: false });
    expect(phone.state()).toEqual({ kind: "closed" });
    expect(phone.durable()).toEqual(NOTHING);
    await invite.link.close();
  });

  it("says this phone used the code already when it pastes a code it used", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    // The Mac does not read the session until the phone has used the code twice.
    const invite = await openInvite(mac, sodium, {
      sleep: async (ms) => {
        await gate;
        await quick(ms);
      },
    });
    const invitation = syncDevices.decodeInvite(invite.qr);
    if (invitation === undefined) throw new Error("no invite");
    const messages = `vaults/${mac.vault}/pairings/${pairingSessionId(invitation)}/messages/`;
    const phone = await createPhone(fake);
    const mac$ = invite.run();
    // First use: the hello leaves, then the phone closes the step (QA: the X on the six digits).
    const first = phone.pairing();
    const first$ = first.start(invite.qr, NAME, { discardUnpushed: false });
    expect(await until(async () => (await fake.documents(messages)).size >= 1)).toBe(true);
    first.cancel();
    await first$;
    expect(await until(async () => (await fake.documents(messages)).size >= 2)).toBe(true);
    // The same code again, same phone (same relay identity).
    const failures: PairEvent[] = [];
    await phone
      .pairing((event) => {
        if (event.type === "failed") failures.push(event);
      })
      .start(invite.qr, NAME, { discardUnpushed: false });
    // QA run 3: it said "Another device already used this code".
    expect(failures).toEqual([{ type: "failed", reason: "taken_here" }]);
    expect(phone.durable()).toEqual(NOTHING);
    release();
    await mac$;
    await invite.link.close();
  });

  it("stores nothing more once the phone is wiped, even after the Mac admitted it", async () => {
    const phone = await createPhone(fake);
    const invite = await openInvite(mac, sodium);
    const pairing = phone.pairing((event, self) => {
      if (event.type === "sas") invite.typeCode(event.sas);
      if (event.type === "storing") self.discard();
    });
    const [macSide] = await Promise.all([
      invite.run(),
      pairing.start(invite.qr, NAME, { discardUnpushed: false }),
    ]);
    expect(macSide).toEqual({ ok: true, admitted: true });
    expect(phone.durable()).toEqual(NOTHING);
  });
});

describe("the checks before anything leaves the phone", () => {
  let fake: FakeFirebase;
  let mac: TestMac;
  beforeEach(async () => {
    fake = createFakeFirebase();
    mac = await createTestMac(fake, sodium);
  });

  it("says when a scan is not a cashU code and stays on the scan", async () => {
    const phone = await createPhone(fake);
    const before = { ...fake.counters };
    await phone.pairing().start("https://example.com/not-a-code", NAME, { discardUnpushed: false });
    expect(phone.state()).toMatchObject({ kind: "scan", notACode: true });
    expect(fake.counters).toEqual(before);
  });

  it("refuses a code of another sync project, an expired code and a build without sync", async () => {
    const other = await openInvite(mac, sodium, { rendezvous: "fb1:another-project" });
    const a = await createPhone(fake);
    await a.pairing().start(other.qr, NAME, { discardUnpushed: false });
    expect(a.state()).toMatchObject({ kind: "failed", reason: "other_project" });

    const expired = await openInvite(mac, sodium, { ttlMs: 1 });
    await new Promise((r) => setTimeout(r, 10));
    const b = await createPhone(fake);
    await b.pairing().start(expired.qr, NAME, { discardUnpushed: false });
    expect(b.state()).toMatchObject({ kind: "failed", reason: "expired" });

    const fine = await openInvite(mac, sodium);
    const c = await createPhone(fake, { relay: undefined });
    await c.pairing().start(fine.qr, NAME, { discardUnpushed: false });
    expect(c.state()).toMatchObject({ kind: "failed", reason: "no_sync" });
    for (const p of [a, b, c]) expect(p.durable()).toEqual(NOTHING);
    for (const i of [other, expired, fine]) await i.link.close();
  });

  it("says when another device claimed the code first", async () => {
    const invite = await openInvite(mac, sodium);
    const first = await relayUser(fake);
    const invitation = syncDevices.decodeInvite(invite.qr);
    if (invitation === undefined) throw new Error("no invite");
    await new FirestorePairingLink({
      rest: first.rest,
      uid: async () => first.uid,
      vault: mac.vault,
      sessionId: pairingSessionId(invitation),
      side: "joiner",
    }).claim();
    const phone = await createPhone(fake);
    await phone.pairing().start(invite.qr, NAME, { discardUnpushed: false });
    expect(phone.state()).toMatchObject({ kind: "failed", reason: "taken" });
    expect(phone.durable()).toEqual(NOTHING);
    await invite.link.close();
  });

  it("says when sync cannot be reached", async () => {
    const invite = await openInvite(mac, sodium);
    const phone = await createPhone(fake);
    fake.faults.unavailable(1000);
    await phone.pairing().start(invite.qr, NAME, { discardUnpushed: false });
    fake.faults.reset();
    expect(phone.state()).toMatchObject({ kind: "failed", reason: "offline" });
    expect(phone.durable()).toEqual(NOTHING);
    await invite.link.close();
  });

  it("asks before replacing a held copy whose changes never reached the Mac", async () => {
    const invite = await openInvite(mac, sodium);
    const pushes: string[] = [];
    const phone = await createPhone(fake, {
      held: (vault) => (vault === mac.vault ? { name: "Ala", unpushed: true } : undefined),
      pushHeld: async (vault) => {
        pushes.push(vault);
        return true;
      },
    });
    const before = { ...fake.counters };
    await phone.pairing().start(invite.qr, NAME, { discardUnpushed: false });
    expect(pushes).toEqual([mac.vault]);
    expect(phone.state()).toEqual({ kind: "discard", name: NAME, profile: "Ala", qr: invite.qr });
    // Nothing reached the relay: no claim, no read.
    expect(fake.counters).toEqual(before);

    // The owner's yes: the pairing goes on (cancelled here once it connects).
    const pairing = phone.pairing((event, self) => {
      if (event.type === "connecting") self.cancel();
    });
    await pairing.start(invite.qr, NAME, { discardUnpushed: true });
    expect(phone.events.map((e) => e.type)).toEqual(["discardAsked", "connecting", "cancel"]);
    await invite.link.close();
  });

  it("goes on without asking once a push delivered the held changes", async () => {
    const invite = await openInvite(mac, sodium);
    const phone = await createPhone(fake, {
      held: () => ({ name: "Ala", unpushed: true }),
      pushHeld: async () => false,
    });
    const pairing = phone.pairing((event, self) => {
      if (event.type === "connecting") self.cancel();
    });
    await pairing.start(invite.qr, NAME, { discardUnpushed: false });
    expect(phone.events.map((e) => e.type)).toEqual(["connecting", "cancel"]);
    await invite.link.close();
  });
});
