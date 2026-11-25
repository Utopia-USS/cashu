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
// Hermes runs everything on one JS thread: the sink takes at most `MAX_BATCH_EVENTS` events per
// transaction (the engine cuts its calls there, the sink wrapper cuts a larger frame group into parts)
// and the wrapper yields a macrotask before each one, so a long first sync leaves frames to the UI,
// its saving step counts up per transaction. Live queries refresh once per engine call: the parts of a
// split frame group but the last apply with `deriveLater` (no derivation, no notification), so mounted
// queries keep their last result until the group's last part commits and refreshes them.
//
// Before this vault's copy is deleted (`leave`), a paired vault writes this device's `device.left`
// statement and tries one push, its relay calls ending by the caller's deadline (best effort: the
// statement is informational, the owner still removes the device with the recovery words).

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
  type ApplyOutcome,
  createOwnLogCodec,
  createSyncEngine,
  crypto,
  devices,
  type EventSink,
  type FrameCodec,
  type InboundBatch,
  type LocalRecoveryResult,
  type RelayStatus,
  type SegmentCursor,
  type SegmentInfo,
  START_CURSOR,
  type StuckKind,
  type StuckRecord,
  type SyncEngine,
  type SyncResult,
  type Transport,
  TransportError,
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

/** The view store's sink (`deriveLater` for all but the last transaction of a split frame group). */
type ViewSink = ReturnType<Store["sink"]>;

/** Events per sink transaction on the phone (the engine default is 25,000: one long JS-thread block). */
const MAX_BATCH_EVENTS = 1500;

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
  /** The first sync's progress while its pass runs (`FirstSyncProgress`). */
  readonly progress?: FirstSyncProgress;
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

/**
 * The first sync's progress, counted exactly (never an estimate): `done` of `total` bytes of the other
 * devices' data segments the relay listed when the pass started. `receiving`: bytes that arrived and
 * verified (the local log's earlier bytes included); `saving`: bytes whose events are in the view, with
 * `events` saved by this pass. The replay check after it is `VaultSyncStatus.replay`.
 */
