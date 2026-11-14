// One vault's sync engine on the phone (M4-D): the view store the client reads, the vault's private
// log database (`vaultBootstrap.ts`), the device authority from the KeyStore, `createSyncEngine` over
// the SQLite own log with the relay as the only remote (none for the demo), and the durable command
// boundary. Platform-free: the services inject the drivers, the KeyStore, sodium, the remotes and the
// UI yield, so the Node tests run the same code over better-sqlite3 and libsodium-wrappers.
//
// The session exists from boot (`createVaultSession`, synchronous) and opens its engine in the
// background through the vault's queue, so a command sent before the engine is open waits for it.
// Phases: `opening` -> `ready`, or `receiving` (a paired vault whose profile has not arrived yet: the
// first sync is running or still to run; commands are refused), `waiting` (the vault needs a key
// rotation: a device was revoked, the active key's sender is no longer trusted, or the recovery key
// changed; another device rotates, never the phone, so passes keep pulling while commands are refused),
// `removed` (this phone was revoked in the vault: the pairing screen offers the wipe), `failed` (the
// vault could not be opened or its authority no longer checks out: fail closed, nothing is written;
// `retry` opens it again, the sync runner decides when: `syncRunner.ts`).
//
// Hermes runs everything on one JS thread: the engine hands the sink at most `MAX_BATCH_EVENTS` events
// per transaction and the sink wrapper yields a macrotask before each one, so a long first sync
// leaves frames to the UI and live queries refresh per committed chunk.

import type { Command } from "@cashu/store";
import type { Store } from "@cashu/store/runtime";
import {
  assertReplayedDeviceAuthority,
  type DeviceAuthorityCandidate,
  DeviceAuthorityRefusal,
  type DurableCommandResult,
  executeDurableCommand,
  initializeMetaClockGuard,
  loadDeviceAuthority,
  metaClockGuardStore,
  metaClockStore,
  metaGateStateStore,
  mintUlid,
  SqlCommandAttemptJournal,
  type SqlDriver,
  SqlLogTransport,
  SqlProvenanceStore,
  SqlRecoveryCheckpointStore,
  type VaultDeviceNames,
  vaultDeviceNames,
} from "@cashu/store/sync";
import type { DurableOutcome } from "@cashu/store-react/local";
import {
  createOwnLogCodec,
  createSyncEngine,
  crypto,
  devices,
  type EventSink,
  type InboundBatch,
  type LocalRecoveryResult,
  type RelayStatus,
  type StuckKind,
  type StuckRecord,
  type SyncEngine,
  type SyncResult,
  type Transport,
} from "@cashu/sync/engine";
import type { PhoneVaultQueue } from "./commandQueue";
import {
  clearViewReset,
  createVaultLog,
  markVaultLogPending,
  markVaultLogReady,
  ownUnpushed,
  readRelayCursor,
  readVaultBootstrap,
  saveRelayCursor,
  viewResetPending,
} from "./vaultBootstrap";

/** Events per sink transaction on the phone (the engine default is 25,000: one long JS-thread block). */
const MAX_BATCH_EVENTS = 1500;
/** The first-sync estimate: bytes of a sealed log per event (measured ~50 B on the M4 import). */
const BYTES_PER_EVENT = 50;

type VaultPhase = "opening" | "receiving" | "ready" | "waiting" | "removed" | "failed";

/** What the sync surfaces read about one vault (a new object on every change). */
export interface VaultSyncStatus {
  readonly vault: string;
  readonly phase: VaultPhase;
  /** A pass is running. */
  readonly syncing: boolean;
  /** The vault syncs with the relay (paired, and this build has a relay config). */
  readonly remote: boolean;
  /** When the last pass started that pulled every remote and left no own bytes unpushed (epoch ms). */
  readonly lastPullAt?: number;
  /**
   * Own log bytes the relay is not known to hold (a push is due): the local own log against the relay
   * cursor of the last pass that listed every remote, so it survives a kill.
   */
  readonly unpushed: boolean;
  /** The relay's last call outcome (value-free). */
  readonly relay?: RelayStatus;
  /** Events applied in the running pass and the estimate of the whole first sync. */
  readonly progress?: { readonly applied: number; readonly expected: number };
  /**
   * While the local log is audited (the open, and the replay after a pass that brought frames): frames
   * verified of those to verify. Absent otherwise.
   */
  readonly replay?: { readonly done: number; readonly total: number };
  /** Value-free code of the failure that put the vault in `failed` or of the last failed pass. */
  readonly failure?: string;
  /**
   * This device's registry name / pairing day and the device that paired it (paired vaults; refreshed
   * whenever the authority replays). The demo leaves it undefined: its registry holds only the phone.
   */
  readonly names?: VaultDeviceNames;
  /**
   * Writer streams held at a frame after the last pass (the engine's D7 stuck records), value-free: the
   * writer's id and registry name, how it holds and since when. Absent when every stream moves.
   */
  readonly stuck?: readonly VaultStuckWriter[];
}

