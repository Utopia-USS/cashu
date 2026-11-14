// The phone's vault engine on Node (better-sqlite3 for expo-sqlite, libsodium-wrappers for the native
// library, the memory KeyStore, the fake Firebase for the relay): the demo's on-phone creation and its
// reopen, a command through the durable boundary landing as an own frame in `log_segments`, and two
// devices converging over the relay: a Mac-like device (memory local log) and the phone (the SQLite
// own log) paired through the real protocol. Synthetic data only.
import {
  betterSqlite3Driver,
  builtinModules,
  createProfile,
  prepareCommand,
  renameProfile,
  runCommand,
  Store,
  storeWriter,
  toUnstampedEvent,
  vaultSalt,
} from "@cashu/store";
import { HybridClock } from "@cashu/store/runtime";
import {
  initializeMetaClockGuard,
  loadDeviceAuthority,
  metaClockGuardStore,
  metaClockStore,
  metaGateStateStore,
  mintUlid,
  type SqlDriver,
  SqlProvenanceStore,
} from "@cashu/store/sync";
import {
  AnonymousAuth,
  createOwnLogCodec,
  createSyncEngine,
  crypto,
  devices,
  FirestoreRest,
  FirestoreTransport,
  START_CURSOR,
  type SyncEngine,
  type Transport,
  TransportError,
} from "@cashu/sync";
import {
  createFakeFirebase,
  type FakeFirebase,
  MemoryAuthStore,
  MemoryTransport,
} from "@cashu/sync/testing/firestore";
import Database from "better-sqlite3";
import { memoryKeyStore, runtime } from "../selftest/testing/runtime";
import { createVaultQueue } from "./commandQueue";
import { readVaultBootstrap, storeJoinedVault } from "./vaultBootstrap";
import { createVaultSession, type VaultEngineDeps, type VaultSession } from "./vaultEngine";

const DEMO_VAULT = "ca000000000000000000000000000a11";
const DEMO_DEVICE = "d2000000000000000000000000000041";
const yieldToUi = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** Signature verifies (every frame head, certificate, statement) while `fn` runs, through the port. */
async function verifiesDuring<T>(fn: () => Promise<T>): Promise<{ value: T; verifies: number }> {
  let verifies = 0;
  const previous = crypto.bindEd25519Verifier({
    kind: "noble",
    verify: (signature, message, publicKey) => {
      verifies += 1;
      return crypto.nobleEd25519Verifier.verify(signature, message, publicKey);
    },
  });
  try {
    return { value: await fn(), verifies };
  } finally {
    crypto.bindEd25519Verifier(previous);
  }
}

const checkpointRow = (log: SqlDriver, device: string) =>
  log
    .prepare("SELECT value FROM sync_recovery_checkpoint WHERE device = ?")
    .get<{ value: string }>(device)?.value;

let sodium: crypto.Sodium;
beforeAll(async () => {
  sodium = crypto.fromLibsodium(await runtime(), { aead: "noble" });
});

function memoryDriver(): SqlDriver {
  return betterSqlite3Driver(new Database(":memory:"));
}

function viewStore(vault: string, salt: Uint8Array, driver = memoryDriver()): Store {
  return Store.open({ driver, vault, salt: vaultSalt(salt), modules: builtinModules() });
}

function gidSaltOf(ring: crypto.Keyring): Uint8Array {
  const salt = ring.gidSalt();
  try {
    return salt.expose().slice();
  } finally {
    salt.wipe();
  }
}

function profileName(store: Store): string | undefined {
  return store.read<{ name: string }>("SELECT name FROM profiles")[0]?.name;
}

function ownSegments(log: SqlDriver, device: string): number {
  return log
    .prepare("SELECT COUNT(*) AS n FROM log_segments WHERE device = ? AND size > 0")
    .get<{ n: number }>(device)?.n as number;
}

/** A demo view built like the fixture: the guard on the empty view, then a profile by `storeWriter`. */
function demoView(driver = memoryDriver(), vault = DEMO_VAULT): Store {
  const store = viewStore(
    vault,
    Uint8Array.from({ length: 32 }, (_, i) => i),
    driver,
  );
  if (store.read("SELECT 1 FROM profiles").length === 0) {
    initializeMetaClockGuard(store.driver, DEMO_DEVICE);
    let wall = 1_790_000_000_000;
    const clock = { now: () => (wall += 1000) };
    const created = runCommand(
      store,
      storeWriter(store),
      createProfile,
      { slug: "demo-anna", name: "Anna", baseCurrency: "PLN", modules: ["budget"] },
      {
        device: DEMO_DEVICE,
        clock,
        hlc: new HybridClock(DEMO_DEVICE, { physical: clock }),
        lease: { isHolder: () => true },
      },
    );
    if (!created.ok) throw new Error(created.reason);
  }
  return store;
}