interface FirstSyncProgress {
  readonly phase: "receiving" | "saving";
  readonly done: number;
  readonly total: number;
  readonly events: number;
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

/** What `VaultSession.leave` did. */
type LeaveOutcome = "pushed" | "written" | "skipped";

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
  /**
   * Before this vault's copy is deleted: write this device's `device.left` statement (a paired vault
   * with a relay that is `ready` or `receiving`; never the demo) and try ONE push. The call abandons
   * the relay calls a running pass is waiting on (so the queue frees up at once), and every later relay
   * call of this session ends by `deadline` (epoch ms on `now`) as an outage. The session is meant to be
   * closed next. Never rejects: `pushed` (the relay holds the statement), `written` (only the local
   * log does), `skipped` (nothing written).
   */
  leave(deadline: number): Promise<LeaveOutcome>;
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

/**
 * The sink wrapper: at most `maxEvents` events per sink transaction, a macrotask before each one, and
 * the applied foreign batches reported after each one.
 *
 * The engine already cuts a pass into calls of at most `maxBatchEvents` events, but never inside one
 * batch: a frame group (one command, e.g. a 20,000-row import) arrives as ONE batch and was applied in
 * one long transaction with no yield and no progress (the real run: "Saving ... 359 changes" frozen
 * for 20 s on a 2.3 MB segment). Such a batch is applied here in parts of at most `maxEvents` events,
 * each in its own transaction. Every part but the last persists the stream's cursor as the sink held
 * it BEFORE the batch (the previous batch of the device in this call, else the sink's own, else the
 * stream start): a kill between parts leaves events in the view whose frames the cursor has not
 * passed, so the engine delivers the whole batch again and the parts already held count as duplicates
 * (idempotent by eid; the view is a function of the held event set). Only the last part moves the
 * cursor past the batch. Every transaction of a split call but the last applies with `deriveLater`:
 * the store keeps the dirty partitions with that transaction and the last one derives them all, so the
 * derivers still run once per call (once per transaction cost a 20,000-row first sync 2.7 s more on
 * V8, vaultEngine.firstsync.measure.test.ts); a kill in between leaves the owed derivation to the next
 * apply or open. The outcome of a split batch is the sum of its parts'.
 */
export function yieldingSink(
  sink: ViewSink,
  yieldToUi: () => Promise<void>,
  onForeignApplied: (batches: readonly InboundBatch[], applied: number) => void,
  maxEvents: number = MAX_BATCH_EVENTS,
): EventSink {
  const apply = async (
    part: readonly InboundBatch[],
    deriveLater = false,
  ): Promise<readonly ApplyOutcome[]> => {
    await yieldToUi();
    const outcome = await sink.applyBatches(part, deriveLater ? { deriveLater } : undefined);
    const foreign = part.filter((b) => !b.own && b.events.length > 0);
    let applied = 0;
    for (const [i, b] of part.entries()) if (!b.own) applied += outcome[i]?.applied ?? 0;
    if (foreign.length > 0) onForeignApplied(foreign, applied);
    return outcome;
  };
  const wrapped: EventSink = {
    cursors: () => sink.cursors(),
    async applyBatches(batches: readonly InboundBatch[]) {
      if (batches.every((b) => b.events.length <= maxEvents)) {
        const total = batches.reduce((n, b) => n + b.events.length, 0);
        if (total <= maxEvents) return apply(batches);
      }
      // Parts of at most `maxEvents` events, in order; `of` = the index of the batch a part belongs to.
      const held = new Map(await sink.cursors());
      const parts: { batch: InboundBatch; of: number }[] = [];
      for (const [of, batch] of batches.entries()) {
        const before = held.get(batch.device) ?? START_CURSOR;
        for (let at = 0; at < batch.events.length || at === 0; at += maxEvents) {
          const end = Math.min(at + maxEvents, batch.events.length);
          const last = end >= batch.events.length;
          parts.push({
            batch: {
              ...batch,
              events: batch.events.slice(at, end),
              cursor: last ? batch.cursor : before,
            },
            of,
          });
          if (last) break;
        }
        held.set(batch.device, batch.cursor);
      }
      const sums = batches.map(() => ({ applied: 0, duplicates: 0, parked: 0 }));
      let chunk: typeof parts = [];
      let events = 0;
      const flush = async (last: boolean) => {
        if (chunk.length === 0) return;
        const outcome = await apply(
          chunk.map((p) => p.batch),
          !last,
        );
        for (const [i, p] of chunk.entries()) {
          const sum = sums[p.of] as { applied: number; duplicates: number; parked: number };
          sum.applied += outcome[i]?.applied ?? 0;
          sum.duplicates += outcome[i]?.duplicates ?? 0;
          sum.parked += outcome[i]?.parked ?? 0;
        }
        chunk = [];
        events = 0;
      };
      for (const part of parts) {
        if (chunk.length > 0 && events + part.batch.events.length > maxEvents) await flush(false);
        chunk.push(part);
        events += part.batch.events.length;
      }
      await flush(true);
      return sums;
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

/**
 * The relay calls of a leaving session (`leave`): `cut()` abandons every call running at that moment
 * (they belong to a pass whose result no longer matters) and `endBy(deadline)` makes every later call
 * end by `deadline` (epoch ms on `now`): refused after it, abandoned at it. Both as a transport outage,
 * so the engine counts the remote offline and finishes its pass. An abandoned call may still land on
 * the relay later; the session is closed after a leave and the copy deleted, so nothing relies on it.
 */
class RelayDeadline {
  #by: number | undefined;
  readonly #running = new Set<(error: TransportError) => void>();
  readonly #now: () => number;
  constructor(now: () => number) {
    this.#now = now;
  }

  cut(): void {
    for (const abandon of [...this.#running]) abandon(leaveDeadline());
  }

  endBy(deadline: number): void {
    this.#by = Math.min(this.#by ?? deadline, deadline);
  }

  wrap(remote: Transport): Transport {
    const bounded = <T>(call: () => Promise<T>): Promise<T> => {
      const by = this.#by;
      if (by !== undefined && by <= this.#now()) return Promise.reject(leaveDeadline());
      let abandon: ((error: TransportError) => void) | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const abandoned = new Promise<never>((_, reject) => {
        abandon = reject;
      });
      const entry = abandon as (error: TransportError) => void;
      this.#running.add(entry);
      if (by !== undefined) timer = setTimeout(() => entry(leaveDeadline()), by - this.#now());
      return Promise.race([call(), abandoned]).finally(() => {
        clearTimeout(timer);
        this.#running.delete(entry);
      });
    };
    const wrapped: Transport = {
      consistency: remote.consistency,
      list: (vault) => bounded(() => remote.list(vault)),
      read: (vault, writer, seg, from) => bounded(() => remote.read(vault, writer, seg, from)),
      append: (vault, writer, seg, atOffset, bytes) =>
        bounded(() => remote.append(vault, writer, seg, atOffset, bytes)),
    };
    const watch = remote.watch?.bind(remote);
    return watch === undefined ? wrapped : { ...wrapped, watch };
  }
}

function leaveDeadline(): TransportError {
  return new TransportError("unavailable", "leave_deadline", "outage");
}

/**
 * The first sync's exact counts (`FirstSyncProgress`), per other device and data segment: the bytes
 * the relay listed, the end of the last frame that arrived and verified, and the view's cursor.
 */
class FirstSyncTracker {
  readonly #listed = new Map<string, Map<number, number>>();
  readonly #received = new Map<string, Map<number, number>>();
  readonly #cursors = new Map<string, SegmentCursor>();
  readonly total: number;
  phase: FirstSyncProgress["phase"] = "receiving";
  events = 0;

  constructor(
    listed: readonly SegmentInfo[],
    local: readonly SegmentInfo[],
    cursors: ReadonlyMap<string, SegmentCursor>,
  ) {
    let total = 0;
    for (const s of listed) {
      put(this.#listed, s.device, s.seg, s.size);
      total += s.size;
    }
    this.total = total;
    for (const s of local) {
      const listedSize = this.#listed.get(s.device)?.get(s.seg);
      if (listedSize !== undefined)
        put(this.#received, s.device, s.seg, Math.min(s.size, listedSize));
    }
    for (const [device, cursor] of cursors) this.#cursors.set(device, cursor);
  }

  /** A frame of `device` ending at `seg:end` arrived and verified (or was opened again). */
  verified(device: string, seg: number, end: number): boolean {
    const listed = this.#listed.get(device)?.get(seg);
    if (listed === undefined) return false;
    const before = this.#received.get(device)?.get(seg) ?? 0;
    if (end <= before) return false;
    put(this.#received, device, seg, Math.min(end, listed));
    this.phase = "receiving";
    return true;
  }

  /** Foreign batches reached the view, `events` of their events new to it. */
  applied(batches: readonly InboundBatch[], events: number): void {
    for (const batch of batches) this.#cursors.set(batch.device, batch.cursor);
    this.events += events;
    this.phase = "saving";
  }

  progress(): FirstSyncProgress {
    let done = 0;
    if (this.phase === "receiving") {
      for (const segments of this.#received.values())
        for (const size of segments.values()) done += size;
    } else {
      for (const [device, segments] of this.#listed) {
        const cursor = this.#cursors.get(device);
        if (cursor === undefined) continue;
        for (const [seg, size] of segments) {
          if (seg < cursor.seg) done += size;
          else if (seg === cursor.seg) done += Math.min(cursor.offset, size);
        }
      }
    }
    return {
      phase: this.phase,
      done: Math.min(done, this.total),
      total: this.total,
      events: this.events,
    };
  }
}

function put(
  map: Map<string, Map<number, number>>,
  device: string,
  seg: number,
  size: number,
): void {
  let segments = map.get(device);
  if (segments === undefined) {
    segments = new Map();
    map.set(device, segments);
  }
  segments.set(seg, size);
}

/** `codec` with every opened frame of another device's data stream reported (`FirstSyncTracker`). */
function reportingCodec(
  codec: FrameCodec,
  device: string,
  onOpened: (writer: string, seg: number, end: number) => void,
): FrameCodec {
  return {
    seal: (plain, at, prev) => codec.seal(plain, at, prev),
    async open(sealed, at, prev) {
      const opened = await codec.open(sealed, at, prev);
      const head = opened.head;
      if (head.stream === 1 && head.device !== device && head.seg >= 1)
        onOpened(head.device, head.seg, head.offset);
      return opened;
    },
    link: (sealed, at, prev) => codec.link(sealed, at, prev),
    genesis: (vault, writer, stream) => codec.genesis(vault, writer, stream),
  };
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
  /** The running first sync's counts (a pass of a `receiving` vault); undefined otherwise. */
  let firstSync: FirstSyncTracker | undefined;
  /** Per remote, what the running pass saw of this device's own segments. */
  let sights: RemoteSight[] = deps.remotes.map(() => ({ listed: false, own: new Map() }));
  /**
   * The relay status as this vault's own calls left it: one transport serves every paired vault, so
   * reading its status at any time would show another vault's last call (a `forbidden` of one vault
   * marking every vault removed).
   */
  let relay: RelayStatus | undefined;
  /** Bounds this session's relay calls once `leave` was called. */
  const relayDeadline = new RelayDeadline(deps.now);
  const remotes = deps.remotes.map((remote, index) =>
    sighted(
      relayDeadline.wrap(remote),
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
        codec: reportingCodec(
          createOwnLogCodec({
            sodium: deps.sodium,
            ring: authority.ring,
            signer: authority.identity,
          }),
          device,
          (writer, seg, end) => {
            if (firstSync?.verified(writer, seg, end)) set({ progress: firstSync.progress() });
          },
        ),
        gate: authority.gate,
        sink: yieldingSink(store.sink(), deps.yieldToUi, (batches, events) => {
          if (firstSync === undefined) return;
          firstSync.applied(batches, events);
          set({ progress: firstSync.progress() });
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
    set({ syncing: true });
    try {
      if (first) {
        firstSync = await firstSyncTracker(current.local);
        set({ progress: firstSync.progress() });
      }
      sights = deps.remotes.map(() => ({ listed: false, own: new Map() }));
      const startedAt = deps.now();
      const result = await current.engine.sync();
      if (result.rolledBack) throw new Error("vault_rolled_back");
      // A pass that brought anything is replayed and checked like the open (fail closed).
      if (first || result.pulledFrames > 0 || result.applied > 0 || result.rebuilt) {
        const recovered = await current.engine.recoverLocal();
        // The first sync's last step was the check: its counts end with it.
        set({}, first ? ["replay", "progress"] : ["replay"]);
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
      firstSync = undefined;
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
      firstSync = undefined;
      if (error instanceof DeviceAuthorityRefusal && revoked(current.candidate)) {
        set({ phase: "removed", syncing: false }, ["progress"]);
        return undefined;
      }
      fail(error instanceof DeviceAuthorityRefusal ? error.code : codeOf(error));
      set({}, ["progress"]);
      return undefined;
    }
  };

  /**
   * The first sync's counts from what the remotes list (other devices' data segments, the largest size
   * any remote lists), the local log and the view's cursors. A remote that does not answer lists
   * nothing: the total is 0 and the screen says it waits.
   */
  const firstSyncTracker = async (local: SqlLogTransport): Promise<FirstSyncTracker> => {
    const largest = new Map<string, SegmentInfo>();
    for (const remote of deps.remotes) {
      try {
        for (const segment of await remote.list(vault)) {
          if (segment.device === device || segment.seg < 1) continue;
          const key = `${segment.device}/${segment.seg}`;
          if (segment.size > (largest.get(key)?.size ?? 0)) largest.set(key, segment);
        }
      } catch {
        // Unknown size (see above).
      }
    }
    const held = (await local.list(vault)).filter((s) => s.device !== device && s.seg >= 1);
    return new FirstSyncTracker([...largest.values()], held, await store.sink().cursors());
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
    async leave(by) {
      if (closed || deps.kind !== "paired" || deps.remotes.length === 0) return "skipped";
      // A pass holding the queue on the relay is cut now (its result no longer matters), and every
      // relay call from here on ends by the deadline: the queue frees up for the statement at once.
      relayDeadline.cut();
      relayDeadline.endBy(by);
      let wrote = false;
      const note = async (): Promise<LeaveOutcome> => {
        const current = opened;
        if (closed || current === undefined) return "skipped";
        // A revoked, waiting or failed vault writes nothing: the owner removes it anyway, and a waiting
        // vault refuses own writes until another device rotates.
        if (status.phase !== "ready" && status.phase !== "receiving") return "skipped";
        if (current.engine.writeAdmission() !== "ready") return "skipped";
        if (deps.now() >= by) return "skipped";
        await current.engine.write([
          devices.buildDeviceLeft(
            current.candidate.identity,
            vault,
            mintUlid(deps.now(), (n) => deps.sodium.randomBytes(n)),
            deps.now(),
          ),
        ]);
        wrote = true;
        set({ unpushed: true });
        const result = await runPass("push");
        return result !== undefined && !status.unpushed ? "pushed" : "written";
      };
      return queue.run(vault, note).catch((): LeaveOutcome => (wrote ? "written" : "skipped"));
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