/** One writer whose frames this phone cannot read (yet). */
interface VaultStuckWriter {
  readonly device: string;
  /** The writer's registry name; undefined when the registry does not know it (yet). */
  readonly name?: string;
  readonly kind: StuckKind;
  /** When a pass first met the held frame (epoch ms). */
  readonly since: number;
}

export interface VaultEngineDeps {
  readonly vault: string;
  readonly device: string;
  readonly kind: "paired" | "demo";
  readonly store: Store;
  /** The vault's `log-<vault>.db`. */
  readonly log: SqlDriver;
  readonly keyStore: crypto.KeyStore;
  readonly sodium: crypto.Sodium;
  /** The relay (paired vaults with a relay config); empty for the demo. */
  readonly remotes: readonly Transport[];
  /** The shared relay transport's status, read after each of this vault's calls. */
  readonly relayStatus?: () => RelayStatus;
  readonly queue: PhoneVaultQueue;
  readonly now: () => number;
  /** Resolves on a later macrotask (`setTimeout(0)` on the phone). */
  readonly yieldToUi: () => Promise<void>;
  /** The demo's device name in its registry. */
  readonly demoDeviceName?: string;
}

export interface VaultSession {
  readonly vault: string;
  readonly device: string;
  readonly store: Store;
  status(): VaultSyncStatus;
  subscribe(listener: () => void): () => void;
  /** Resolves when the current open finished (any phase but `opening`); never rejects. */
  readonly opened: Promise<void>;
  /**
   * Open a `failed` vault again (after its queued work; the engine of a failed pass is closed first).
   * Does nothing in any other phase. The status is `opening` until `opened` settles.
   */
  retry(): void;
  execute(command: Command<unknown, unknown>, input: unknown, key: string): Promise<DurableOutcome>;
  reconcile(key: string): Promise<DurableOutcome>;
  /**
   * One sync pass through the vault's queue. `push` runs only when own writes wait to be pushed (the
   * engine pushes and pulls in one pass). Resolves with the result, or undefined when nothing ran.
   */
  pass(mode: "full" | "push"): Promise<SyncResult | undefined>;
  /** Close the engine (after the queued work) and release the key material. */
  close(): Promise<void>;
}

/** The single profile gid of the view, undefined unless exactly one profile row exists. */
function profileGid(store: Store): string | undefined {
  const rows = store.read<{ gid: string }>("SELECT gid FROM profiles");
  return rows.length === 1 ? rows[0]?.gid : undefined;
}

function hasGuard(store: Store, device: string): boolean {
  return (
    store.read("SELECT 1 FROM store_meta WHERE key = ?", `fetch-clock-guard:${device}`).length > 0
  );
}

function hasHistory(store: Store): boolean {
  return (
    store.read("SELECT 1 FROM event_log LIMIT 1").length > 0 ||
    store.read("SELECT 1 FROM sync_cursors LIMIT 1").length > 0
  );
}

/**
 * Empty the view of a vault whose log a pairing just (re)created: it may hold an earlier pairing's
 * events, cursors and gate snapshot, none of which the new log backs. This device's clock and guard
 * stay (they only ever move forward) and so does the gate's fork evidence.
 */
function resetView(store: Store, device: string): void {
  store.sink().reset();
  store.driver.prepare("DELETE FROM store_meta WHERE key = ?").run(`gate:${device}`);
}