function deps(
  over: Partial<VaultEngineDeps> & Pick<VaultEngineDeps, "store" | "log" | "keyStore">,
): VaultEngineDeps {
  return {
    vault: DEMO_VAULT,
    device: DEMO_DEVICE,
    kind: "demo",
    sodium,
    remotes: [],
    queue: createVaultQueue(),
    now: () => Date.now(),
    yieldToUi,
    ...over,
  };
}

describe("the demo vault", () => {
  it("creates its authority on the phone, writes commands as own frames and reopens", async () => {
    const keyStore = memoryKeyStore(sodium);
    const viewDb = new Database(":memory:");
    const log = memoryDriver();
    const store = demoView(betterSqlite3Driver(viewDb));
    const session = createVaultSession(deps({ store, log, keyStore }));
    expect(session.status().phase).toBe("opening");
    await session.opened;
    expect(session.status()).toMatchObject({ phase: "ready", remote: false, unpushed: false });
    expect(readVaultBootstrap(log)).toMatchObject({ kind: "demo", state: "ready" });
    // device.added and the creator's pin are the first own frame.
    expect(ownSegments(log, DEMO_DEVICE)).toBe(1);
    const before = log
      .prepare("SELECT size FROM log_segments WHERE device = ?")
      .get<{ size: number }>(DEMO_DEVICE)?.size as number;

    const renamed = await session.execute(renameProfile, { name: "Anna K" }, "key-1");
    expect(renamed).toMatchObject({ kind: "completed" });
    expect(profileName(store)).toBe("Anna K");
    const after = log
      .prepare("SELECT size FROM log_segments WHERE device = ?")
      .get<{ size: number }>(DEMO_DEVICE)?.size as number;
    expect(after).toBeGreaterThan(before);
    // The same key answers from the journal; a different input under it is a conflict.
    expect(await session.execute(renameProfile, { name: "Anna K" }, "key-1")).toMatchObject({
      kind: "completed",
    });
    expect(await session.execute(renameProfile, { name: "Other" }, "key-1")).toEqual({
      kind: "refused",
      reason: "request_key_conflict",
    });
    expect(await session.reconcile("key-1")).toMatchObject({ kind: "completed" });
    expect(await session.reconcile("never-sent")).toEqual({
      kind: "not_started",
      reason: "attempt_missing",
    });
    // A demo has no remote: passes do nothing.
    expect(await session.pass("full")).toBeUndefined();
    await session.close();
    expect(await session.execute(renameProfile, { name: "Closed" }, "key-2")).toEqual({
      kind: "not_started",
      reason: "vault_unavailable",
    });

    // The next launch opens the same files: the log replays, the authority checks out again.
    const reopened = createVaultSession(deps({ store, log, keyStore }));
    await reopened.opened;
    expect(reopened.status().phase).toBe("ready");
    expect(await reopened.execute(renameProfile, { name: "Anna" }, "key-3")).toMatchObject({
      kind: "completed",
    });
    expect(profileName(store)).toBe("Anna");
    await reopened.close();
  });

  it("reopens verifying only the frames after its checkpoint, and replays all of them without it", async () => {
    const keyStore = memoryKeyStore(sodium);
    const log = memoryDriver();
    const store = demoView();
    const first = createVaultSession(deps({ store, log, keyStore }));
    await first.opened;
    for (let i = 0; i < 12; i++) {
      expect(await first.execute(renameProfile, { name: `Anna ${i}` }, `k${i}`)).toMatchObject({
        kind: "completed",
      });
    }
    await first.close();
    // The commands landed after the open's checkpoint: the next open verifies them and records a new one.
    const tail = await verifiesDuring(async () => {
      const s = createVaultSession(deps({ store, log, keyStore }));
      await s.opened;
      expect(s.status().phase).toBe("ready");
      await s.close();
    });
    const saved = checkpointRow(log, DEMO_DEVICE);
    expect(saved).toBeDefined();
    const quiet = await verifiesDuring(async () => {
      const replays: number[] = [];
      const s = createVaultSession(deps({ store, log, keyStore }));
      const stop = s.subscribe(() => {
        const replay = s.status().replay;
        if (replay) replays.push(replay.total);
      });
      await s.opened;
      stop();
      expect(s.status().phase).toBe("ready");
      expect(s.status().replay).toBeUndefined();
      expect(replays).toEqual([0]);
      await s.close();
    });
    log.prepare("DELETE FROM sync_recovery_checkpoint").run();
    const full = await verifiesDuring(async () => {
      const s = createVaultSession(deps({ store, log, keyStore }));
      await s.opened;
      expect(s.status().phase).toBe("ready");
      expect(profileName(store)).toBe("Anna 11");
      await s.close();
    });
    // Every one of the 13 frame heads is verified without it; with it, none (the rest is per open:
    // the device certificate, the gate snapshot and the checkpoint signatures).
    // Without it every one of the 13 frame heads is verified; with it none (what remains per open is
    // the certificate, the gate snapshot and the checkpoint's own signatures), and after the 12 commands
    // exactly their 12 frames.
    expect(full.verifies).toBeGreaterThanOrEqual(13);
    expect(full.verifies - quiet.verifies).toBeGreaterThanOrEqual(12);
    expect(tail.verifies - quiet.verifies).toBe(12);
    // A damaged row is discarded (full replay) and replaced.
    log.prepare("UPDATE sync_recovery_checkpoint SET value = ?").run('{"body":"{}","sig":"00"}');
    const damaged = await verifiesDuring(async () => {
      const s = createVaultSession(deps({ store, log, keyStore }));
      await s.opened;
      expect(s.status().phase).toBe("ready");
      await s.close();
    });
    expect(damaged.verifies).toBe(full.verifies);
    expect(checkpointRow(log, DEMO_DEVICE)).toMatch(/^\{"body":/);
  });

  it("shares one device identity between both demo vaults opened at once", async () => {
    const keyStore = memoryKeyStore(sodium);
    const HOME_VAULT = "ca000000000000000000000000000b22";
    const annaStore = demoView();
    const homeStore = demoView(memoryDriver(), HOME_VAULT);
    const annaLog = memoryDriver();
    const homeLog = memoryDriver();
    // One queue like the services: the two vaults' chains run concurrently.
    const queue = createVaultQueue();
    const open = () => [
      createVaultSession(deps({ store: annaStore, log: annaLog, keyStore, queue })),
      createVaultSession(
        deps({ vault: HOME_VAULT, store: homeStore, log: homeLog, keyStore, queue }),
      ),
    ];
    const first = open();
    await Promise.all(first.map((s) => s.opened));
    expect(first.map((s) => s.status().phase)).toEqual(["ready", "ready"]);
    await Promise.all(first.map((s) => s.close()));

    // The next launch: both vaults check their creator certificate against the one stored identity.
    const second = open();
    await Promise.all(second.map((s) => s.opened));
    expect(second.map((s) => s.status().phase)).toEqual(["ready", "ready"]);
    expect(await second[1]?.execute(renameProfile, { name: "Dom" }, "home-1")).toMatchObject({
      kind: "completed",
    });
    await Promise.all(second.map((s) => s.close()));
  });

  it("fails closed when its keys are gone", async () => {
    const keyStore = memoryKeyStore(sodium);
    const store = demoView();
    const log = memoryDriver();
    const first = createVaultSession(deps({ store, log, keyStore }));
    await first.opened;
    await first.close();
    await keyStore.delete(crypto.keyringName(DEMO_VAULT));
    const second = createVaultSession(deps({ store, log, keyStore }));
    await second.opened;
    expect(second.status()).toMatchObject({ phase: "failed", failure: "missing_authority" });
    expect(await second.execute(renameProfile, { name: "X" }, "k")).toEqual({
      kind: "not_started",
      reason: "vault_unavailable",
    });
  });
});

/** A Mac-like device that created a vault, over a memory local log and the fake relay. */
interface Mac {
  readonly vault: string;
  readonly device: string;
  readonly store: Store;
  readonly engine: SyncEngine;
  readonly candidate: Awaited<ReturnType<typeof loadDeviceAuthority>>;
  /** The owner's recovery identity (the words), for a revocation. */
  readonly recovery: crypto.RecoveryIdentity;
  write(command: typeof renameProfile, input: unknown): Promise<void>;
}

function relayTransport(fake: FakeFirebase): FirestoreTransport {
  const auth = new AnonymousAuth({
    endpoint: fake.identity,
    store: new MemoryAuthStore(),
    fetch: fake.fetch,
  });
  const rest = new FirestoreRest({ endpoint: fake.endpoint, auth, fetch: fake.fetch });
  return new FirestoreTransport({ rest, uid: () => auth.uid() });
}

async function createMac(fake: FakeFirebase): Promise<Mac> {
  const now = () => Date.now();
  const eid = () => mintUlid(now(), (n) => sodium.randomBytes(n));
  const recovery = crypto.recoveryIdentity(sodium, crypto.createRecoveryKey(sodium).phrase);
  const identity = crypto.createDeviceIdentity(sodium);
  const created = crypto.createVaultWithRecovery(sodium, recovery, identity);
  const vault = created.ring.vaultId;
  const device = identity.deviceId;
  const keyStore = memoryKeyStore(sodium);
  await crypto.saveDeviceIdentity(keyStore, identity);
  await crypto.saveKeyring(keyStore, created.ring);
  const meta = memoryDriver();
  const provenance = SqlProvenanceStore.open(meta, created.ring, "new");
  provenance.put({
    kid: created.ring.active.kid,
    generation: created.ring.active.generation,
    epoch: created.ring.active.epoch,
    sender: device,
    recipients: null,
    source: "own",
    receivedAt: now(),
  });
  const store = viewStore(vault, gidSaltOf(created.ring));
  initializeMetaClockGuard(store.driver, device);
  const candidate = await loadDeviceAuthority({
    vaultId: vault,
    deviceId: device,
    keyStore,
    sodium,
    provenance,
    clock: now,
    bootstrapCertificates: [created.creatorCertificate],
  });
  const engine = await createSyncEngine({
    vault,
    device,
    local: new MemoryTransport(),
    remotes: [relayTransport(fake)],
    codec: createOwnLogCodec({ sodium, ring: candidate.ring, signer: candidate.identity }),
    gate: candidate.gate,
    sink: store.sink(),
    clockStore: metaClockStore(store.driver, device),
    clockGuard: metaClockGuardStore(store.driver, device),
    gateState: metaGateStateStore(store.driver, device),
    gossipEid: eid,
  });
  await engine.write([
    devices.buildDeviceAdded(
      candidate.identity,
      vault,
      eid(),
      {
        deviceId: device,
        signPublicKey: identity.signPublicKey,
        boxPublicKey: identity.box.publicKey,
      },
      "Mac",
      created.creatorCertificate,
    ),
    devices.creatorPin(candidate.identity, recovery, vault, eid(), now()),
  ]);
  const env = { device, clock: { now }, lease: { isHolder: () => false } };
  const write = async (command: typeof renameProfile | typeof createProfile, input: unknown) => {
    const prepared = prepareCommand(store, command as typeof renameProfile, input, env);
    if (!prepared.ok) throw new Error(prepared.reason);
    await engine.write(prepared.events.map(toUnstampedEvent));
  };
  await write(createProfile, {
    slug: "ala",
    name: "Ala",
    baseCurrency: "PLN",
    modules: ["budget"],
  });
  await engine.sync();
  return { vault, device, store, engine, candidate, recovery, write };
}

/** Two in-memory pairing links (the relay's pairing documents are C2's; the protocol is the same). */
function memoryLinks(): { inviter: devices.PairingLink; joiner: devices.PairingLink } {
  const queue = () => {
    const items: Uint8Array[] = [];
    const waiting: ((m: Uint8Array) => void)[] = [];
    return {
      push(m: Uint8Array) {
        const next = waiting.shift();
        if (next) next(m);
        else items.push(m);
      },
      next(): Promise<Uint8Array> {
        const item = items.shift();
        return item ? Promise.resolve(item) : new Promise((resolve) => waiting.push(resolve));
      },
    };
  };
  const toInviter = queue();
  const toJoiner = queue();
  return {
    inviter: { send: async (m) => toJoiner.push(m), receive: () => toInviter.next() },
    joiner: { send: async (m) => toInviter.push(m), receive: () => toJoiner.next() },
  };
}

/** The phone's half of a paired vault: its KeyStore, files and a way to open a session over them. */
interface PairedPhone {
  readonly device: string;
  readonly keyStore: crypto.KeyStore;
  readonly log: SqlDriver;
  readonly store: Store;
  readonly relay: FirestoreTransport;
  open(remote?: Transport): VaultSession;
}

/**
 * Pair a phone with `mac` through the real protocol and keep the welcome like the services do; `into`
 * re-pairs over the files of an earlier pairing (a new device id, the same vault).
 */
async function pairPhone(
  fake: FakeFirebase,
  mac: Mac,
  into?: Partial<Pick<PairedPhone, "keyStore" | "log" | "store">>,
): Promise<PairedPhone> {
  const now = () => Date.now();
  const phoneIdentity = crypto.createDeviceIdentity(sodium);
  const invite = devices.PairingInviter.create({
    sodium,
    identity: mac.candidate.identity,
    ring: mac.candidate.ring,
    registry: mac.candidate.devices.registry,
    now: now(),
  });
  if (!invite.ok) throw new Error(invite.reason);
  const started = devices.PairingJoiner.start(
    { sodium, identity: phoneIdentity, name: "iPhone" },
    invite.value.qr,
    now(),
  );
  if (!started.ok) throw new Error(started.reason);
  const links = memoryLinks();
  let sas: string | undefined;
  const [inv, join] = await Promise.all([
    devices.runInviter(invite.value.inviter, links.inviter, {
      now,
      enterCode: async () => sas,
      eid: () => mintUlid(now(), (n) => sodium.randomBytes(n)),
    }),
    devices.runJoiner(started.value.joiner, started.value.hello, links.joiner, {
      now,
      showSas: (code) => {
        sas = code;
      },
    }),
  ]);
  if (!inv.ok || !join.ok) throw new Error("pairing failed");
  await mac.engine.write([inv.value.deviceAdded]);
  await mac.engine.sync();

  const keyStore = into?.keyStore ?? memoryKeyStore(sodium);
  const log = into?.log ?? memoryDriver();
  await storeJoinedVault(
    keyStore,
    log,
    {
      identity: phoneIdentity,
      ring: join.value.ring,
      certificate: join.value.certificate,
      registryEvents: join.value.registryEvents,
      inviter: mac.device,
    },
    now,
  );
  const store = into?.store ?? viewStore(mac.vault, gidSaltOf(join.value.ring));
  const relay = relayTransport(fake);
  const device = phoneIdentity.deviceId;
  return {
    device,
    keyStore,
    log,
    store,
    relay,
    open: (remote = relay) =>
      createVaultSession(
        deps({
          vault: mac.vault,
          device,
          kind: "paired",
          store,
          log,
          keyStore,
          remotes: [remote],
          relayStatus: () => relay.status(),
        }),
      ),
  };
}

/** `remote` whose appends of `device`'s own segments are refused with an offset conflict. */
function conflictingOwnAppends(remote: Transport, device: string): Transport {
  return {
    consistency: remote.consistency,
    list: (vault) => remote.list(vault),
    read: (vault, writer, seg, from) => remote.read(vault, writer, seg, from),
    append: (vault, writer, seg, at, bytes) =>
      writer === device
        ? Promise.reject(new TransportError("offset-conflict", "synthetic conflict"))
        : remote.append(vault, writer, seg, at, bytes),
  };
}

/** `remote` whose reads of `writer`'s segments come back with the last byte flipped while `on()`. */
function corruptingReads(remote: Transport, writer: string, on: () => boolean): Transport {
  return {
    consistency: remote.consistency,
    list: (vault) => remote.list(vault),
    read: async (vault, device, seg, from) => {
      const bytes = await remote.read(vault, device, seg, from);
      if (device !== writer || !on() || bytes.length === 0) return bytes;
      const copy = bytes.slice();
      copy[copy.length - 1] = (copy[copy.length - 1] ?? 0) ^ 0xff;
      return copy;
    },
    append: (vault, device, seg, at, bytes) => remote.append(vault, device, seg, at, bytes),
  };
}

describe("a paired vault", () => {
  it("receives its first sync, then converges with the Mac over the relay both ways", async () => {
    const fake = createFakeFirebase();
    const mac = await createMac(fake);
    const paired = await pairPhone(fake, mac);
    const { log, store } = paired;
    const phone: VaultSession = paired.open();
    await phone.opened;
    expect(phone.status()).toMatchObject({ phase: "receiving", remote: true });
    expect(await phone.execute(renameProfile, { name: "Too early" }, "k0")).toEqual({
      kind: "not_started",
      reason: "vault_receiving",
    });
    const progress: number[] = [];
    const stop = phone.subscribe(() => {
      const applied = phone.status().progress?.applied;
      if (applied !== undefined) progress.push(applied);
    });
    await phone.pass("full");
    stop();
    expect(phone.status()).toMatchObject({ phase: "ready", syncing: false, unpushed: false });
    expect(phone.status().lastPullAt).toEqual(expect.any(Number));
    expect(phone.status().progress).toBeUndefined();
    expect(Math.max(...progress)).toBeGreaterThan(0);
    expect(profileName(store)).toBe("Ala");
    // The names the registry fold gives: the phone as the pairing named it, and the Mac that paired it.
    expect(phone.status().names).toMatchObject({
      self: { name: "iPhone", addedAt: expect.any(Number) },
      pairedBy: { deviceId: mac.device, name: "Mac" },
    });

    // A phone edit: an own frame in log_segments, pushed by the next pass, folded by the Mac.
    expect(await phone.execute(renameProfile, { name: "Ala z telefonu" }, "k1")).toMatchObject({
      kind: "completed",
    });
    expect(ownSegments(log, paired.device)).toBe(1);
    expect(phone.status().unpushed).toBe(true);
    await phone.pass("push");
    expect(phone.status().unpushed).toBe(false);
    await mac.engine.sync();
    expect(profileName(mac.store)).toBe("Ala z telefonu");

    // A Mac edit reaches the phone on its next pass.
    await mac.write(renameProfile, { name: "Ala z Maca" });
    await mac.engine.sync();
    await phone.pass("full");
    expect(profileName(store)).toBe("Ala z Maca");
    expect(phone.status().phase).toBe("ready");
    await phone.close();
    await mac.engine.close();
  }, 60_000);

  it("carries the engine's stuck writers, value-free and named from the registry, until they move", async () => {
    const fake = createFakeFirebase();
    const mac = await createMac(fake);
    const paired = await pairPhone(fake, mac);
    let corrupt = false;
    const phone = paired.open(corruptingReads(paired.relay, mac.device, () => corrupt));
    await phone.opened;
    await phone.pass("full");
    expect(phone.status().stuck).toBeUndefined();
    await mac.write(renameProfile, { name: "Ala nieczytelna" });
    await mac.engine.sync();
    corrupt = true;
    const before = Date.now();
    await phone.pass("full");
    const stuck = phone.status().stuck;
    expect(stuck).toEqual([
      { device: mac.device, name: "Mac", kind: "rejected", since: expect.any(Number) },
    ]);
    expect(stuck?.[0]?.since).toBeGreaterThanOrEqual(before);
    expect(profileName(paired.store)).toBe("Ala");
    corrupt = false;
    await phone.pass("full");
    expect(phone.status().stuck).toBeUndefined();
    expect(profileName(paired.store)).toBe("Ala nieczytelna");
    await phone.close();
    await mac.engine.close();
  }, 60_000);

  it("after its first sync reopens and replays a pass verifying only the new frames", async () => {
    const fake = createFakeFirebase();
    const mac = await createMac(fake);
    const paired = await pairPhone(fake, mac);
    const phone = paired.open();
    await phone.opened;
    await phone.pass("full");
    expect(phone.status().phase).toBe("ready");
    await phone.close();
    const reopen = async () => {
      const s = paired.open();
      await s.opened;
      expect(s.status().phase).toBe("ready");
      return s;
    };
    const quiet = await verifiesDuring(async () => (await reopen()).close());
    paired.log.prepare("DELETE FROM sync_recovery_checkpoint").run();
    const full = await verifiesDuring(async () => (await reopen()).close());
    expect(quiet.verifies).toBeLessThan(full.verifies);
    // A Mac edit: the pass verifies the pulled frame; the replay after it only the frames since the
    // checkpoint, not the whole log again (the convergence result stays the same).
    const again = await reopen();
    await mac.write(renameProfile, { name: "Ala po checkpoincie" });
    await mac.engine.sync();
    const pass = await verifiesDuring(() => again.pass("full"));
    expect(profileName(paired.store)).toBe("Ala po checkpoincie");
    expect(again.status().phase).toBe("ready");
    expect(pass.verifies).toBeLessThan(full.verifies);
    await again.close();
    await mac.engine.close();
  }, 60_000);

  it("resets the view when the vault is paired again under a new device id", async () => {
    const fake = createFakeFirebase();
    const mac = await createMac(fake);
    const first = await pairPhone(fake, mac);
    const before = first.open();
    await before.opened;
    await before.pass("full");
    expect(before.status().phase).toBe("ready");
    expect(profileName(first.store)).toBe("Ala");
    await before.close();

    // Paired again (the earlier pairing was lost): new identity and log, the old view file stays.
    await mac.write(renameProfile, { name: "Ala po parowaniu" });
    const again = await pairPhone(fake, mac, first);
    expect(again.device).not.toBe(first.device);
    const after = again.open();
    await after.opened;
    expect(after.status()).toMatchObject({ phase: "receiving" });
    expect(profileName(again.store)).toBeUndefined();
    await after.pass("full");
    expect(after.status().phase).toBe("ready");
    expect(profileName(again.store)).toBe("Ala po parowaniu");
    await after.close();

    // The mark is gone: the next launch keeps the synced view.
    const later = again.open();
    await later.opened;
    expect(later.status().phase).toBe("ready");
    expect(profileName(again.store)).toBe("Ala po parowaniu");
    await later.close();
    await mac.engine.close();
  }, 60_000);

  it("opens a failed vault again on retry, once its keys are readable", async () => {
    const fake = createFakeFirebase();
    const mac = await createMac(fake);
    const paired = await pairPhone(fake, mac);
    const name = crypto.keyringName(mac.vault);
    const sealed = await paired.keyStore.get(name);
    if (sealed === null) throw new Error("no keyring");
    await paired.keyStore.delete(name);
    const phone = paired.open();
    await phone.opened;
    expect(phone.status()).toMatchObject({ phase: "failed", failure: "missing_authority" });
    expect(await phone.pass("full")).toBeUndefined();

    // Still unreadable: the retry fails closed again.
    phone.retry();
    expect(phone.status().phase).toBe("opening");
    await phone.opened;
    expect(phone.status()).toMatchObject({ phase: "failed", failure: "missing_authority" });

    await paired.keyStore.set(name, sealed);
    phone.retry();
    await phone.opened;
    expect(phone.status()).toMatchObject({ phase: "receiving" });
    expect(phone.status().failure).toBeUndefined();
    await phone.pass("full");
    expect(phone.status().phase).toBe("ready");
    expect(profileName(paired.store)).toBe("Ala");
    // Retry does nothing outside `failed`.
    phone.retry();
    expect(phone.status().phase).toBe("ready");
    await phone.close();
    await mac.engine.close();
  }, 60_000);

  it("keeps own writes unpushed until the relay holds them, across a kill", async () => {
    const fake = createFakeFirebase();
    const mac = await createMac(fake);
    const paired = await pairPhone(fake, mac);
    const first = paired.open();
    await first.opened;
    await first.pass("full");
    expect(first.status()).toMatchObject({ phase: "ready", unpushed: false });
    const pulledAt = first.status().lastPullAt;
    expect(pulledAt).toEqual(expect.any(Number));

    // A command, then the app is killed before any pass: the next launch still knows a push is due.
    expect(await first.execute(renameProfile, { name: "Offline edit" }, "k1")).toMatchObject({
      kind: "completed",
    });
    await first.close();
    const second = paired.open(conflictingOwnAppends(paired.relay, paired.device));
    await second.opened;
    expect(second.status()).toMatchObject({ phase: "ready", unpushed: true });
    expect(second.status().lastPullAt).toBeUndefined();

    // The relay is reached but refuses the own append: still unpushed, and not fresh.
    await second.pass("full");
    expect(second.status()).toMatchObject({ phase: "ready", unpushed: true });
    expect(second.status().lastPullAt).toBeUndefined();
    expect(second.status().failure).toBeUndefined();
    await second.close();

    // A later launch over a working relay pushes it; the Mac folds the edit.
    const third = paired.open();
    await third.opened;
    expect(third.status().unpushed).toBe(true);
    await third.pass("push");
    expect(third.status().unpushed).toBe(false);
    expect(third.status().lastPullAt).toEqual(expect.any(Number));
    await third.close();
    const fourth = paired.open();
    await fourth.opened;
    expect(fourth.status().unpushed).toBe(false);
    await fourth.close();
    await mac.engine.sync();
    expect(profileName(mac.store)).toBe("Offline edit");
    await mac.engine.close();
  }, 60_000);

  it("writes the keyring back only when a pass changed it", async () => {
    const fake = createFakeFirebase();
    const mac = await createMac(fake);
    const base = memoryKeyStore(sodium);
    const writes: string[] = [];
    const counting: crypto.KeyStore = {
      get: (name) => base.get(name),
      set: (name, value) => {
        writes.push(name);
        return base.set(name, value);
      },
      delete: (name) => base.delete(name),
    };
    const paired = await pairPhone(fake, mac, { keyStore: counting });
    const ring = crypto.keyringName(mac.vault);
    expect(writes).toContain(ring);
    writes.length = 0;
    const phone = paired.open();
    await phone.opened;
    // The first sync and a later pass pull frames under keys the welcome brought: nothing to write.
    await phone.pass("full");
    expect(phone.status().phase).toBe("ready");
    await mac.write(renameProfile, { name: "Ala 2" });
    await mac.engine.sync();
    await phone.pass("full");
    expect(profileName(paired.store)).toBe("Ala 2");
    expect(writes.filter((name) => name === ring)).toEqual([]);
    await phone.close();
    await mac.engine.close();
  }, 60_000);

  it("refuses to re-pair over own frames the relay does not hold, and re-pairs once pushed", async () => {
    const fake = createFakeFirebase();
    const mac = await createMac(fake);
    const first = await pairPhone(fake, mac);
    const before = first.open();
    await before.opened;
    await before.pass("full");
    expect(await before.execute(renameProfile, { name: "Phone edit" }, "k1")).toMatchObject({
      kind: "completed",
    });
    expect(before.status().unpushed).toBe(true);
    await before.close();
    const ringName = crypto.keyringName(mac.vault);
    const ringBefore = await first.keyStore.get(ringName);

    // Paired again while the edit waits: refused, nothing replaced.
    await expect(pairPhone(fake, mac, first)).rejects.toThrow("unpushed_changes");
    expect(await first.keyStore.get(ringName)).toEqual(ringBefore);
    expect(ownSegments(first.log, first.device)).toBe(1);
    const kept = first.open();
    await kept.opened;
    expect(kept.status()).toMatchObject({ phase: "ready", unpushed: true });
    expect(profileName(first.store)).toBe("Phone edit");

    // Pushed: the Mac folds the edit and the re-pairing goes through.
    await kept.pass("push");
    expect(kept.status().unpushed).toBe(false);
    await kept.close();
    await mac.engine.sync();
    expect(profileName(mac.store)).toBe("Phone edit");
    const again = await pairPhone(fake, mac, first);
    expect(again.device).not.toBe(first.device);
    expect(readVaultBootstrap(again.log)?.device).toBe(again.device);
    await mac.engine.close();
  }, 60_000);

  it("waits for a revocation's rotation that arrives in a later pass, then writes again", async () => {
    const fake = createFakeFirebase();
    const mac = await createMac(fake);
    const paired = await pairPhone(fake, mac);
    // A second device the Mac paired and later revokes (it never runs).
    const tablet = await pairPhone(fake, mac);
    const phone = paired.open();
    await phone.opened;
    await phone.pass("full");
    expect(phone.status().phase).toBe("ready");

    // The Mac revokes the tablet with the recovery words; the revocation reaches the relay one pass
    // before its key rotation (the stream stopped between the two frames).
    const eid = () => mintUlid(Date.now(), (n) => sodium.randomBytes(n));
    const request: devices.RevocationPreviewRequest = {
      targets: [{ device: tablet.device, applied: START_CURSOR }],
      revokeEid: eid(),
      attemptId: eid(),
      authority: { kind: "recovery" },
      selection: { recertify: [] },
    };
    const observed = devices.previewRevocation(mac.candidate.devices, mac.candidate.gate, request);
    if (!observed.ok) throw new Error("preview refused");
    const permit = devices.acknowledgeRevocationPreview(observed.preview, {
      warning: "acknowledged",
      ...(observed.preview.requiresLocalStartConfirmation
        ? { localStart: "local_never_seen" as const }
        : {}),
    });
    if (permit === undefined) throw new Error("no permit");
    const prepared = mac.candidate.devices.prepareRevocation(
      mac.candidate.gate,
      request,
      permit,
      { revoke: request.revokeEid, rotate: eid() },
      mac.recovery,
      {},
    );
    if (!prepared.ok) throw new Error(prepared.reason);
    const [revocation, ...rotation] = prepared.change.events;
    if (revocation === undefined || rotation.length === 0) throw new Error("unexpected batch");
    await mac.engine.write([revocation]);
    await mac.engine.sync();

    await phone.pass("full");
    expect(phone.status()).toMatchObject({ phase: "waiting", failure: "rotation_pending" });
    expect(await phone.execute(renameProfile, { name: "While waiting" }, "w1")).toEqual({
      kind: "not_started",
      reason: "vault_unavailable",
    });
    // A new launch opens it waiting too, never failed: the next pass can still pull the rotation.
    await phone.close();
    const reopened = paired.open();
    await reopened.opened;
    expect(reopened.status()).toMatchObject({ phase: "waiting", failure: "rotation_pending" });

    await mac.engine.write(rotation);
    prepared.change.commit();
    await mac.engine.sync();
    await reopened.pass("full");
    expect(reopened.status().phase).toBe("ready");
    expect(reopened.status().failure).toBeUndefined();
    expect(await reopened.execute(renameProfile, { name: "After rotation" }, "w2")).toMatchObject({
      kind: "completed",
    });
    await reopened.pass("push");
    await mac.engine.sync();
    expect(profileName(mac.store)).toBe("After rotation");
    await reopened.close();
    await mac.engine.close();
  }, 60_000);
});