/** Seed the verified-clock guard of a fresh view (a paired vault before its first sync). */
function ensureClockGuard(store: Store, device: string): void {
  if (hasGuard(store, device)) return;
  if (hasHistory(store)) throw new Error("clock_guard_missing");
  initializeMetaClockGuard(store.driver, device);
}

/** The sink wrapper: a macrotask before every transaction, applied foreign events counted. */
function yieldingSink(
  sink: EventSink,
  yieldToUi: () => Promise<void>,
  onForeignApplied: (events: number) => void,
): EventSink {
  const wrapped: EventSink = {
    cursors: () => sink.cursors(),
    async applyBatches(batches: readonly InboundBatch[]) {
      await yieldToUi();
      const outcome = await sink.applyBatches(batches);
      const foreign = batches.reduce((n, b) => (b.own ? n : n + b.events.length), 0);
      if (foreign > 0) onForeignApplied(foreign);
      return outcome;
    },
    reset: () => sink.reset(),
  };
  const needsUpgrade = sink.needsUpgrade?.bind(sink);
  return needsUpgrade === undefined ? wrapped : { ...wrapped, needsUpgrade };
}

/**
 * Per KeyStore and device id, the creation of the demo's device identity in flight. Both demo vaults
 * open concurrently under the same device id and the KeyStore holds one identity per id, so the first
 * open creates it and the other one waits and loads the same identity (one device, several vaults, as
 * on a paired phone). Only the creation is shared; every call loads its own copy to wipe.
 */
const demoIdentityCreation = new WeakMap<crypto.KeyStore, Map<string, Promise<void>>>();

async function demoIdentity(deps: VaultEngineDeps): Promise<crypto.DeviceIdentity> {
  const { keyStore, sodium, device } = deps;
  let perStore = demoIdentityCreation.get(keyStore);
  if (perStore === undefined) {
    perStore = new Map();
    demoIdentityCreation.set(keyStore, perStore);
  }
  const creations = perStore;
  let creation = creations.get(device);
  if (creation === undefined) {
    creation = (async () => {
      // A blob the KeyStore cannot read (sealed under an earlier key) is replaced like a missing one.
      // Anything else (the Keychain did not answer) is thrown: replacing the identity the other demo
      // vault is bound to over a passing error would break that vault.
      const held = await crypto.loadDeviceIdentity(keyStore, device).catch((error: unknown) => {
        if (error instanceof crypto.CryptoError) return null;
        throw error;
      });
      if (held !== null) {
        held.wipe();
        return;
      }
      const fresh = crypto.createDeviceIdentity(sodium, device);
      try {
        await crypto.saveDeviceIdentity(keyStore, fresh);
      } finally {
        fresh.wipe();
      }
    })().finally(() => creations.delete(device));
    creations.set(device, creation);
  }
  await creation;
  const identity = await crypto.loadDeviceIdentity(keyStore, device);
  if (identity === null) throw new DeviceAuthorityRefusal("missing_authority");
  return identity;
}

/**
 * The demo's authority, created on the phone the first time its engine opens: a throwaway recovery
 * key (never shown), this device's identity (shared by both demo vaults, `demoIdentity`), a keyring
 * for the demo vault id, the log database with the creator certificate and own provenance. The
 * registry facts (`device.added`, the creator's pin) are written through the engine once it is open
 * (`finishDemo`).
 */
async function createDemoAuthority(deps: VaultEngineDeps): Promise<crypto.RecoveryIdentity> {
  const { sodium, vault, device } = deps;
  const recovery = crypto.createRecoveryIdentity(sodium);
  let identity: crypto.DeviceIdentity | undefined;
  let created: ReturnType<typeof crypto.createVaultWithRecovery> | undefined;
  try {
    identity = await demoIdentity(deps);
    created = crypto.createVaultWithRecovery(sodium, recovery, identity, vault);
    const ring = created.ring;
    const certificate = created.creatorCertificate;
    await crypto.saveKeyring(deps.keyStore, ring);
    createVaultLog(deps.log, {
      ring,
      device,
      kind: "demo",
      state: "pending",
      certificates: [certificate],
      registryEvents: [],
      provenance: (store) =>
        store.put({
          kid: ring.active.kid,
          generation: ring.active.generation,
          epoch: ring.active.epoch,
          sender: device,
          recipients: null,
          source: "own",
          receivedAt: deps.now(),
        }),
      now: deps.now,
    });
    return recovery;
  } catch (error) {
    recovery.wipe();
    throw error;
  } finally {
    identity?.wipe();
    created?.ring.wipe();
  }
}

/** The registry facts of a fresh demo vault: this device added by its certificate, and its pin. */
async function finishDemo(
  deps: VaultEngineDeps,
  engine: SyncEngine,
  candidate: DeviceAuthorityCandidate,
  recovery: crypto.RecoveryIdentity,
  certificate: Uint8Array,
): Promise<void> {
  const eid = () => mintUlid(deps.now(), (n) => deps.sodium.randomBytes(n));
  const identity = candidate.identity;
  const afterHlc = foldedHwm(deps.store);
  await engine.write(
    [
      devices.buildDeviceAdded(
        identity,
        deps.vault,
        eid(),
        {
          deviceId: deps.device,
          signPublicKey: identity.signPublicKey,
          boxPublicKey: identity.box.publicKey,
        },
        deps.demoDeviceName ?? "iPhone",
        certificate,
      ),
      devices.creatorPin(identity, recovery, deps.vault, eid(), deps.now()),
    ],
    afterHlc === undefined ? undefined : { afterHlc },
  );
  markVaultLogReady(deps.log);
}

function foldedHwm(store: Store): string | undefined {
  const hwm = store
    .read<{ hwm: string | null }>("SELECT MAX(hwm) AS hwm FROM materializer_state")
    .at(0)?.hwm;
  return hwm ? hwm.slice(0, 47) : undefined;
}

/** What one pass saw of this device's own segments at one remote. */
interface RemoteSight {
  listed: boolean;
  /** Own segment -> bytes the remote holds (from its list, raised by every own append that landed). */
  readonly own: Map<number, number>;
}

/**
 * `remote` as the engine uses it, with the pass's view of this device's own segments recorded: the
 * relay cursor comes from what the remote answered, not from the engine's summary of the pass.
 * `settled` runs after every call, so the session can keep the relay status of its own calls.
 */
function sighted(
  remote: Transport,
  device: string,
  sight: () => RemoteSight,
  settled: () => void,
): Transport {
  const raise = (seen: RemoteSight, seg: number, size: number) => {
    if (size > (seen.own.get(seg) ?? 0)) seen.own.set(seg, size);
  };
  const wrapped: Transport = {
    consistency: remote.consistency,
    async list(vault) {
      try {
        const segments = await remote.list(vault);
        const seen = sight();
        seen.listed = true;
        for (const s of segments) if (s.device === device) raise(seen, s.seg, s.size);
        return segments;
      } finally {
        settled();
      }
    },
    read: (vault, writer, seg, from) => remote.read(vault, writer, seg, from).finally(settled),
    async append(vault, writer, seg, atOffset, bytes) {
      try {
        await remote.append(vault, writer, seg, atOffset, bytes);
        if (writer === device) raise(sight(), seg, atOffset + bytes.length);
      } finally {
        settled();
      }
    },
  };
  const watch = remote.watch?.bind(remote);
  return watch === undefined ? wrapped : { ...wrapped, watch };
}

/** A durable result as the client sees it (the eids stay on the phone). */
function outcomeOf(result: DurableCommandResult<unknown>): DurableOutcome {
  switch (result.kind) {
    case "completed":
      return { kind: "completed", value: result.value };
    case "refused":
    case "not_started":
      return { kind: result.kind, reason: result.reason };
    default:
      return result.attemptId === undefined
        ? { kind: "outcome_unknown" }
        : { kind: "outcome_unknown", attemptId: result.attemptId };
  }
}

interface Opened {
  readonly engine: SyncEngine;
  /** The keyring as the KeyStore holds it (`ringFingerprint`): a pass saves it only when it changed. */
  saved: string;
  readonly local: SqlLogTransport;
  readonly candidate: DeviceAuthorityCandidate;
  readonly attempts: SqlCommandAttemptJournal<unknown>;
}

/**
 * What the KeyStore holds of a keyring, as far as a pass can change it: its key ids (a key never
 * changes once held) and the pinned recovery public keys. Public facts only.
 */
function ringFingerprint(ring: crypto.Keyring): string {
  const hex = (bytes: Uint8Array) =>
    Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  const kids = ring
    .entries()
    .map((entry) => entry.kid)
    .sort();
  const recovery = ring.recovery;
  return `${kids.join(",")}|${hex(recovery.boxPublicKey)}|${hex(recovery.signPublicKey)}`;
}

/** The engine's stuck records as the status carries them (no segment, offset or code). */
function stuckWriters(
  records: readonly StuckRecord[],
  candidate: DeviceAuthorityCandidate,
): VaultStuckWriter[] {
  const known = candidate.devices.registry.devices;
  return records.map((record) => {
    const name = known.get(record.device)?.name;
    return {
      device: record.device,
      ...(name === undefined ? {} : { name }),
      kind: record.kind,
      since: record.firstSeenAt,
    };
  });
}

/** This device is revoked in the vault (told apart from other authority refusals: `removed`). */
function revoked(candidate: DeviceAuthorityCandidate): boolean {
  return candidate.devices.registry.revoked.has(candidate.deviceId);
}

export function createVaultSession(deps: VaultEngineDeps): VaultSession {
  const { vault, device, store, queue } = deps;
  const listeners = new Set<() => void>();
  let status: VaultSyncStatus = {
    vault,
    phase: "opening",
    syncing: false,
    remote: deps.remotes.length > 0,
    unpushed: false,
  };
  let opened: Opened | undefined;
  let closed = false;
  /** Per remote, what the running pass saw of this device's own segments. */
  let sights: RemoteSight[] = deps.remotes.map(() => ({ listed: false, own: new Map() }));
  /**
   * The relay status as this vault's own calls left it: one transport serves every paired vault, so
   * reading its status at any time would show another vault's last call (a `forbidden` of one vault
   * marking every vault removed).
   */
  let relay: RelayStatus | undefined;
  const remotes = deps.remotes.map((remote, index) =>
    sighted(
      remote,
      device,
      () => sights[index] as RemoteSight,
      () => {
        if (deps.relayStatus) relay = deps.relayStatus();
      },
    ),
  );
  const set = (patch: Partial<VaultSyncStatus>, drop: readonly (keyof VaultSyncStatus)[] = []) => {
    const next: Record<string, unknown> = { ...status, ...patch };
    for (const key of drop) delete next[key];
    if (relay !== undefined) next.relay = relay;
    status = next as unknown as VaultSyncStatus;
    for (const listener of [...listeners]) listener();
  };
  const fail = (code: string) => {
    set({ phase: "failed", failure: code, syncing: false }, ["replay"]);
  };

  /** After a replay: ready, still receiving (no profile yet), removed, or throws (fail closed). */
  const settle = (candidate: DeviceAuthorityCandidate, recovery: LocalRecoveryResult) => {
    if (deps.kind === "paired") set({ names: vaultDeviceNames(candidate) });
    if (revoked(candidate)) {
      set({ phase: "removed" });
      return;
    }
    const profile = profileGid(store);
    if (profile === undefined && deps.kind === "paired" && recovery.complete) {
      set({ phase: "receiving" });
      return;
    }
    assertReplayedDeviceAuthority(candidate, recovery, profile);
    // Every rotation reason waits: the phone never rotates, so each one (a revocation, an untrusted
    // sender of the active key, a changed recovery key) is cleared only by another device's rotation,
    // which a later pass pulls. Commands are refused meanwhile; the gate still judges every pulled frame
    // on its own. What fails closed is an authority that does not check out (above).
    if (candidate.devices.rotationNeeded() !== undefined) {
      set({ phase: "waiting", failure: "rotation_pending" });
      return;
    }
    set({ phase: "ready" }, status.failure === "rotation_pending" ? ["failure"] : []);
  };

  const open = async (): Promise<void> => {
    let recovery: crypto.RecoveryIdentity | undefined;
    let candidate: DeviceAuthorityCandidate | undefined;
    let engine: SyncEngine | undefined;
    try {
      let bootstrap = readVaultBootstrap(deps.log);
      if (bootstrap === undefined && deps.kind === "demo") {
        recovery = await createDemoAuthority(deps);
        bootstrap = readVaultBootstrap(deps.log);
      }
      if (bootstrap === undefined) throw new Error("vault_log_missing");
      if (bootstrap.vault !== vault || bootstrap.device !== device || bootstrap.kind !== deps.kind)
        throw new Error("vault_log_mismatch");
      if (bootstrap.state !== "ready" && recovery === undefined)
        throw new Error("vault_log_incomplete");
      const attempts = SqlCommandAttemptJournal.open<unknown>(
        deps.log,
        "existing",
        "mobile_attempts",
        deps.now,
      );
      const ring = await crypto.loadKeyring(deps.keyStore, deps.sodium, vault);
      if (ring === null) throw new DeviceAuthorityRefusal("missing_authority");
      let provenance: SqlProvenanceStore;
      let saved: string;
      try {
        saved = ringFingerprint(ring);
        provenance = SqlProvenanceStore.open(deps.log, ring, "existing");
      } finally {
        ring.wipe();
      }
      candidate = await loadDeviceAuthority({
        vaultId: vault,
        deviceId: device,
        keyStore: deps.keyStore,
        sodium: deps.sodium,
        provenance,
        clock: deps.now,
        bootstrapCertificates: bootstrap.certificates,
      });
      if (bootstrap.registryEvents.length > 0) candidate.devices.ingest(bootstrap.registryEvents);
      const resetPending = deps.kind === "paired" && viewResetPending(deps.log);
      if (resetPending) resetView(store, device);
      if (deps.kind === "paired") ensureClockGuard(store, device);
      const local = new SqlLogTransport({ driver: deps.log, vault });
      const authority = candidate;
      engine = await createSyncEngine({
        vault,
        device,
        local,
        remotes,
        codec: createOwnLogCodec({
          sodium: deps.sodium,
          ring: authority.ring,
          signer: authority.identity,
        }),
        gate: authority.gate,
        sink: yieldingSink(store.sink(), deps.yieldToUi, (events) => {
          const progress = status.progress;
          if (progress !== undefined)
            set({ progress: { ...progress, applied: progress.applied + events } });
        }),
        clockStore: metaClockStore(store.driver, device),
        // Every view has its guard by now (the demo's is seeded with its fixture, a paired one above);
        // a demo view from before the guard was seeded opens without one.
        ...(hasGuard(store, device)
          ? { clockGuard: metaClockGuardStore(store.driver, device) }
          : {}),
        gateState: metaGateStateStore(store.driver, device),
        physicalClock: { now: deps.now },
        gossipEid: () => mintUlid(deps.now(), (n) => deps.sodium.randomBytes(n)),
        maxBatchEvents: MAX_BATCH_EVENTS,
        // B2: an open (and the replay after a pass) verifies only the frames after the last audited
        // point. The checkpoint lives in this vault's log database, the same SQLCipher file and trust
        // boundary as the frames it vouches for, and is signed by this device on top; the engine checks
        // it against the log's chains and discards it on any doubt (full replay). Frames that arrive
        // from the relay are verified in full before they enter the log, whatever it holds.
        recoveryCheckpoint: {
          store: new SqlRecoveryCheckpointStore(deps.log, device),
          binding: () => ringFingerprint(authority.ring),
          sign: (body) => authority.identity.sign("cashu/checkpoint/v1", body),
          verify: (body, signature) =>
            crypto.verifyContextSignature(
              "cashu/checkpoint/v1",
              body,
              signature,
              authority.identity.signPublicKey,
            ),
        },
        // Hermes has one JS thread: long local work yields a macrotask about every 8 ms.
        yieldToHost: { run: deps.yieldToUi },
        onRecoveryProgress: (replay) => set({ replay }),
      });
      if (recovery !== undefined) {
        const certificate = bootstrap.certificates[0];
        if (certificate === undefined) throw new Error("vault_log_incomplete");
        await finishDemo(deps, engine, authority, recovery, certificate);
      }
      const recovered = await engine.recoverLocal();
      set({}, ["replay"]);
      if (resetPending) clearViewReset(deps.log);
      opened = { engine, local, candidate: authority, attempts, saved };
      // Own bytes the relay has not acknowledged (a kill after a command, a pass that never pushed).
      if (deps.remotes.length > 0)
        set({ unpushed: await ownUnpushed(local, vault, device, readRelayCursor(deps.log)) });
      settle(authority, recovered);
    } catch (error) {
      await engine?.close().catch(() => undefined);
      candidate?.close();
      opened = undefined;
      // A demo whose authority does not check out (its keys gone, or bound to an identity another demo
      // vault overwrote before the identity was shared) is built again on the next launch: only
      // `openDemoVaults` at boot rebuilds, so a `retry` meanwhile fails with `vault_log_incomplete`.
      if (deps.kind === "demo" && error instanceof DeviceAuthorityRefusal) {
        try {
          markVaultLogPending(deps.log);
        } catch {
          // The failure below is the one to report.
        }
      }
      fail(error instanceof DeviceAuthorityRefusal ? error.code : codeOf(error));
    } finally {
      recovery?.wipe();
    }
  };

  let openedPromise = queue.run(vault, open).catch(() => fail("vault_queue_closed"));

  /** Close what a failed pass left open (its engine and authority), then open again. */
  const reopen = async (): Promise<void> => {
    const stale = opened;
    opened = undefined;
    if (stale !== undefined) {
      await stale.engine.close().catch(() => undefined);
      stale.candidate.close();
    }
    if (closed) {
      fail("vault_closed");
      return;
    }
    await open();
  };

  const session = (current: Opened) => ({
    vault,
    device,
    store,
    engine: current.engine,
    clock: { now: deps.now },
    lease: { isHolder: () => current.candidate.devices.lease.holder === device },
    attempts: current.attempts,
    queue,
    isCurrent: () => !closed && opened === current && status.phase === "ready",
    newAttemptId: () => mintUlid(deps.now(), (n) => deps.sodium.randomBytes(n)),
  });

  const runPass = async (mode: "full" | "push"): Promise<SyncResult | undefined> => {
    const current = opened;
    if (closed || current === undefined) return undefined;
    if (status.phase !== "ready" && status.phase !== "receiving" && status.phase !== "waiting")
      return undefined;
    if (mode === "push" && !status.unpushed) return undefined;
    if (deps.remotes.length === 0) return undefined;
    const first = status.phase === "receiving";
    set({ syncing: true, ...(first ? { progress: { applied: 0, expected: 0 } } : {}) });
    try {
      if (first) set({ progress: { applied: 0, expected: await expectedEvents() } });
      sights = deps.remotes.map(() => ({ listed: false, own: new Map() }));
      const startedAt = deps.now();
      const result = await current.engine.sync();
      if (result.rolledBack) throw new Error("vault_rolled_back");
      // A pass that brought anything is replayed and checked like the open (fail closed).
      if (first || result.pulledFrames > 0 || result.applied > 0 || result.rebuilt) {
        const recovered = await current.engine.recoverLocal();
        set({}, ["replay"]);
        settle(current.candidate, recovered);
        // Only a ring that gained a key or a recovery pin is written (each write is a window for a
        // kill mid-write; the KeyStore's replace is atomic, `platform/keystore.ts`).
        const fingerprint = ringFingerprint(current.candidate.ring);
        if (fingerprint !== current.saved) {
          await crypto.saveKeyring(deps.keyStore, current.candidate.ring);
          current.saved = fingerprint;
        }
      } else if (revoked(current.candidate)) {
        set({ phase: "removed" });
      }
      // The relay cursor moves only on what every remote answered in this pass.
      let cursor = readRelayCursor(deps.log);
      if (sights.every((sight) => sight.listed)) {
        const segs = new Set(sights.flatMap((sight) => [...sight.own.keys()]));
        const next = new Map<number, number>();
        for (const seg of segs)
          next.set(seg, Math.min(...sights.map((sight) => sight.own.get(seg) ?? 0)));
        saveRelayCursor(deps.log, next);
        cursor = next;
      }
      const unpushed = await ownUnpushed(current.local, vault, device, cursor);
      const reached = result.offlineRemotes === 0;
      // Fresh only when every remote was pulled and the own tail is there too (as the engine counts it).
      const fresh =
        reached &&
        sights.every((sight) => sight.listed) &&
        !unpushed &&
        !result.pushPending &&
        !result.needsUpgrade;
      const stuck = stuckWriters(result.stuck, current.candidate);
      set(
        {
          syncing: false,
          unpushed,
          ...(fresh ? { lastPullAt: startedAt } : {}),
          ...(reached ? {} : { failure: "relay_unreachable" }),
          ...(stuck.length > 0 ? { stuck } : {}),
        },
        // A waiting vault keeps naming why it waits.
        [
          "progress",
          ...(reached && status.phase !== "waiting" ? (["failure"] as const) : []),
          ...(stuck.length > 0 ? [] : (["stuck"] as const)),
        ],
      );
      return result;
    } catch (error) {
      if (error instanceof DeviceAuthorityRefusal && revoked(current.candidate)) {
        set({ phase: "removed", syncing: false }, ["progress"]);
        return undefined;
      }
      fail(error instanceof DeviceAuthorityRefusal ? error.code : codeOf(error));
      set({}, ["progress"]);
      return undefined;
    }
  };

  /** The first sync's size: every foreign segment byte at the remotes, at ~50 B per event. */
  const expectedEvents = async (): Promise<number> => {
    let bytes = 0;
    for (const remote of deps.remotes) {
      try {
        for (const segment of await remote.list(vault)) {
          if (segment.device !== device) bytes += segment.size;
        }
      } catch {
        // Unknown size: the progress shows applied events only.
      }
    }
    return Math.ceil(bytes / BYTES_PER_EVENT);
  };

  return {
    vault,
    device,
    store,
    get opened() {
      return openedPromise.then(() => undefined);
    },
    retry() {
      if (closed || status.phase !== "failed") return;
      set({ phase: "opening", syncing: false }, ["failure", "progress"]);
      openedPromise = queue.run(vault, reopen).catch(() => fail("vault_queue_closed"));
    },
    status: () => status,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async execute(command, input, key) {
      await openedPromise;
      const current = opened;
      if (current === undefined || closed)
        return { kind: "not_started", reason: "vault_unavailable" };
      if (status.phase === "receiving") return { kind: "not_started", reason: "vault_receiving" };
      if (status.phase !== "ready") return { kind: "not_started", reason: "vault_unavailable" };
      const result = await executeDurableCommand(session(current), command, input, key);
      if (result.kind === "completed" || result.kind === "outcome_unknown") {
        if (deps.remotes.length > 0 && !status.unpushed) set({ unpushed: true });
      }
      return outcomeOf(result);
    },
    async reconcile(key) {
      await openedPromise;
      const current = opened;
      if (current === undefined) return { kind: "outcome_unknown" };
      const lookup = await current.attempts.lookup(vault, key);
      switch (lookup.phase) {
        case "absent":
          return { kind: "not_started", reason: "attempt_missing" };
        case "terminal":
          return lookup.result;
        case "completed":
          return lookup.receipt === undefined
            ? { kind: "outcome_unknown", attemptId: lookup.attemptId }
            : { kind: "completed", value: lookup.receipt.value };
        default:
          return { kind: "outcome_unknown", attemptId: lookup.attemptId };
      }
    },
    pass(mode) {
      if (closed) return Promise.resolve(undefined);
      return queue.run(vault, () => runPass(mode)).catch(() => undefined);
    },
    async close() {
      if (closed) return;
      closed = true;
      await openedPromise;
      const shut = async () => {
        const current = opened;
        opened = undefined;
        if (current === undefined) return;
        try {
          await current.engine.close();
        } finally {
          current.candidate.close();
        }
      };
      // After the queued pass or command of this vault, never under it; a closed queue ran its last.
      await queue.run(vault, shut).catch(shut);
    },
  };
}

/** A value-free code for a failure (an Error's message is a code everywhere in the stack). */
function codeOf(error: unknown): string {
  if (error instanceof Error && /^[a-z0-9_-]{1,64}$/u.test(error.message)) return error.message;
  return "vault_open_failed";
}
