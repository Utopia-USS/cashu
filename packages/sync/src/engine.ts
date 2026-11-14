// The own-log sync engine: one per (vault, device). See carrier.ts for the model.
//
// Invariants
// - Writes: stamp (HLC) -> persist the clock -> seal every frame -> append to the own local segment ->
//   apply from the local log through the same path as remote frames. The clock is saved before the
//   append, so a persisted clock behind the device's own log means a rollback (events.md 3.2).
// - Atomic writes (S29c-B3): every frame of one write lands in ONE segment through ONE append (the
//   transport's append is all or nothing), so a crash never leaves part of a frame group in the
//   device's stream, where it would stop that stream for good. The segment cap is soft: a write
//   starts a new segment when it would cross the cap, and a write larger than the cap fills one.
// - Pull: a foreign frame enters the local log only after the codec opened it and the gate verified
//   its signed head (S29c phase B2), so the local copy never holds a tampered or forged frame; a
//   rejected frame, or one whose writer is not known yet, is retried from the remote on the next pass
//   (and in the same pass once the registry changed).
// - Chains: every frame links to its writer's previous frame (crypto/head.ts). The engine keeps the
//   chain after every frame of its local log (rebuilt from the bytes at start, no decryption) and
//   passes the previous one to the codec, so a reordered, spliced or rewritten stream never verifies.
// - Apply: per device stream in segment order, one batch per frame or per complete frame group,
//   cursor persisted by the sink with the batch, data only when the gate accepts it (cut, fork
//   freeze). The batches of a pass reach the sink in ONE `applyBatches` transaction (S29c-B3),
//   chunked at `maxBatchEvents` / `maxBatchBytes` so a first sync stays within phone memory; a sink
//   failure applies nothing, and the next pass re-delivers. A partial frame or an incomplete group leaves the cursor where it is; a rejected frame
//   stops that device's stream for this pass only. The gate sees every verified frame's statements
//   (the first apply after start replays the whole local log into a gate with statement state:
//   every frame's statements first, then data judged from the start without re-delivering it).
// - D8: when the gate reports that data the view holds is no longer accepted, the pass ends with a
//   full rebuild (sink reset, gate reset, replay).
// - Gate snapshot (S29c-B3): with a `gateState` store and a gate that exports its state, every sync
//   pass that judged new frames saves the gate's state with the head of the last accepted frame per
//   writer. After a restart the engine checks the snapshot (the gate authenticates it; the engine
//   finds each head's frame in the local log, with the same chain and signature) and replays only
//   the frames after those heads; a snapshot that fails any check is ignored (full replay).
// - Every public operation runs serialized on one queue.

import { blake2b } from "@noble/hashes/blake2.js";
import { ownBatchDigest } from "./batchProof.js";
import type {
  AppliedInfo,
  ClockGuardStore,
  ClockStore,
  DeviceId,
  EventSink,
  FrameCodec,
  FrameGate,
  FrameHead,
  FramePosition,
  GateStateStore,
  HostYield,
  InboundBatch,
  LeaseTransport,
  LocalRecoveryResult,
  LocalStreamRecovery,
  PullHistory,
  PullStatus,
  RecoveryCheckpointOptions,
  RecoveryProgress,
  RejectedFrame,
  SegmentCursor,
  SegmentInfo,
  StuckKind,
  StuckRecord,
  SyncEngine,
  SyncResult,
  Transport,
  UnstampedEvent,
  VaultId,
  WireEvent,
  WriteOptions,
  WriteResult,
} from "./carrier.js";
import { propagationBound, START_CURSOR } from "./carrier.js";
import { decodeHead, encodeHead } from "./crypto/core.js";
import { fromHex, toHex } from "./crypto/encoding.js";
import {
  isTransportOutage,
  isTransportUnavailable,
  rejectionCode,
  SyncError,
  TransportError,
} from "./errors.js";
import {
  type ClockWarning,
  DEVICE_RE,
  HybridClock,
  type PhysicalClock,
  systemClock,
} from "./hlc.js";
import { queueTask, utf8Encode } from "./runtime.js";
import {
  concatBytes,
  DEFAULT_MAX_FRAME_BYTES,
  DEFAULT_MAX_FRAME_EVENTS,
  decodePayload,
  encodePayload,
  frameBytes,
  isRecord,
  LENGTH_BYTES,
  MAX_SEALED_FRAME_BYTES,
  scanFrames,
} from "./segment.js";

export const VAULT_RE = /^[0-9A-Za-z_-]{1,64}$/;

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

function comparePositions(a: SegmentCursor, b: SegmentCursor): number {
  return a.seg - b.seg || a.offset - b.offset;
}

export interface SyncEngineOptions {
  readonly vault: VaultId;
  readonly device: DeviceId;
  /** The device's own full copy of the log (always reachable; writes land here first). */
  readonly local: Transport;
  /** Replication targets: synced folder, relay. Empty = local only. */
  readonly remotes?: readonly Transport[];
  readonly codec: FrameCodec;
  /** Verifies signed heads and decides data acceptance (devices/gate.ts `DeviceFrameGate`). */
  readonly gate: FrameGate;
  /** Host-bound secure ULID source for one dedicated gossip event; absent disables emission. */
  readonly gossipEid?: () => string;
  readonly sink: EventSink;
  readonly clockStore: ClockStore;
  /** Native production supplies a durable, device-local verified foreign-clock guard. */
  readonly clockGuard?: ClockGuardStore;
  /** Where the gate's state snapshot is kept (absent: every start replays the whole local log). */
  readonly gateState?: GateStateStore;
  readonly physicalClock?: PhysicalClock;
  /** Drift limit for both clock guards (default 5 minutes, events.md 3.3). */
  readonly maxDriftMs?: number;
  /** Events per frame before a batch becomes a frame group (default 1000, as in the spike). */
  readonly maxFrameEvents?: number;
  /** Approximate plaintext bytes per frame before splitting (default 1 MiB). */
  readonly maxFrameBytes?: number;
  /** Soft segment size cap; a new segment starts when a frame would cross it (default 4 MiB). */
  readonly maxSegmentBytes?: number;
  /** Events per sink transaction before a pass is split into several (default 25 000, D12). */
  readonly maxBatchEvents?: number;
  /** Plaintext bytes per sink transaction before a pass is split into several (default 32 MiB). */
  readonly maxBatchBytes?: number;
  /**
   * Own sealed bytes one pass pushes at most, over all remotes (default 8 MiB, S6): a first push of a
   * large log ends the pass early with `pushPending` so the vault's queue is free between passes. At
   * least one frame is pushed per remote and pass, so a frame larger than the budget still moves.
   */
  readonly maxPushBytesPerPass?: number;
  /** The sync history the host persisted for this vault (`PullHistory`); absent: none known. */
  readonly pullHistory?: PullHistory;
  /**
   * The verified-prefix checkpoint of `recoverLocal` (carrier.ts `RecoveryCheckpointOptions`; the phone).
   * Absent (the hosts): every `recoverLocal` opens and verifies the whole local log, as before.
   */
  readonly recoveryCheckpoint?: RecoveryCheckpointOptions;
  /** Yield to the host between ~8 ms slices of local work (recovery, replay, pull). Absent: never. */
  readonly yieldToHost?: HostYield;
  /** `recoverLocal` progress (frames verified / to verify), reported at each yield and at the end. */
  readonly onRecoveryProgress?: (progress: RecoveryProgress) => void;
}

/** How one `#replicate` call ended for the own bytes: all there, an offset conflict, the budget. */
type Delivery = "delivered" | "conflict" | "budget";

/** S6: own bytes one pass pushes before it yields (`SyncResult.pushPending`). */
const DEFAULT_MAX_PUSH_BYTES_PER_PASS = 8 * 1024 * 1024;

/** D7: how a rejection code holds its writer's stream. */
export function stuckKind(code: string): StuckKind {
  if (code === "revoked_writer" || code === "forked") return "final";
  if (code === WRITER_UNKNOWN || code === "unknown_key") return "waiting";
  return "rejected";
}

function isStuckRecord(value: unknown): value is StuckRecord {
  if (!isRecord(value)) return false;
  const { device, seg, offset, code, kind, firstSeenAt, passes } = value;
  return (
    typeof device === "string" &&
    DEVICE_RE.test(device) &&
    Number.isSafeInteger(seg) &&
    Number.isSafeInteger(offset) &&
    typeof code === "string" &&
    code.length > 0 &&
    code.length <= 64 &&
    (kind === "waiting" || kind === "rejected" || kind === "final") &&
    Number.isSafeInteger(firstSeenAt) &&
    Number.isSafeInteger(passes) &&
    (passes as number) >= 1
  );
}

/** Parses the persisted stuck records; anything unreadable counts as none (they are re-found). */
function parseStuck(text: string | undefined): Map<DeviceId, StuckRecord> {
  const out = new Map<DeviceId, StuckRecord>();
  if (text === undefined) return out;
  try {
    const rows: unknown = JSON.parse(text);
    if (!Array.isArray(rows)) return out;
    for (const row of rows) if (isStuckRecord(row)) out.set(row.device, row);
  } catch {
    // A torn or foreign value: the next pass that meets the frame records it again.
  }
  return out;
}

/** D12 caps of one sink transaction: a daily pull is one transaction, a 64k first sync three. */
export const DEFAULT_MAX_BATCH_EVENTS = 25_000;
export const DEFAULT_MAX_BATCH_BYTES = 32 * 1024 * 1024;
/** Work between two yields to the host (`yieldToHost`), about one frame at 120 Hz. */
const DEFAULT_YIELD_SLICE_MS = 8;

// ---- recovery checkpoint (`recoveryCheckpoint`) ------------------------------------------------

/** Format of the checkpoint body (v2: `rules` and the evidence digest). */
const CHECKPOINT_VERSION = 2;

/**
 * Version of the rules that decide what the local log yields: frame acceptance (codec open, head and
 * certificate checks, `authenticate` / `accept`), the registry and lease fold, the guard's cuts and
 * fork freezes, payload and statement decoders and their caps. BUMP IT in the same change as any of
 * those rules: a recovery checkpoint vouches for its prefix only under the rules it was taken with,
 * so one written under another version is discarded and the next open replays every frame (once).
 */
export const SYNC_RULES_VERSION = 1;

const HEX32 = /^[0-9a-f]{64}$/;
const SIGNATURE_BYTES = 64;

/** Statement types after which a checkpoint is not trusted for the tail: registry and key changes. */
const AUTHORITY_TYPES: ReadonlySet<string> = new Set([
  "device.added",
  "device.revoked",
  "device.recoveryChanged",
  "device.keysRotated",
]);

interface CheckpointStream {
  readonly device: DeviceId;
  /** End of the last frame the checkpoint covers (START_CURSOR: none). */
  readonly end: SegmentCursor;
  /** The chain after that frame (the genesis chain for none). */
  readonly chain: Uint8Array;
  /** BLAKE2b-256 over the covered frames' signatures (the chain covers everything else). */
  readonly sigs: Uint8Array;
  /** The view's cursor of this writer when the checkpoint was taken. */
  readonly cursor: SegmentCursor;
  readonly suppressed: boolean;
}

interface Checkpoint {
  /** BLAKE2b-256 over the fork-evidence record (`evidenceDigest`), not only its size. */
  readonly evidence: Uint8Array;
  readonly gate: string;
  readonly streams: ReadonlyMap<DeviceId, CheckpointStream>;
}

/** `recoverLocal` with a checkpoint gave up: replay everything. `touched`: the gate holds its state. */
interface Fallback {
  readonly fallback: true;
  readonly touched: boolean;
}

function signatureOf(sealed: Uint8Array): Uint8Array {
  return sealed.subarray(Math.max(0, sealed.length - SIGNATURE_BYTES));
}

function signatureDigest(
  frames: readonly { readonly sealed: Uint8Array }[],
  count: number,
): Uint8Array {
  const h = blake2b.create({ dkLen: 32 });
  for (let i = 0; i < count; i++) {
    const frame = frames[i];
    if (frame) h.update(signatureOf(frame.sealed));
  }
  return h.digest();
}

/** BLAKE2b-256 over the evidence records, sorted, each length-prefixed (order does not matter). */
function evidenceDigest(records: readonly string[]): Uint8Array {
  const h = blake2b.create({ dkLen: 32 });
  for (const record of [...records].sort()) {
    const bytes = utf8Encode(record);
    const length = new Uint8Array(4);
    new DataView(length.buffer).setUint32(0, bytes.length);
    h.update(length);
    h.update(bytes);
  }
  return h.digest();
}

function sameCursor(a: SegmentCursor, b: SegmentCursor): boolean {
  return a.seg === b.seg && a.offset === b.offset;
}

function isCursor(value: unknown): value is SegmentCursor {
  return (
    isRecord(value) &&
    Number.isSafeInteger(value.seg) &&
    (value.seg as number) >= 1 &&
    Number.isSafeInteger(value.offset) &&
    (value.offset as number) >= 0
  );
}

/** The checkpoint body as signed JSON text; undefined for anything malformed. */
function decodeCheckpointBody(
  body: string,
  expected: { readonly vault: VaultId; readonly device: DeviceId; readonly binding: string },
): Checkpoint | undefined {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (
    !isRecord(value) ||
    value.v !== CHECKPOINT_VERSION ||
    value.vault !== expected.vault ||
    value.device !== expected.device ||
    value.rules !== SYNC_RULES_VERSION ||
    value.binding !== expected.binding ||
    typeof value.evidence !== "string" ||
    !HEX32.test(value.evidence) ||
    typeof value.gate !== "string" ||
    !Array.isArray(value.streams)
  )
    return undefined;
  const streams = new Map<DeviceId, CheckpointStream>();
  for (const entry of value.streams as unknown[]) {
    if (
      !isRecord(entry) ||
      typeof entry.device !== "string" ||
      !DEVICE_RE.test(entry.device) ||
      streams.has(entry.device) ||
      !isCursor(entry.end) ||
      !isCursor(entry.cursor) ||
      typeof entry.chain !== "string" ||
      !HEX32.test(entry.chain) ||
      typeof entry.sigs !== "string" ||
      !HEX32.test(entry.sigs) ||
      typeof entry.suppressed !== "boolean"
    )
      return undefined;
    streams.set(entry.device, {
      device: entry.device,
      end: { seg: entry.end.seg, offset: entry.end.offset },
      chain: fromHex(entry.chain),
      sigs: fromHex(entry.sigs),
      cursor: { seg: entry.cursor.seg, offset: entry.cursor.offset },
      suppressed: entry.suppressed,
    });
  }
  return { evidence: fromHex(value.evidence), gate: value.gate, streams };
}

export async function createSyncEngine(options: SyncEngineOptions): Promise<SyncEngine> {
  if (!VAULT_RE.test(options.vault)) throw new SyncError("invalid-config", "invalid vault id");
  if (!DEVICE_RE.test(options.device)) throw new SyncError("invalid-config", "invalid device id");
  const restored = await options.clockStore.load();
  const guard = options.clockGuard === undefined ? null : await options.clockGuard.load();
  const engine = new OwnLogEngine(options, restored, guard);
  await engine.init();
  return engine;
}

interface Opened {
  readonly plain: Uint8Array;
  readonly head: FrameHead;
}

interface ChainEntry {
  readonly seg: number;
  readonly end: number;
  readonly chain: Uint8Array;
}

interface RecoveryFrame {
  readonly at: FramePosition;
  readonly end: SegmentCursor;
  readonly sealed: Uint8Array;
  readonly size: number;
  readonly prev: Uint8Array;
  /** The chain after this frame (hash only, from the bytes). */
  readonly after: Uint8Array;
  opened?: Opened;
  events?: readonly WireEvent[];
  part?: readonly [number, number];
}

interface RecoveryStream {
  readonly device: DeviceId;
  readonly frames: RecoveryFrame[];
  heldEnd: SegmentCursor;
  inspectedThrough: SegmentCursor;
  reason?: string;
  suppressed: boolean;
  parked: boolean;
  accepted: boolean;
}

/** Rounds of pull + apply in one `sync()` while the registry changes and streams wait. */
const MAX_ROUNDS = 4;

interface Pass {
  gossipEmitted: boolean;
  cache: Map<string, Opened>;
  /** A stream waited for its writer to become known. */
  waited: boolean;
  /** The gate's registry changed while applying. */
  gateChanged: boolean;
  /** A frame whose data the view already holds no longer verifies or is no longer accepted. */
  staleView: boolean;
  rebuilt: boolean;
  pushedBytes: number;
  pulledFrames: number;
  batches: number;
  applied: number;
  duplicates: number;
  parked: number;
  parkedDevices: Set<DeviceId>;
  needsUpgrade: boolean;
  offlineRemotes: number;
  /** Own bytes still to push after the push budget ran out (S6). */
  pushPending: boolean;
  rejected: RejectedFrame[];
  warnings: Map<DeviceId, ClockWarning>;
  types: Set<string>;
  clockDirty: boolean;
  rolledBack: boolean;
  /** Batches collected for the next sink transaction, their events and plaintext bytes. */
  pending: InboundBatch[];
  pendingEvents: number;
  pendingBytes: number;
}

function newPass(): Pass {
  return {
    gossipEmitted: false,
    cache: new Map(),
    waited: false,
    gateChanged: false,
    staleView: false,
    rebuilt: false,
    pushedBytes: 0,
    pulledFrames: 0,
    batches: 0,
    applied: 0,
    duplicates: 0,
    parked: 0,
    parkedDevices: new Set(),
    needsUpgrade: false,
    offlineRemotes: 0,
    pushPending: false,
    rejected: [],
    warnings: new Map(),
    types: new Set(),
    clockDirty: false,
    rolledBack: false,
    pending: [],
    pendingEvents: 0,
    pendingBytes: 0,
  };
}

/** Runtime check of `write` input (callers may be untyped: bridge, scripts). */
function isUnstampedEvent(e: unknown): e is UnstampedEvent {
  return (
    isRecord(e) &&
    typeof e.t === "string" &&
    e.t.length > 0 &&
    typeof e.v === "number" &&
    Number.isSafeInteger(e.v) &&
    e.v >= 1 &&
    typeof e.i === "string" &&
    e.i.length > 0 &&
    isRecord(e.d) &&
    !("h" in e)
  );
}

const WRITER_UNKNOWN = "writer-unknown";

function posKey(p: FramePosition): string {
  return `${p.device}/${p.seg}/${p.offset}`;
}

function bySegment(a: SegmentInfo, b: SegmentInfo): number {
  return a.device < b.device ? -1 : a.device > b.device ? 1 : a.seg - b.seg;
}

class OwnLogEngine implements SyncEngine {
  readonly vault: VaultId;
  readonly device: DeviceId;
  readonly #local: Transport;
  readonly #remotes: readonly Transport[];
  readonly #codec: FrameCodec;
  readonly #gate: FrameGate;
  readonly #gossipEid: (() => string) | undefined;
  readonly #sink: EventSink;
  readonly #clockStore: ClockStore;
  readonly #clockGuard: ClockGuardStore | undefined;
  #foreignWalls: Record<DeviceId, number> | null;
  #lastPullAt: number | undefined;
  /** Why the pull evidence is what it is (carrier.ts `PullStatus`). */
  #pull: PullStatus = { kind: "incomplete" };
  /** G2 / G5: the last complete pull and the pause after it (`PullHistory`). */
  #lastCompleteAt: number | undefined;
  #pausedSince: number | undefined;
  /** Writer streams held at a frame (D7), loaded from the gate state store on the first pass. */
  #stuck = new Map<DeviceId, StuckRecord>();
  #stuckLoaded = false;
  readonly #maxPushBytes: number;
  #rejectedWriters: readonly DeviceId[] = [];
  readonly #gateState: GateStateStore | undefined;
  /** Per writer, the head of the last data frame the gate accepted (in stream order). */
  #judged = new Map<DeviceId, FrameHead>();
  /** The judged positions of the last snapshot saved or restored. */
  #savedKey = "";
  #restoreTried = false;
  #evidenceLoaded = false;
  readonly #clock: HybridClock;
  readonly #maxFrameEvents: number;
  readonly #maxFrameBytes: number;
  readonly #maxSegmentBytes: number;
  readonly #maxBatchEvents: number;
  readonly #maxBatchBytes: number;
  readonly #physical: PhysicalClock;
  readonly #listeners = new Set<(info: AppliedInfo) => void>();
  #leaseTransport: LeaseTransport = { kind: "eventual" };
  #tail: Promise<unknown> = Promise.resolve();
  #closed = false;
  #rolledBack = false;
  #ownTailUncertain = false;
  #gossipDeliveryPending = false;
  #lastGossipAt = Number.NEGATIVE_INFINITY;
  #ownSeg = 1;
  #ownSize = 0;
  /** Chain after every frame of the local log, per device, in stream order (data stream). */
  readonly #chains = new Map<DeviceId, ChainEntry[]>();
  /** False until the gate has seen every frame of the local log once (after start). */
  #primed = false;
  /** `takeRebuild` consumes its flag; the old sink remains stale across recovery retries. */
  #recoveryViewStale = false;
  readonly #checkpoint: RecoveryCheckpointOptions | undefined;
  readonly #yield: { run: () => Promise<void>; now: () => number; sliceMs: number } | undefined;
  readonly #onProgress: ((progress: RecoveryProgress) => void) | undefined;
  /** Start of the current slice of uninterrupted work (`#pause`). */
  #sliceStart = 0;

  constructor(
    o: SyncEngineOptions,
    restored: { wall: number; counter: number } | undefined,
    guard: Readonly<Record<DeviceId, number>> | null,
  ) {
    this.vault = o.vault;
    this.device = o.device;
    this.#local = o.local;
    this.#remotes = o.remotes ?? [];
    this.#gossipDeliveryPending = this.#remotes.length > 0;
    this.#codec = o.codec;
    this.#gate = o.gate;
    this.#gossipEid = o.gossipEid;
    this.#sink = o.sink;
    this.#clockStore = o.clockStore;
    this.#clockGuard = o.clockGuard;
    this.#foreignWalls = guard === null ? null : { ...guard };
    this.#gateState = o.gateState;
    this.#physical = o.physicalClock ?? systemClock;
    this.#clock = new HybridClock(o.device, {
      ...(o.physicalClock ? { physical: o.physicalClock } : {}),
      ...(o.maxDriftMs === undefined ? {} : { maxDriftMs: o.maxDriftMs }),
      ...(restored ? { restore: restored } : {}),
    });
    this.#maxFrameEvents = Math.max(1, o.maxFrameEvents ?? DEFAULT_MAX_FRAME_EVENTS);
    this.#maxFrameBytes = Math.max(1, o.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES);
    this.#maxSegmentBytes = Math.max(1, o.maxSegmentBytes ?? 4 * 1024 * 1024);
    this.#maxBatchEvents = Math.max(1, o.maxBatchEvents ?? DEFAULT_MAX_BATCH_EVENTS);
    this.#maxBatchBytes = Math.max(1, o.maxBatchBytes ?? DEFAULT_MAX_BATCH_BYTES);
    this.#maxPushBytes = Math.max(1, o.maxPushBytesPerPass ?? DEFAULT_MAX_PUSH_BYTES_PER_PASS);
    this.#checkpoint = o.recoveryCheckpoint;
    this.#onProgress = o.onRecoveryProgress;
    const host = o.yieldToHost;
    const physical = this.#physical;
    this.#yield =
      host === undefined
        ? undefined
        : {
            run: host.run,
            now: host.now ?? (() => physical.now()),
            sliceMs: Math.max(1, host.sliceMs ?? DEFAULT_YIELD_SLICE_MS),
          };
    const history = o.pullHistory;
    if (this.#remotes.length > 0 && history !== undefined) {
      if (Number.isSafeInteger(history.lastCompleteAt))
        this.#lastCompleteAt = history.lastCompleteAt;
      if (Number.isSafeInteger(history.pausedSince)) this.#pausedSince = history.pausedSince;
    }
  }

  /** Find the own write position and chain, and detect a rolled-back clock (own log ahead of the clock). */
  async init(): Promise<void> {
    const own = (await this.#local.list(this.vault))
      .filter((s) => s.device === this.device && s.seg >= 1)
      .sort(bySegment);
    const last = own.at(-1);
    if (!last) return;
    this.#ownSeg = last.seg;
    this.#ownSize = last.size;
    await this.#indexStream(this.device, own);
    const entries = this.#chains.get(this.device) ?? [];
    const lastEntry = entries.at(-1);
    if (!lastEntry) return;
    const bytes = await this.#local.read(this.vault, this.device, lastEntry.seg, 0);
    const frame = scanFrames(bytes, 0).frames.find((f) => f.end === lastEntry.end);
    const prev = this.#chainBefore(this.device, lastEntry.seg, frame?.offset ?? -1);
    let lastHlc: string | undefined;
    if (frame && prev) {
      const at = {
        vault: this.vault,
        device: this.device,
        seg: lastEntry.seg,
        offset: frame.offset,
      };
      try {
        const opened = await this.#codec.open(frame.sealed, at, prev);
        const decoded = decodePayload(opened.plain, this.device);
        lastHlc = decoded.ok ? decoded.payload.events.at(-1)?.h : undefined;
      } catch {
        lastHlc = undefined;
      }
    }
    // An own frame that does not open is as suspicious as a clock behind the log.
    if (lastHlc === undefined || lastHlc > this.#clock.last) this.#rolledBack = true;
  }

  write(events: readonly UnstampedEvent[], options?: WriteOptions): Promise<WriteResult> {
    return this.#run(() => this.#writeInQueue(events, options));
  }

  writeAdmission(): "ready" | "own-tail-uncertain" | "authority-unresolved" | "rolled-back" {
    if (this.#ownTailUncertain) return "own-tail-uncertain";
    if (this.#gate.gossipStatus?.().authorityUncertain) return "authority-unresolved";
    if (this.#rolledBack) return "rolled-back";
    return "ready";
  }

  async #writeInQueue(
    events: readonly UnstampedEvent[],
    options?: WriteOptions,
  ): Promise<WriteResult> {
    this.#assertOpen();
    if (this.#ownTailUncertain) {
      throw new SyncError("own-tail-uncertain", "own log needs authenticated recovery");
    }
    if (!this.#primed && this.#gate.needsReplay()) await this.#applyLocal(newPass());
    const recoveryBatch = this.#gate.consumeRecoveryRevocationBatch?.(events);
    if (this.#gate.gossipStatus?.().authorityUncertain && !recoveryBatch) {
      throw new SyncError("authority-unresolved", "authenticated head history needs resolution");
    }
    if (recoveryBatch) {
      // The gate returns a private copy of the exact prepared batch. The caller cannot mutate it
      // while the queued write awaits clock, codec or transport operations.
      events = recoveryBatch;
    }
    if (this.#rolledBack) {
      throw new SyncError("rolled-back", "this device's log is ahead of its clock; re-pair it");
    }
    if (events.length === 0) throw new SyncError("invalid-event", "empty batch");
    if (!events.every(isUnstampedEvent)) {
      throw new SyncError("invalid-event", "invalid event in batch");
    }
    if (options?.afterHlc !== undefined) {
      let warning: ClockWarning | undefined;
      try {
        warning = this.#clock.receive(options.afterHlc);
      } catch {
        throw new SyncError("invalid-event", "invalid high-water mark");
      }
      if (warning) throw new SyncError("remote-far-future", "high-water mark is too far ahead");
    }
    const stamped: WireEvent[] = events.map((e) => ({ ...e, h: this.#clock.tick() }));
    await this.#clockStore.save(this.#clock.state);

    const groups = this.#split(stamped);
    const plains = groups.map((group, index) =>
      encodePayload(
        groups.length > 1 ? { events: group, part: [index, groups.length] } : { events: group },
      ),
    );
    const sealedFrames: { at: FramePosition; bytes: Uint8Array; chain: Uint8Array }[] = [];
    const cache = new Map<string, Opened>();
    const total = plains.reduce((n, p) => n + LENGTH_BYTES + p.length, 0);
    const fresh = this.#ownSize > 0 && this.#ownSize + total > this.#maxSegmentBytes;
    const seg = fresh ? this.#ownSeg + 1 : this.#ownSeg;
    const start = fresh ? 0 : this.#ownSize;
    let size = start;
    let prev = this.#ownChain();
    for (const plain of plains) {
      const at = { vault: this.vault, device: this.device, seg, offset: size };
      const { sealed, head } = await this.#codec.seal(plain, at, prev);
      if (sealed.length > MAX_SEALED_FRAME_BYTES) {
        throw new SyncError("frame-too-large", "an event is larger than the frame limit");
      }
      const bytes = frameBytes(sealed);
      sealedFrames.push({ at, bytes, chain: head.chain });
      cache.set(posKey(at), { plain, head });
      size += bytes.length;
      prev = head.chain;
    }
    try {
      await this.#local.append(
        this.vault,
        this.device,
        seg,
        start,
        concatBytes(sealedFrames.map((f) => f.bytes)),
      );
      this.#ownSeg = seg;
      this.#ownSize = size;
      for (const f of sealedFrames) {
        this.#addChain(this.device, {
          seg,
          end: f.at.offset + f.bytes.length,
          chain: f.chain,
        });
      }

      const pass = newPass();
      pass.cache = cache;
      await this.#applyLocal(pass);
      await this.#rebuildIfNeeded(pass);
      await this.#saveEvidence();
      this.#emit(pass);
      const first = stamped[0]?.h ?? "";
      const last = stamped.at(-1)?.h ?? "";
      return { events: stamped.length, frames: sealedFrames.length, first, last };
    } catch (error) {
      // A transport may commit and then throw. No writer may use the old offset or chain.
      this.#ownTailUncertain = true;
      throw error;
    }
  }

  recoverLocal(): Promise<LocalRecoveryResult> {
    return this.#run(() => this.#recoverLocalInQueue());
  }

  async #recoverLocalInQueue(): Promise<LocalRecoveryResult> {
    this.#assertOpen();
    const checkpoint = await this.#loadCheckpoint();
    let gateTouched = false;
    if (checkpoint !== undefined) {
      const tail = await this.#recover(checkpoint, false);
      if (!("fallback" in tail)) return tail;
      // Prefer the full replay over a doubtful checkpoint: forget it and open every frame again. When
      // the gate already took the checkpoint's authenticated state and the verified tail, the full
      // replay runs over it as it does after a sync pass (no snapshot restored on top).
      gateTouched = tail.touched;
      await this.#clearCheckpoint();
    }
    const full = await this.#recover(undefined, gateTouched);
    if ("fallback" in full) throw new SyncError("invalid-config", "recovery without a checkpoint");
    return full;
  }

  /**
   * One local recovery: the audit of every held frame (`cp` undefined), or, with a checkpoint (phone),
   * the same audit of the frames after it, which gives up (`Fallback`) before any sink write when
   * anything is doubtful. The hash-only scan (chains, no decryption) always covers the whole log, so
   * the checkpoint is bound to the exact bytes of the prefix it vouches for.
   */
  async #recover(
    cp: Checkpoint | undefined,
    gateTouched: boolean,
  ): Promise<LocalRecoveryResult | Fallback> {
    const pass = newPass();
    const original = await this.#sink.cursors();
    const inventory = await this.#local.list(this.vault);
    const streams = new Map<DeviceId, RecoveryStream>();
    const streamFor = (device: DeviceId): RecoveryStream => {
      let stream = streams.get(device);
      if (!stream) {
        stream = {
          device,
          frames: [],
          heldEnd: START_CURSOR,
          inspectedThrough: START_CURSOR,
          suppressed: false,
          parked: false,
          accepted: false,
        };
        streams.set(device, stream);
      }
      return stream;
    };
    for (const device of original.keys()) streamFor(device);
    for (const segment of inventory) streamFor(segment.device);

    // A signed local gate snapshot records heads this installation held. It is an anchor, not
    // permission to skip any bytes in this audit. Invalid snapshots are only caches to ignore.
    let evidence: readonly string[] = [];
    if (this.#gateState?.loadEvidence && this.#gate.importEvidence) {
      const records = await this.#gateState.loadEvidence();
      evidence = records;
      this.#gate.importEvidence(records);
      this.#evidenceLoaded = true;
    }
    let anchors: readonly FrameHead[] = [];
    if (this.#gateState?.load && this.#gate.importState) {
      try {
        const state = await this.#gateState.load();
        const imported = state === undefined ? undefined : this.#gate.importState(state);
        if (imported) {
          anchors = imported.heldHeads ?? [...imported.positions.values()];
          for (const head of anchors) streamFor(head.device);
          // With a checkpoint the gate takes the checkpoint's own state (below) instead.
          if (!this.#primed && cp === undefined && !gateTouched) imported.restore();
        }
      } catch {
        // A missing or damaged cache never establishes readiness on its own.
      }
    }

    for (const stream of streams.values()) {
      const segments = inventory.filter((s) => s.device === stream.device).sort(bySegment);
      const last = segments.at(-1);
      if (last) stream.heldEnd = { seg: last.seg, offset: last.size };
      let expected = 1;
      let prev = this.#codec.genesis(this.vault, stream.device, 1);
      for (const s of segments) {
        if (s.seg !== expected || !Number.isSafeInteger(s.size) || s.size < 0) {
          stream.reason = "segment-gap";
          break;
        }
        let bytes: Uint8Array;
        try {
          bytes = await this.#local.read(this.vault, stream.device, s.seg, 0);
        } catch {
          stream.reason = "short-read";
          break;
        }
        if (bytes.length !== s.size) {
          stream.reason = "short-read";
          break;
        }
        const scan = scanFrames(bytes, 0);
        for (const f of scan.frames) {
          const at = { vault: this.vault, device: stream.device, seg: s.seg, offset: f.offset };
          const before = prev;
          try {
            prev = this.#codec.link(f.sealed, at, prev);
          } catch {
            stream.reason = "chain-unknown";
            break;
          }
          stream.frames.push({
            at,
            end: { seg: s.seg, offset: f.end },
            sealed: f.sealed,
            size: f.end - f.offset,
            prev: before,
            after: prev,
          });
          await this.#pause();
        }
        if (stream.reason) break;
        if (scan.tail !== "none") {
          stream.reason = scan.tail === "too-large" ? "too-large" : "partial";
          break;
        }
        expected += 1;
      }
    }

    // The checkpoint's prefix: per stream, how many leading frames it vouches for. Every check runs
    // before the gate or the sink changes; a failure gives up untouched.
    const prefix = new Map<DeviceId, number>();
    if (cp !== undefined) {
      const checked = this.#checkPrefix(cp, streams, original, anchors, evidence);
      if (checked === undefined) return { fallback: true, touched: false };
      for (const [device, count] of checked.prefix) prefix.set(device, count);
      if (!this.#primed) {
        checked.gate.restore();
        this.#judged = new Map(checked.gate.positions);
        this.#savedKey = this.#judgedKey();
        // The restore folded the checkpoint's statements under THIS code. Its accepted ranges must
        // still pass the current cuts and freezes, as the full replay's `accept` would judge each
        // frame; any refusal (data the view holds is no longer accepted) gives up. What the recheck
        // cannot see (a changed decoder, cap or signature rule on a prefix frame) needs the frames
        // reopened, i.e. the full replay: `SYNC_RULES_VERSION` covers that.
        if ((checked.gate.recheck?.() ?? 0) > 0) return { fallback: true, touched: true };
      }
    }

    // Trust statements can introduce a writer whose earlier held frame initially waited.
    // Each successful round signs off at least one new frame, so a frame-count bound is sound.
    const observed = new Set<RecoveryFrame>();
    for (const stream of streams.values()) {
      const covered = prefix.get(stream.device) ?? 0;
      for (const frame of stream.frames.slice(0, covered)) observed.add(frame);
      const last = stream.frames[covered - 1];
      if (last) stream.inspectedThrough = last.end;
    }
    const frameCount = [...streams.values()].reduce((n, s) => n + s.frames.length, 0);
    const toVerify = frameCount - observed.size;
    let verified = 0;
    let tailAuthority = false;
    let progress = false;
    for (let round = 0; round <= frameCount; round++) {
      progress = false;
      for (const stream of streams.values()) {
        for (const frame of stream.frames) {
          if (observed.has(frame)) continue;
          let opened: Opened;
          try {
            opened = await this.#open(frame.sealed, frame.at, frame.prev, pass);
          } catch (e) {
            stream.reason ??= rejectionCode(e);
            break;
          }
          const decoded = decodePayload(opened.plain, stream.device);
          if (!decoded.ok) {
            stream.reason ??= decoded.code;
            break;
          }
          const verdict = this.#gate.authenticate(opened.head, decoded.payload.events);
          if (!verdict.ok) {
            if (!verdict.wait) stream.reason ??= verdict.code;
            break;
          }
          frame.opened = opened;
          frame.events = decoded.payload.events;
          frame.part = decoded.payload.part;
          stream.inspectedThrough = frame.end;
          this.#gate.observe(opened.head, decoded.payload.events);
          if (cp !== undefined && decoded.payload.events.some((e) => AUTHORITY_TYPES.has(e.t)))
            tailAuthority = true;
          observed.add(frame);
          progress = true;
          verified += 1;
          if (await this.#pause()) this.#onProgress?.({ done: verified, total: toVerify });
        }
      }
      if (observed.size === frameCount || !progress) break;
    }
    this.#onProgress?.({ done: verified, total: toVerify });
    for (const stream of streams.values()) {
      if (stream.frames.some((f) => !observed.has(f))) stream.reason ??= "writer-unknown";
    }

    // A snapshot's locally held heads must still be present. Gossip/remote attestation is not
    // a local durability anchor and is intentionally excluded from this check. A frame the checkpoint
    // vouches for (not opened again) matches by its position, chain and signature bytes.
    let anchorMismatch = false;
    for (const anchor of anchors) {
      const stream = streamFor(anchor.device);
      const match = stream.frames.some((frame) =>
        frame.opened
          ? frame.opened.head.seg === anchor.seg &&
            frame.opened.head.offset === anchor.offset &&
            equalBytes(frame.opened.head.chain, anchor.chain) &&
            equalBytes(frame.opened.head.sig, anchor.sig)
          : observed.has(frame) &&
            frame.end.seg === anchor.seg &&
            frame.end.offset === anchor.offset &&
            equalBytes(frame.after, anchor.chain) &&
            equalBytes(signatureOf(frame.sealed), anchor.sig),
      );
      if (!match) {
        stream.reason ??= "local-anchor-missing";
        anchorMismatch = true;
      }
    }
    for (const device of this.#gate.recoveryEvidenceDevices?.() ?? []) streamFor(device);

    const deliver: {
      stream: RecoveryStream;
      events: readonly WireEvent[];
      end: SegmentCursor;
      bytes: number;
    }[] = [];
    let tailRefused = false;
    for (const stream of streams.values()) {
      const validEnds = new Set<string>([`${START_CURSOR.seg}:${START_CURSOR.offset}`]);
      const base = cp?.streams.get(stream.device);
      // The checkpoint's cursor was a sound end when it was taken; the tail changes no authority (or
      // the recovery gives up below), so it still is.
      if (base) validEnds.add(`${base.cursor.seg}:${base.cursor.offset}`);
      let group:
        | { events: WireEvent[]; count: number; next: number; bytes: number; suppressed: boolean }
        | undefined;
      let crossedSuppression = base?.suppressed ?? false;
      if (base?.suppressed) stream.suppressed = true;
      for (const frame of stream.frames.slice(prefix.get(stream.device) ?? 0)) {
        if (!observed.has(frame)) break;
        const opened = frame.opened as Opened;
        const events = frame.events as readonly WireEvent[];
        const decision = this.#gate.accept(opened.head, events);
        if (decision.changed) pass.gateChanged = true;
        if (cp !== undefined && !decision.verdict.ok) tailRefused = true;
        const suppressed =
          !decision.verdict.ok &&
          (decision.verdict.code === "revoked_writer" || decision.verdict.code === "forked");
        if (!decision.verdict.ok && !suppressed) {
          stream.reason ??= decision.verdict.code;
          break;
        }
        if (suppressed) stream.suppressed = true;
        else this.#noteJudged(opened.head);
        await this.#pause();
        const part = frame.part;
        let batch: readonly WireEvent[] | undefined;
        let bytes = frame.size;
        if (!part) {
          if (group) {
            stream.reason ??= "incomplete-group";
            break;
          }
          batch = events;
        } else if (part[0] === 0 && !group) {
          group = { events: [...events], count: part[1], next: 1, bytes, suppressed };
        } else if (
          group &&
          part[0] === group.next &&
          part[1] === group.count &&
          (events[0]?.h ?? "") > (group.events.at(-1)?.h ?? "")
        ) {
          group.events.push(...events);
          group.next += 1;
          group.bytes += bytes;
          group.suppressed ||= suppressed;
        } else {
          stream.reason ??= "malformed";
          break;
        }
        let batchSuppressed = suppressed;
        if (group && group.next === group.count) {
          batch = group.events;
          bytes = group.bytes;
          batchSuppressed = group.suppressed;
          group = undefined;
        }
        if (!batch) continue;
        if (batchSuppressed) {
          crossedSuppression = true;
          continue;
        }
        validEnds.add(`${frame.end.seg}:${frame.end.offset}`);
        stream.accepted = true;
        const cursor = original.get(stream.device) ?? START_CURSOR;
        if (comparePositions(frame.end, cursor) > 0) {
          if (crossedSuppression) {
            stream.reason ??= "suppressed-gap";
            break;
          }
          deliver.push({ stream, events: batch, end: frame.end, bytes });
        }
      }
      if (group && !stream.reason) stream.reason = "incomplete-group";
      const cursor = original.get(stream.device) ?? START_CURSOR;
      if (!stream.reason && !validEnds.has(`${cursor.seg}:${cursor.offset}`)) {
        stream.reason = "cursor-not-accepted";
        // With a checkpoint this gives up below; the full replay decides about the view.
        if (cp === undefined) this.#recoveryViewStale = true;
      }
      if (stream.reason === "suppressed-gap" && cp === undefined) this.#recoveryViewStale = true;
    }

    // With a checkpoint: give up before any sink write unless the tail was entirely ordinary.
    if (cp !== undefined) {
      const rebuild = this.#gate.takeRebuild();
      if (rebuild) this.#recoveryViewStale = true;
      const proofs = await this.#saveEvidence();
      const gossip = this.#gate.gossipStatus?.();
      if (
        tailAuthority ||
        tailRefused ||
        rebuild ||
        proofs > 0 ||
        anchorMismatch ||
        gossip?.overflow === true ||
        gossip?.authorityUncertain === true ||
        [...streams.values()].some((stream) => stream.reason !== undefined)
      )
        return { fallback: true, touched: true };
    }

    // Cursor proofs precede any sink write. A partial replay remains quarantined by the host.
    for (const item of deliver) {
      if (item.stream.reason) continue;
      await this.#collect(
        item.stream.device,
        item.stream.device === this.device,
        item.events,
        item.end,
        item.bytes,
        pass,
      );
    }
    await this.#flush(pass);
    for (const device of pass.parkedDevices) streamFor(device).parked = true;
    if (pass.clockDirty) await this.#clockStore.save(this.#clock.state);
    if (this.#gate.takeRebuild() || pass.staleView) this.#recoveryViewStale = true;
    const finalCursors = await this.#sink.cursors();
    const reports: LocalStreamRecovery[] = [...streams.values()]
      .sort((a, b) => a.device.localeCompare(b.device))
      .map((stream) => {
        const appliedThrough = finalCursors.get(stream.device) ?? START_CURSOR;
        const base = {
          device: stream.device,
          inspectedThrough: stream.inspectedThrough,
          heldEnd: stream.heldEnd,
          appliedThrough,
        };
        if (stream.reason)
          return { ...base, disposition: "unresolved_tail" as const, reason: stream.reason };
        return {
          ...base,
          disposition: stream.suppressed
            ? ("authenticated_suppressed" as const)
            : stream.parked
              ? ("authenticated_parked" as const)
              : ("authenticated_accepted" as const),
        };
      });
    const incomplete = reports.some((s) => s.disposition === "unresolved_tail");
    const complete =
      !incomplete && !this.#recoveryViewStale && !this.#rolledBack && !anchorMismatch;
    let ownTailRebased = false;
    if (complete && this.#ownTailUncertain) {
      const own = streams.get(this.device);
      const ownLastHlc = own?.frames.at(-1)?.events?.at(-1)?.h;
      if (ownLastHlc !== undefined && ownLastHlc > this.#clock.last) {
        this.#rolledBack = true;
      } else {
        const ownSegments = inventory.filter((s) => s.device === this.device && s.seg >= 1);
        await this.#indexStream(this.device, ownSegments);
        const last = [...ownSegments].sort(bySegment).at(-1);
        this.#ownSeg = last?.seg ?? 1;
        this.#ownSize = last?.size ?? 0;
        ownTailRebased = true;
      }
    }
    this.#primed = complete && !this.#rolledBack;
    await this.#saveEvidence();
    if (this.#primed) await this.#saveGate();
    if (ownTailRebased) this.#ownTailUncertain = false;
    let parkedInSink: boolean | null = null;
    if (this.#sink.needsUpgrade) {
      try {
        parkedInSink = await this.#sink.needsUpgrade();
      } catch {
        parkedInSink = null;
      }
    }
    const unreadableFrame = reports.some((s) => s.reason === "frame-format");
    const needsUpgrade = pass.needsUpgrade || unreadableFrame ? true : parkedInSink;
    if (this.#primed && this.#checkpoint !== undefined) {
      // The scan already chained every frame: the first sync pass need not hash the log again (phone).
      for (const stream of streams.values()) {
        if (this.#chains.has(stream.device)) continue;
        this.#chains.set(
          stream.device,
          stream.frames.map((f) => ({ seg: f.end.seg, end: f.end.offset, chain: f.after })),
        );
      }
    }
    if (this.#checkpoint !== undefined) {
      if (this.#primed && needsUpgrade === false && !this.#recoveryViewStale) {
        await this.#saveCheckpoint(streams, finalCursors);
      } else {
        await this.#clearCheckpoint();
      }
    }
    return {
      complete: this.#primed,
      streams: reports,
      needsUpgrade,
      requiresViewRebuild: this.#recoveryViewStale,
      rolledBack: this.#rolledBack || anchorMismatch,
    };
  }

  /**
   * The checks a checkpoint passes before the gate or the sink change, else undefined: the engine is
   * neither rolled back nor unsure of its own tail; the fork evidence record is the one it saw; the
   * gate's state in it authenticates; every stream it covers has a frame ending exactly at its end
   * with the same chain and the same signature digest (a truncated, rewritten or foreign log fails);
   * every view cursor is the one it recorded or lies in the tail; and every held anchor inside the
   * prefix is that frame. Returns the frames it covers per stream and the gate state to restore.
   */
  #checkPrefix(
    cp: Checkpoint,
    streams: ReadonlyMap<DeviceId, RecoveryStream>,
    cursors: ReadonlyMap<DeviceId, SegmentCursor>,
    anchors: readonly FrameHead[],
    evidence: readonly string[],
  ):
    | {
        readonly prefix: ReadonlyMap<DeviceId, number>;
        readonly gate: NonNullable<ReturnType<NonNullable<FrameGate["importState"]>>>;
      }
    | undefined {
    if (
      this.#rolledBack ||
      this.#ownTailUncertain ||
      !equalBytes(cp.evidence, evidenceDigest(evidence))
    )
      return undefined;
    const gate = this.#gate.importState?.(cp.gate);
    if (gate === undefined) return undefined;
    const prefix = new Map<DeviceId, number>();
    for (const base of cp.streams.values()) {
      const frames = streams.get(base.device)?.frames ?? [];
      let covered = 0;
      let chain = this.#codec.genesis(this.vault, base.device, 1);
      if (!sameCursor(base.end, START_CURSOR)) {
        covered = frames.findIndex((f) => sameCursor(f.end, base.end)) + 1;
        const last = frames[covered - 1];
        if (covered === 0 || last === undefined) return undefined;
        chain = last.after;
      }
      if (!equalBytes(chain, base.chain)) return undefined;
      if (!equalBytes(signatureDigest(frames, covered), base.sigs)) return undefined;
      prefix.set(base.device, covered);
    }
    for (const stream of streams.values()) {
      const base = cp.streams.get(stream.device);
      const cursor = cursors.get(stream.device) ?? START_CURSOR;
      const recorded = base?.cursor ?? START_CURSOR;
      const end = base?.end ?? START_CURSOR;
      if (!sameCursor(cursor, recorded) && comparePositions(cursor, end) <= 0) return undefined;
    }
    for (const anchor of anchors) {
      const frames = streams.get(anchor.device)?.frames ?? [];
      const covered = prefix.get(anchor.device) ?? 0;
      const index = frames.findIndex(
        (f) => f.end.seg === anchor.seg && f.end.offset === anchor.offset,
      );
      const frame = frames[index];
      if (frame === undefined || index >= covered) continue; // judged with the tail (or missing)
      if (
        !equalBytes(frame.after, anchor.chain) ||
        !equalBytes(signatureOf(frame.sealed), anchor.sig)
      )
        return undefined;
    }
    return { prefix, gate };
  }

  /** The stored checkpoint when it authenticates and is bound to this vault, device and binding. */
  async #loadCheckpoint(): Promise<Checkpoint | undefined> {
    const options = this.#checkpoint;
    if (options === undefined) return undefined;
    let text: string | undefined;
    try {
      text = await options.store.load();
    } catch {
      return undefined;
    }
    if (text === undefined) return undefined;
    let decoded: Checkpoint | undefined;
    try {
      const outer: unknown = JSON.parse(text);
      if (
        isRecord(outer) &&
        typeof outer.body === "string" &&
        typeof outer.sig === "string" &&
        /^[0-9a-f]{128}$/.test(outer.sig) &&
        options.verify(utf8Encode(outer.body), fromHex(outer.sig))
      ) {
        decoded = decodeCheckpointBody(outer.body, {
          vault: this.vault,
          device: this.device,
          binding: options.binding(),
        });
      }
    } catch {
      decoded = undefined;
    }
    if (decoded === undefined) await this.#clearCheckpoint();
    return decoded;
  }

  /** Records the audited log after a complete recovery (strictly after the frames it covers). */
  async #saveCheckpoint(
    streams: ReadonlyMap<DeviceId, RecoveryStream>,
    cursors: ReadonlyMap<DeviceId, SegmentCursor>,
  ): Promise<void> {
    const options = this.#checkpoint;
    if (options === undefined) return;
    const gossip = this.#gate.gossipStatus?.();
    const gate =
      this.#ownTailUncertain || gossip?.overflow === true || gossip?.authorityUncertain === true
        ? undefined
        : this.#gate.exportState?.(this.#judged);
    if (gate === undefined) {
      await this.#clearCheckpoint();
      return;
    }
    try {
      const evidence = toHex(evidenceDigest((await this.#gateState?.loadEvidence?.()) ?? []));
      const list = [...streams.values()]
        .sort((a, b) => (a.device < b.device ? -1 : a.device > b.device ? 1 : 0))
        .map((stream) => {
          const last = stream.frames.at(-1);
          return {
            device: stream.device,
            end: last ? { seg: last.end.seg, offset: last.end.offset } : START_CURSOR,
            chain: toHex(last ? last.after : this.#codec.genesis(this.vault, stream.device, 1)),
            sigs: toHex(signatureDigest(stream.frames, stream.frames.length)),
            cursor: cursors.get(stream.device) ?? START_CURSOR,
            suppressed: stream.suppressed,
          };
        });
      const body = JSON.stringify({
        v: CHECKPOINT_VERSION,
        rules: SYNC_RULES_VERSION,
        vault: this.vault,
        device: this.device,
        binding: options.binding(),
        evidence,
        gate,
        streams: list,
      });
      const sig = toHex(options.sign(utf8Encode(body)));
      await options.store.save(JSON.stringify({ body, sig }));
    } catch {
      // Only an optimization: without it the next recovery replays everything.
      await this.#clearCheckpoint();
    }
  }

  async #clearCheckpoint(): Promise<void> {
    try {
      await this.#checkpoint?.store.clear();
    } catch {
      // A checkpoint left behind still has to pass every check above.
    }
  }

  inspectOwnBatch(expected: {
    readonly eids: readonly string[];
    readonly digest: string;
  }): Promise<"committed" | "absent" | "unknown"> {
    return this.#run(async () => {
      if (
        expected.eids.length === 0 ||
        new Set(expected.eids).size !== expected.eids.length ||
        !/^[0-9a-f]{64}$/.test(expected.digest)
      ) {
        return "unknown";
      }
      const recovered = await this.#recoverLocalInQueue();
      if (!recovered.complete) return "unknown";
      const ownReport = recovered.streams.find((s) => s.device === this.device);
      if (ownReport && ownReport.disposition !== "authenticated_accepted") return "unknown";
      const applied = (await this.#sink.cursors()).get(this.device) ?? START_CURSOR;
      const own = [...(await this.#local.list(this.vault))]
        .filter((s) => s.device === this.device && s.seg >= 1)
        .sort(bySegment);
      let prev = this.#codec.genesis(this.vault, this.device, 1);
      let sawAny = false;
      let matched = false;
      let position = 1;
      for (const segment of own) {
        if (segment.seg !== position) return "unknown";
        const bytes = await this.#local.read(this.vault, this.device, segment.seg, 0);
        if (bytes.length !== segment.size) return "unknown";
        const scan = scanFrames(bytes, 0);
        if (scan.tail !== "none") return "unknown";
        for (const frame of scan.frames) {
          const at = {
            vault: this.vault,
            device: this.device,
            seg: segment.seg,
            offset: frame.offset,
          };
          let opened: Opened;
          try {
            opened = await this.#codec.open(frame.sealed, at, prev);
          } catch {
            return "unknown";
          }
          prev = opened.head.chain;
          const decoded = decodePayload(opened.plain, this.device);
          if (!decoded.ok || !this.#gate.authenticate(opened.head, decoded.payload.events).ok)
            return "unknown";
          const events = decoded.payload.events;
          if (!events.some((e) => expected.eids.includes(e.i))) continue;
          sawAny = true;
          const end = { seg: segment.seg, offset: frame.end };
          if (decoded.payload.part || comparePositions(end, applied) > 0) return "unknown";
          if (
            events.length !== expected.eids.length ||
            events.some((e, i) => e.i !== expected.eids[i])
          )
            return "unknown";
          try {
            if (ownBatchDigest(events) !== expected.digest) return "unknown";
          } catch {
            return "unknown";
          }
          if (matched) return "unknown";
          matched = true;
        }
        position += 1;
      }
      return matched ? "committed" : sawAny ? "unknown" : "absent";
    });
  }

  sync(): Promise<SyncResult> {
    return this.#run(async () => {
      const startedAt = this.#physical.now();
      try {
        return await this.#syncPass();
      } catch (e) {
        // A pass that failed outright says nothing about what was pulled: drop the evidence.
        this.#lastPullAt = undefined;
        this.#pull = { kind: "incomplete" };
        this.#paused(startedAt);
        throw e;
      }
    });
  }

  /**
   * One pass. The fetch-lease pull evidence (`fetchLeaseEvidence`) is replaced only by a pass that
   * pulled every remote completely; a pass that missed one (offline, not delivered) keeps the
   * previous evidence, which still proves that earlier pull and ages out by the lease's own
   * deadline. A pass that rolled back or needs an upgrade drops it. Next to it the pass records WHY
   * (`#pull`, carrier.ts `PullStatus`): a pass that missed only unreachable remotes is `offline`, which
   * the pinned lease accepts (D6, lease.ts); anything else that is not a complete pull is `incomplete`.
   * Only a true outage is unreachable (errors.ts `isTransportOutage`): a remote that refused this
   * device (membership gone, identity lost) or answered something unusable makes the pass
   * `incomplete`, so a removed Mac stops leading at once (G1). A pass whose only shortfall is the push
   * budget pulled everything: it is a complete pull (G3), though its lease transport stays
   * `eventual` (mode auto needs the publish too).
   */
  async #syncPass(): Promise<SyncResult> {
    this.#assertOpen();
    this.#rejectedWriters = [];
    const pass = newPass();
    const passStart = this.#physical.now();
    const budget = { left: this.#maxPushBytes };
    // A remote that answered but was not delivered to (an offset conflict), or one that was
    // unavailable for another reason than an outage: such a pass is neither complete nor `offline`.
    let reachableUndelivered = false;
    let refusedMiss = false;
    // The push budget ended own delivery early (S6); everything was pulled.
    let budgetYield = false;
    const undelivered = (delivery: Delivery): void => {
      if (delivery === "conflict") reachableUndelivered = true;
      else if (delivery === "budget") budgetYield = true;
    };
    // A gate with statement state sees the local log first, so every stream's key is bound by its
    // first frame before anything new is verified.
    if (!this.#primed && this.#gate.needsReplay()) await this.#applyLocal(pass);
    this.#leaseTransport = { kind: "eventual" };
    const bounded: { propagationMs: number; pullAt: number; pushAt: number }[] = [];
    const pullStarts: number[] = [];
    let boundedOffline = false;
    let allDelivered = true;
    const offlineRemoteIndices = new Set<number>();
    for (const [index, remote] of this.#remotes.entries()) {
      const bound = propagationBound(remote.consistency);
      const pullAt = this.#physical.now();
      try {
        const delivery = await this.#replicate(remote, pass, !this.#ownTailUncertain, budget);
        if (delivery !== "delivered") {
          allDelivered = false;
          undelivered(delivery);
        }
        pullStarts.push(pullAt);
        if (bound !== undefined) {
          bounded.push({ propagationMs: bound, pullAt, pushAt: this.#physical.now() });
        }
      } catch (e) {
        if (!isTransportUnavailable(e)) throw e;
        if (!isTransportOutage(e)) refusedMiss = true;
        if (!offlineRemoteIndices.has(index)) {
          offlineRemoteIndices.add(index);
          pass.offlineRemotes += 1;
        }
        allDelivered = false;
        if (bound !== undefined) boundedOffline = true;
      }
    }
    // Frames whose writer was unknown wait; applying may register it (an inviter's frame carries
    // the certificate), so pull again while that happens, a bounded number of times.
    for (let round = 1; round < MAX_ROUNDS && pass.waited; round++) {
      await this.#applyLocal(pass);
      if (!pass.gateChanged) break;
      pass.waited = false;
      pass.gateChanged = false;
      pass.rejected = pass.rejected.filter((r) => r.code !== WRITER_UNKNOWN);
      for (const [index, remote] of this.#remotes.entries()) {
        // S6: a remote that was unreachable in this pass is not asked again (its timeouts again).
        if (offlineRemoteIndices.has(index)) continue;
        try {
          await this.#replicate(remote, pass, false);
        } catch (e) {
          if (!isTransportUnavailable(e)) throw e;
          if (!isTransportOutage(e)) refusedMiss = true;
        }
      }
    }
    this.#leaseTransport =
      bounded.length > 0 && !boundedOffline && !budgetYield
        ? {
            kind: "bounded",
            propagationMs: Math.max(...bounded.map((b) => b.propagationMs)),
            lastPullAt: Math.min(...bounded.map((b) => b.pullAt)),
            lastPushAt: Math.max(...bounded.map((b) => b.pushAt)),
          }
        : { kind: "eventual" };
    await this.#applyLocal(pass);
    await this.#rebuildIfNeeded(pass);
    await this.#resolveHistoricalLookups(pass);
    if (!this.#ownTailUncertain && !pass.rolledBack) this.#gossipDeliveryPending = !allDelivered;
    if (
      !this.#ownTailUncertain &&
      !this.#rolledBack &&
      this.#gossipEid &&
      this.#gate.prepareGossip
    ) {
      const now = this.#physical.now();
      if (now - this.#lastGossipAt >= 60_000) {
        const eid = this.#gossipEid();
        if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(eid)) {
          throw new SyncError("invalid-config", "gossip id factory returned an invalid ULID");
        }
        const event = this.#gate.prepareGossip(eid);
        if (event) {
          await this.#writeInQueue([event]);
          this.#lastGossipAt = now;
          pass.gossipEmitted = true;
          this.#gossipDeliveryPending = this.#remotes.length > 0;
        }
      }
    }
    if (this.#gossipDeliveryPending && !this.#ownTailUncertain) {
      let delivered = true;
      for (const [index, remote] of this.#remotes.entries()) {
        if (offlineRemoteIndices.has(index)) {
          delivered = false;
          continue;
        }
        try {
          const delivery = await this.#replicate(remote, pass, true, budget);
          if (delivery !== "delivered") {
            delivered = false;
            undelivered(delivery);
          }
        } catch (e) {
          if (!isTransportUnavailable(e)) throw e;
          if (!isTransportOutage(e)) refusedMiss = true;
          delivered = false;
          if (!offlineRemoteIndices.has(index)) {
            offlineRemoteIndices.add(index);
            pass.offlineRemotes += 1;
          }
        }
      }
      await this.#applyLocal(pass);
      this.#gossipDeliveryPending = !delivered;
    }
    await this.#saveGate();
    await this.#noteStuck(pass);
    const result = await this.#finish(pass);
    this.#rejectedWriters = result.rejected.map((row) => row.device);
    if (
      this.#remotes.length > 0 &&
      pullStarts.length === this.#remotes.length &&
      result.offlineRemotes === 0 &&
      !result.needsUpgrade &&
      !result.rolledBack &&
      !reachableUndelivered &&
      !refusedMiss
    ) {
      // G3: a pass that stopped only at the push budget pulled everything (the next pass pushes on).
      this.#lastPullAt = Math.min(...pullStarts);
      this.#pull = { kind: "pulled" };
      this.#lastCompleteAt = this.#lastPullAt;
      this.#pausedSince = undefined;
    } else if (result.needsUpgrade || result.rolledBack) {
      this.#lastPullAt = undefined;
      this.#pull = { kind: "incomplete" };
      this.#paused(passStart);
    } else if (
      result.offlineRemotes > 0 &&
      !reachableUndelivered &&
      !refusedMiss &&
      pullStarts.length + result.offlineRemotes >= this.#remotes.length
    ) {
      // Only unreachable remotes were missed: the previous evidence stays as is, and the pinned
      // lease may rely on this pass (D6). `since` survives consecutive offline passes.
      const since = this.#pull.kind === "offline" ? this.#pull.since : passStart;
      this.#pull = { kind: "offline", since, reachedAt: passStart };
      this.#paused(passStart);
    } else {
      this.#pull = { kind: "incomplete" };
      this.#paused(passStart);
    }
    return result;
  }

  /** A pass that was not a complete pull: the pause starts here unless one already runs (G5). */
  #paused(passStart: number): void {
    if (this.#remotes.length > 0) this.#pausedSince ??= passStart;
  }

  pullHistory(): PullHistory {
    return {
      ...(this.#lastCompleteAt === undefined ? {} : { lastCompleteAt: this.#lastCompleteAt }),
      ...(this.#pausedSince === undefined ? {} : { pausedSince: this.#pausedSince }),
    };
  }

  rebuild(): Promise<SyncResult> {
    return this.#run(async () => {
      this.#assertOpen();
      const pass = newPass();
      await this.#rebuildView(pass);
      await this.#saveGate();
      return this.#finish(pass);
    });
  }

  leaseTransport(): LeaseTransport {
    if (
      this.#ownTailUncertain ||
      this.#rolledBack ||
      this.#gate.gossipStatus?.().authorityUncertain
    )
      return { kind: "eventual" };
    return this.#leaseTransport;
  }

  fetchLeaseEvidence(
    activeClockWriter: (device: DeviceId) => boolean,
    rejectedRelevant: (device: DeviceId) => boolean,
  ) {
    const physical = this.#physical.now();
    const healthy =
      Number.isSafeInteger(physical) && physical + this.#clock.maxDriftMs >= this.#clock.state.wall;
    let clockOk = healthy && this.#foreignWalls !== null;
    if (clockOk) {
      try {
        if (this.#rejectedWriters.some(rejectedRelevant)) clockOk = false;
        for (const [device, wall] of Object.entries(this.#foreignWalls ?? {}))
          if (activeClockWriter(device) && physical + this.#clock.maxDriftMs < wall) {
            clockOk = false;
            break;
          }
      } catch {
        clockOk = false;
      }
    }
    return {
      lastPullAt: clockOk ? this.#lastPullAt : undefined,
      clockOk,
      pull: clockOk ? this.#pull : { kind: "incomplete" as const },
    };
  }

  onApplied(listener: (info: AppliedInfo) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  close(): Promise<void> {
    return this.#run(async () => {
      this.#closed = true;
      this.#listeners.clear();
    });
  }

  // -------------------------------------------------------------------------------------------

  #run<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.#tail.then(() => {
      if (this.#yield) this.#sliceStart = this.#yield.now();
      return fn();
    });
    this.#tail = p.catch(() => undefined);
    return p;
  }

  #assertOpen(): void {
    if (this.#closed) throw new SyncError("closed", "the sync engine is closed");
  }

  /**
   * Yields to the host when the current slice of work ran `sliceMs` (`yieldToHost`; never without it),
   * so a long recovery, replay or first pull leaves the UI thread its frames. Says whether it yielded.
   */
  async #pause(): Promise<boolean> {
    const host = this.#yield;
    if (host === undefined || host.now() - this.#sliceStart < host.sliceMs) return false;
    await host.run();
    this.#sliceStart = host.now();
    return true;
  }

  #split(events: readonly WireEvent[]): WireEvent[][] {
    const groups: WireEvent[][] = [];
    let current: WireEvent[] = [];
    let bytes = 0;
    for (const e of events) {
      const n = JSON.stringify(e).length;
      if (
        current.length > 0 &&
        (current.length >= this.#maxFrameEvents || bytes + n > this.#maxFrameBytes)
      ) {
        groups.push(current);
        current = [];
        bytes = 0;
      }
      current.push(e);
      bytes += n;
    }
    if (current.length > 0) groups.push(current);
    return groups;
  }

  async #finish(pass: Pass): Promise<SyncResult> {
    if (pass.clockDirty) await this.#clockStore.save(this.#clock.state);
    this.#emit(pass);
    return {
      gossip: {
        emitted: pass.gossipEmitted,
        deliveryPending:
          this.#gossipDeliveryPending ||
          (this.#gate.gossipStatus?.().pending ?? 0) > 0 ||
          (this.#gate.gossipStatus?.().historyPending ?? false),
        overflow: this.#gate.gossipStatus?.().overflow ?? false,
        pendingHeads: this.#gate.gossipStatus?.().pending ?? 0,
        historyPending: this.#gate.gossipStatus?.().historyPending ?? false,
        ownTailUncertain: this.#ownTailUncertain,
      },
      rebuilt: pass.rebuilt,
      pushedBytes: pass.pushedBytes,
      pulledFrames: pass.pulledFrames,
      batches: pass.batches,
      applied: pass.applied,
      duplicates: pass.duplicates,
      parked: pass.parked,
      needsUpgrade: pass.needsUpgrade,
      offlineRemotes: pass.offlineRemotes,
      rejected: pass.rejected,
      clockWarnings: [...pass.warnings.values()],
      rolledBack: pass.rolledBack || this.#rolledBack,
      pushPending: pass.pushPending,
      stuck: [...this.#stuck.values()],
    };
  }

  #emit(pass: Pass): void {
    if (pass.applied === 0) return;
    const info: AppliedInfo = { types: pass.types, events: pass.applied };
    for (const listener of [...this.#listeners]) {
      try {
        listener(info);
      } catch (e) {
        // A listener bug must not undo a committed apply; surface it as an uncaught error.
        queueTask(() => {
          throw e;
        });
      }
    }
  }

  #reject(pass: Pass, at: FramePosition, code: string): void {
    pass.rejected.push({ device: at.device, seg: at.seg, offset: at.offset, code });
    if (code === "frame-format") pass.needsUpgrade = true;
  }

  /** The chain after this device's last own frame (genesis before the first). */
  #ownChain(): Uint8Array {
    return (
      this.#chains.get(this.device)?.at(-1)?.chain ??
      this.#codec.genesis(this.vault, this.device, 1)
    );
  }

  #addChain(device: DeviceId, entry: ChainEntry): void {
    const list = this.#chains.get(device) ?? [];
    const last = list.at(-1);
    if (last && (last.seg > entry.seg || (last.seg === entry.seg && last.end >= entry.end))) return;
    list.push(entry);
    this.#chains.set(device, list);
  }

  /** Rebuilds the chain index of a device's stream from the local log's bytes (no decryption). */
  async #indexStream(device: DeviceId, segs: readonly SegmentInfo[]): Promise<void> {
    const entries: ChainEntry[] = [];
    let prev = this.#codec.genesis(this.vault, device, 1);
    let expected = 1;
    for (const s of [...segs].filter((x) => x.seg >= 1).sort(bySegment)) {
      if (s.seg !== expected) break; // a gap: chains after it are unknown (S32 compaction: resume)
      const bytes = await this.#local.read(this.vault, device, s.seg, 0);
      for (const f of scanFrames(bytes, 0).frames) {
        const at = { vault: this.vault, device, seg: s.seg, offset: f.offset };
        prev = this.#codec.link(f.sealed, at, prev);
        entries.push({ seg: s.seg, end: f.end, chain: prev });
        await this.#pause();
      }
      expected += 1;
    }
    this.#chains.set(device, entries);
  }

  /**
   * The chain before a frame of `device` starting at `seg:offset` (offset 0 of a later segment links
   * to the previous segment's last frame), or undefined when the local log does not lead there.
   */
  #chainBefore(device: DeviceId, seg: number, offset: number): Uint8Array | undefined {
    const list = this.#chains.get(device) ?? [];
    if (offset === 0) {
      if (seg === 1) return this.#codec.genesis(this.vault, device, 1);
      return list.findLast((e) => e.seg === seg - 1)?.chain;
    }
    return list.find((e) => e.seg === seg && e.end === offset)?.chain;
  }

  /** D8: data the view holds is no longer accepted (a cut moved, a fork froze a writer): rebuild. */
  async #rebuildIfNeeded(pass: Pass): Promise<void> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const stale = this.#gate.takeRebuild() || pass.staleView;
      if (!stale) return;
      pass.staleView = false;
      await this.#rebuildView(pass);
    }
  }

  async #rebuildView(pass: Pass): Promise<void> {
    await this.#sink.reset();
    this.#gate.reset();
    this.#judged = new Map();
    pass.rebuilt = true;
    await this.#applyLocal(pass);
  }

  /** Opens a frame (cached when this pass opened it already). */
  async #open(
    sealed: Uint8Array,
    at: FramePosition,
    prev: Uint8Array,
    pass: Pass,
  ): Promise<Opened> {
    const cached = pass.cache.get(posKey(at));
    if (cached && equalBytes(cached.head.chain, this.#codec.link(sealed, at, prev))) return cached;
    const opened = await this.#codec.open(sealed, at, prev);
    pass.cache.set(posKey(at), opened);
    return opened;
  }

  /**
   * Push own bytes to `remote`, pull verified foreign frames from it into the local log. Says whether
   * own bytes are left for this remote and why: an offset conflict (or a rollback) is `conflict`,
   * `budget` ran out (`pushPending`) is `budget`; the pull before the push is complete either way.
   */
  async #replicate(
    remote: Transport,
    pass: Pass,
    push = true,
    budget: { left: number } = { left: this.#maxPushBytes },
  ): Promise<Delivery> {
    const [remoteList, localList] = await Promise.all([
      remote.list(this.vault),
      this.#local.list(this.vault),
    ]);
    const localSize = new Map(localList.map((s) => [`${s.device}/${s.seg}`, s.size]));
    const remoteSize = new Map(remoteList.map((s) => [`${s.device}/${s.seg}`, s.size]));
    const blocked = new Set<DeviceId>();

    for (const r of [...remoteList].sort(bySegment)) {
      const key = `${r.device}/${r.seg}`;
      const have = localSize.get(key) ?? 0;
      if (r.device === this.device) {
        // The remote holds own bytes this device never wrote: restored backup or cloned disk.
        if (r.size > have) {
          pass.rolledBack = true;
          this.#rolledBack = true;
        }
        continue;
      }
      if (r.size <= have || blocked.has(r.device) || r.seg < 1) continue;
      if (!this.#chains.has(r.device)) {
        await this.#indexStream(
          r.device,
          localList.filter((s) => s.device === r.device),
        );
      }
      let prev = this.#chainBefore(r.device, r.seg, have);
      if (!prev) {
        // The local log does not reach this segment's start (a missing earlier segment).
        blocked.add(r.device);
        continue;
      }
      const bytes = await remote.read(this.vault, r.device, r.seg, have);
      const scan = scanFrames(bytes, have);
      let end = have;
      let frames = 0;
      const chains: ChainEntry[] = [];
      for (const f of scan.frames) {
        const at = { vault: this.vault, device: r.device, seg: r.seg, offset: f.offset };
        let opened: Opened;
        try {
          opened = await this.#open(f.sealed, at, prev, pass);
        } catch (e) {
          this.#reject(pass, at, rejectionCode(e));
          blocked.add(r.device);
          break;
        }
        const decoded = decodePayload(opened.plain, r.device);
        const verdict = this.#gate.authenticate(
          opened.head,
          decoded.ok ? decoded.payload.events : [],
        );
        if (!verdict.ok) {
          this.#reject(pass, at, verdict.wait ? WRITER_UNKNOWN : verdict.code);
          if (verdict.wait) pass.waited = true;
          blocked.add(r.device);
          break;
        }
        prev = opened.head.chain;
        chains.push({ seg: r.seg, end: f.end, chain: prev });
        end = f.end;
        frames += 1;
        await this.#pause();
      }
      if (!blocked.has(r.device) && scan.tail !== "none") {
        if (scan.tail === "too-large") {
          this.#reject(
            pass,
            { vault: this.vault, device: r.device, seg: r.seg, offset: scan.tailOffset },
            "too-large",
          );
        }
        blocked.add(r.device);
      }
      if (end > have) {
        await this.#local.append(this.vault, r.device, r.seg, have, bytes.subarray(0, end - have));
        localSize.set(key, end);
        pass.pulledFrames += frames;
        for (const c of chains) this.#addChain(r.device, c);
      }
    }

    if (!push || this.#rolledBack || this.#ownTailUncertain)
      return this.#rolledBack ? "conflict" : "delivered";
    const own = localList.filter((s) => s.device === this.device).sort(bySegment);
    let pushedHere = 0;
    for (const s of own) {
      const theirs = remoteSize.get(`${s.device}/${s.seg}`) ?? 0;
      if (s.size <= theirs) continue;
      let bytes = await this.#local.read(this.vault, this.device, s.seg, theirs);
      if (bytes.length > budget.left) {
        // S6: push whole frames up to the budget (at least one per remote and pass), then yield.
        let cut = 0;
        for (const f of scanFrames(bytes, theirs).frames) {
          const end = f.end - theirs;
          if (end > budget.left && (cut > 0 || pushedHere > 0)) break;
          cut = end;
          if (end > budget.left) break;
        }
        if (cut === 0) {
          pass.pushPending = true;
          return "budget";
        }
        if (cut < bytes.length) {
          bytes = bytes.subarray(0, cut);
          pass.pushPending = true;
        }
      }
      try {
        await remote.append(this.vault, this.device, s.seg, theirs, bytes);
      } catch (e) {
        // Someone else changed our segment between list and append (a lost ack, or a clone);
        // the next pass re-lists and decides (rollback check above).
        if (e instanceof TransportError && e.code === "offset-conflict") return "conflict";
        throw e;
      }
      pass.pushedBytes += bytes.length;
      pushedHere += bytes.length;
      budget.left = Math.max(0, budget.left - bytes.length);
      if (pass.pushPending) return "budget";
    }
    return "delivered";
  }

  /**
   * D7: updates the per-writer stuck records from this pass's rejections (the first held frame per
   * writer) and clears every record the sink's cursor has passed; persisted when changed.
   */
  async #noteStuck(pass: Pass): Promise<void> {
    if (!this.#stuckLoaded) {
      this.#stuckLoaded = true;
      if (this.#gateState?.loadStuck) {
        const loaded = parseStuck(await this.#gateState.loadStuck());
        for (const [device, record] of loaded)
          if (!this.#stuck.has(device)) this.#stuck.set(device, record);
      }
    }
    const before = JSON.stringify([...this.#stuck.values()]);
    const first = new Map<DeviceId, RejectedFrame>();
    for (const row of pass.rejected) {
      const known = first.get(row.device);
      if (!known || comparePositions(row, known) < 0) first.set(row.device, row);
    }
    const cursors = await this.#sink.cursors();
    for (const [device, record] of this.#stuck) {
      if (first.has(device)) continue;
      const cursor = cursors.get(device) ?? START_CURSOR;
      // The stream moved past the frame (applied), or past it as far as the log reaches.
      if (comparePositions(cursor, { seg: record.seg, offset: record.offset }) > 0)
        this.#stuck.delete(device);
    }
    const now = this.#physical.now();
    for (const [device, row] of first) {
      const known = this.#stuck.get(device);
      const same =
        known !== undefined &&
        known.seg === row.seg &&
        known.offset === row.offset &&
        known.code === row.code;
      this.#stuck.set(device, {
        device,
        seg: row.seg,
        offset: row.offset,
        code: row.code,
        kind: stuckKind(row.code),
        firstSeenAt: same ? known.firstSeenAt : now,
        passes: same ? known.passes + 1 : 1,
      });
    }
    const after = JSON.stringify([...this.#stuck.values()]);
    if (after !== before) await this.#gateState?.saveStuck?.(after);
  }

  /** Exact-end lookup against authenticated local frames, bounded to four requests per pass. */
  async #resolveHistoricalLookups(pass: Pass): Promise<void> {
    const requests = this.#gate.takeHistoricalLookups?.() ?? [];
    if (
      requests.length === 0 ||
      !this.#gate.historicalHeadsInFrame ||
      !this.#gate.resolveHistoricalLookup
    )
      return;
    const segments = [...(await this.#local.list(this.vault))]
      .filter((s) => s.seg >= 1)
      .sort(bySegment);
    const byWriter = new Map<DeviceId, SegmentInfo[]>();
    for (const segment of segments) {
      const list = byWriter.get(segment.device) ?? [];
      list.push(segment);
      byWriter.set(segment.device, list);
    }
    for (const [writer, list] of byWriter) {
      if (!this.#chains.has(writer)) await this.#indexStream(writer, list);
    }
    const found = new Map(requests.map((r) => [r.candidate, new Set<string>()]));
    const matching = new Map<string, FrameHead>();
    const unavailable = new Set<string>();
    for (const [writer, list] of byWriter) {
      let prev = this.#codec.genesis(this.vault, writer, 1);
      let expected = 1;
      for (const segment of list) {
        if (segment.seg !== expected) return;
        const bytes = await this.#local.read(this.vault, writer, segment.seg, 0);
        if (bytes.length !== segment.size) return;
        const scan = scanFrames(bytes, 0);
        if (scan.tail !== "none") return;
        for (const frame of scan.frames) {
          const at = { vault: this.vault, device: writer, seg: segment.seg, offset: frame.offset };
          let opened: Opened;
          try {
            opened = await this.#open(frame.sealed, at, prev, pass);
          } catch {
            return;
          }
          prev = opened.head.chain;
          const decoded = decodePayload(opened.plain, writer);
          if (!decoded.ok || !this.#gate.authenticate(opened.head, decoded.payload.events).ok)
            return;
          for (const request of requests) {
            if (unavailable.has(request.candidate)) continue;
            const historical = this.#gate.historicalHeadsInFrame(
              opened.head,
              decoded.payload.events,
              request.device,
              request.end,
            );
            if (!historical) {
              unavailable.add(request.candidate);
              continue;
            }
            for (const head of historical) {
              const decodedHead = decodeHead(head);
              if (!decodedHead) continue;
              const position = comparePositions(decodedHead, request.end);
              if (position === 0) {
                const exact = found.get(request.candidate);
                if (!exact || exact.size >= 64) return;
                exact.add(head);
              } else if (position < 0) {
                const held = this.#chains
                  .get(request.device)
                  ?.find(
                    (entry) => entry.seg === decodedHead.seg && entry.end === decodedHead.offset,
                  );
                if (!held || !equalBytes(held.chain, decodedHead.chain)) continue;
                const prior = matching.get(request.candidate);
                if (!prior || comparePositions(decodedHead, prior) > 0)
                  matching.set(request.candidate, decodedHead);
              }
            }
          }
        }
        expected += 1;
      }
    }
    for (const request of requests) {
      if (unavailable.has(request.candidate)) continue;
      this.#gate.resolveHistoricalLookup(request.candidate, [
        ...(found.get(request.candidate) ?? []),
        ...(matching.has(request.candidate)
          ? [encodeHead(matching.get(request.candidate) as FrameHead)]
          : []),
      ]);
    }
    await this.#saveEvidence();
  }

  /**
   * Apply every complete, not yet applied frame or frame group of the local log. The first call after
   * start walks every stream from its start so the gate sees every frame's statements, delivering
   * only what lies after the sink's cursor.
   */
  async #applyLocal(pass: Pass): Promise<void> {
    const cursors = await this.#sink.cursors();
    const streams = new Map<DeviceId, SegmentInfo[]>();
    for (const s of [...(await this.#local.list(this.vault))].sort(bySegment)) {
      if (s.seg < 1) continue;
      const list = streams.get(s.device) ?? [];
      list.push(s);
      streams.set(s.device, list);
    }
    const replay = !this.#primed && this.#gate.needsReplay();
    for (const [device, segs] of streams) {
      if (!this.#chains.has(device)) await this.#indexStream(device, segs);
    }
    if (replay) await this.#loadEvidence();
    const restored = replay ? await this.#restoreGate(pass) : undefined;
    if (replay) await this.#observeAll(streams, pass, restored);
    for (const [device, segs] of streams) {
      const cursor = cursors.get(device) ?? START_CURSOR;
      let from = replay ? START_CURSOR : cursor;
      const at = restored?.get(device);
      if (at) {
        // Restored: frames up to `at` were judged before the restart; judge again only from the
        // earlier of it and the view's cursor (a view ahead of the snapshot re-judges the gap).
        const judged = { seg: at.seg, offset: at.offset };
        from = comparePositions(judged, cursor) < 0 ? judged : cursor;
      }
      await this.#applyStream(device, segs, from, cursor, pass);
    }
    await this.#flush(pass);
    this.#primed = true;
  }

  /**
   * Replay, phase 1: every verified frame's statements go to the gate before any data is judged
   * (a revocation in one stream decides data in another), repeated while frames of writers that
   * became known in a round verify in the next.
   */
  async #observeAll(
    streams: ReadonlyMap<DeviceId, SegmentInfo[]>,
    pass: Pass,
    restored: ReadonlyMap<DeviceId, FrameHead> | undefined,
  ): Promise<void> {
    const done = new Map<DeviceId, number>();
    for (let round = 0, progress = true; progress && round < MAX_ROUNDS * 4; round++) {
      progress = false;
      for (const [device, segs] of streams) {
        // A restored gate saw every frame up to its position: the walk starts after it.
        const at = restored?.get(device);
        let prev = at?.chain ?? this.#codec.genesis(this.vault, device, 1);
        let index = 0;
        frames: for (const s of segs) {
          if (at && s.seg < at.seg) continue;
          const start = at && s.seg === at.seg ? at.offset : 0;
          const bytes = await this.#local.read(this.vault, device, s.seg, start);
          for (const f of scanFrames(bytes, start).frames) {
            const at = { vault: this.vault, device, seg: s.seg, offset: f.offset };
            let opened: Opened;
            try {
              opened = await this.#open(f.sealed, at, prev, pass);
            } catch {
              break frames;
            }
            prev = opened.head.chain;
            index += 1;
            await this.#pause();
            if (index <= (done.get(device) ?? 0)) continue;
            const decoded = decodePayload(opened.plain, device);
            const events = decoded.ok ? decoded.payload.events : [];
            if (!this.#gate.authenticate(opened.head, events).ok) break frames;
            this.#gate.observe(opened.head, events);
            done.set(device, index);
            progress = true;
          }
        }
      }
    }
  }

  async #applyStream(
    device: DeviceId,
    segs: readonly SegmentInfo[],
    from: SegmentCursor,
    cursor: SegmentCursor,
    pass: Pass,
  ): Promise<void> {
    const own = device === this.device;
    let group: { events: WireEvent[]; count: number; next: number; bytes: number } | undefined;
    let prev = this.#chainBefore(device, from.seg, from.offset);
    if (!prev) {
      // The view's cursor is not a frame end of the local log: its data cannot be trusted.
      this.#reject(
        pass,
        { vault: this.vault, device, seg: from.seg, offset: from.offset },
        "chain-unknown",
      );
      return;
    }
    for (const s of segs) {
      if (s.seg < from.seg) continue;
      const start = s.seg === from.seg ? from.offset : 0;
      if (start >= s.size) continue;
      const bytes = await this.#local.read(this.vault, device, s.seg, start);
      const scan = scanFrames(bytes, start);
      for (const f of scan.frames) {
        const at = { vault: this.vault, device, seg: s.seg, offset: f.offset };
        let opened: Opened;
        try {
          opened = await this.#open(f.sealed, at, prev, pass);
        } catch (e) {
          this.#reject(pass, at, rejectionCode(e));
          return;
        }
        prev = opened.head.chain;
        await this.#pause();
        const delivered = comparePositions({ seg: s.seg, offset: f.end }, cursor) > 0;
        const decoded = decodePayload(opened.plain, device);
        const events = decoded.ok ? decoded.payload.events : [];
        const verified = this.#gate.authenticate(opened.head, events);
        if (!verified.ok) {
          this.#reject(pass, at, verified.wait ? WRITER_UNKNOWN : verified.code);
          if (verified.wait) pass.waited = true;
          if (!delivered) pass.staleView = true;
          return;
        }
        const accepted = this.#gate.accept(opened.head, events);
        if (accepted.changed) pass.gateChanged = true;
        if (!decoded.ok) {
          this.#reject(pass, at, decoded.code);
          return;
        }
        if (!accepted.verdict.ok) {
          this.#reject(pass, at, accepted.verdict.code);
          if (!delivered) pass.staleView = true;
          return;
        }
        this.#noteJudged(opened.head);
        const { events: batch, part } = decoded.payload;
        const next = { seg: s.seg, offset: f.end };
        if (!part) {
          if (group) {
            this.#reject(pass, at, "malformed");
            return;
          }
          if (delivered) await this.#collect(device, own, batch, next, opened.plain.length, pass);
          continue;
        }
        const [index, count] = part;
        const prevLast = group?.events.at(-1)?.h;
        if (index === 0 && !group) {
          group = { events: [...batch], count, next: 1, bytes: opened.plain.length };
        } else if (
          group &&
          index === group.next &&
          count === group.count &&
          prevLast !== undefined &&
          (batch[0]?.h ?? "") > prevLast
        ) {
          group.events.push(...batch);
          group.next += 1;
          group.bytes += opened.plain.length;
        } else {
          this.#reject(pass, at, "malformed");
          return;
        }
        if (group.next === group.count) {
          if (delivered) {
            await this.#collect(device, own, group.events, next, group.bytes, pass);
          }
          group = undefined;
        }
      }
      if (scan.tail === "too-large") {
        this.#reject(
          pass,
          { vault: this.vault, device, seg: s.seg, offset: scan.tailOffset },
          "too-large",
        );
        return;
      }
      if (scan.tail === "partial") return;
    }
  }

  #noteJudged(head: FrameHead): void {
    const known = this.#judged.get(head.device);
    if (!known || comparePositions(head, known) > 0) this.#judged.set(head.device, head);
  }

  #judgedKey(): string {
    return [...this.#judged.values()]
      .map((h) => `${h.device}:${h.seg}:${h.offset}`)
      .sort()
      .join(",");
  }

  /** Restore the gate's evidence record once after start (independent of the snapshot). */
  async #loadEvidence(): Promise<void> {
    if (this.#evidenceLoaded || !this.#gateState?.loadEvidence || !this.#gate.importEvidence)
      return;
    this.#evidenceLoaded = true;
    this.#gate.importEvidence(await this.#gateState.loadEvidence());
  }

  /** Append new fork proofs to the evidence record (after every write and sync pass); how many. */
  async #saveEvidence(): Promise<number> {
    const evidence = this.#gate.takeEvidence?.() ?? [];
    if (evidence.length > 0) await this.#gateState?.appendEvidence?.(evidence);
    return evidence.length;
  }

  /** Save the gate's snapshot when it judged new frames since the last one (S29c-B3). */
  async #saveGate(): Promise<void> {
    await this.#saveEvidence();
    if (!this.#gateState || !this.#gate.exportState || this.#judged.size === 0) return;
    const key = this.#judgedKey();
    if (key === this.#savedKey) return;
    const state = this.#gate.exportState(this.#judged);
    if (state === undefined) return;
    await this.#gateState.save(state);
    this.#savedKey = key;
  }

  /**
   * The first replay after start: restore the gate from its snapshot when it authenticates and
   * every position is a frame of the local log with the same chain and signature; the positions,
   * or undefined (no snapshot, or one that fails a check: the caller replays everything).
   */
  async #restoreGate(pass: Pass): Promise<ReadonlyMap<DeviceId, FrameHead> | undefined> {
    if (this.#restoreTried || !this.#gateState || !this.#gate.importState) return undefined;
    this.#restoreTried = true;
    let state: string | undefined;
    try {
      state = await this.#gateState.load();
    } catch {
      return undefined;
    }
    if (state === undefined) return undefined;
    const imported = this.#gate.importState(state);
    if (!imported) return undefined;
    for (const head of imported.heldHeads ?? [...imported.positions.values()]) {
      if (!(await this.#matchesLog(head.device, head, pass))) {
        return undefined;
      }
    }
    imported.restore();
    this.#judged = new Map(imported.positions);
    this.#savedKey = this.#judgedKey();
    return imported.positions;
  }

  /** Whether the local log holds `device`'s data frame ending at `head`, with its chain and signature. */
  async #matchesLog(device: DeviceId, head: FrameHead, pass: Pass): Promise<boolean> {
    if (head.device !== device || head.stream !== 1) return false;
    const entry = this.#chains
      .get(device)
      ?.find((e) => e.seg === head.seg && e.end === head.offset);
    if (!entry || !equalBytes(entry.chain, head.chain)) return false;
    const bytes = await this.#local.read(this.vault, device, head.seg, 0);
    const frame = scanFrames(bytes, 0).frames.find((f) => f.end === head.offset);
    const prev = frame ? this.#chainBefore(device, head.seg, frame.offset) : undefined;
    if (!frame || !prev) return false;
    try {
      const at = { vault: this.vault, device, seg: head.seg, offset: frame.offset };
      const opened = await this.#open(frame.sealed, at, prev, pass);
      return equalBytes(opened.head.chain, head.chain) && equalBytes(opened.head.sig, head.sig);
    } catch {
      return false;
    }
  }

  /** Queue a batch for the pass's sink transaction; a full chunk is committed first. */
  async #collect(
    device: DeviceId,
    own: boolean,
    events: readonly WireEvent[],
    cursor: SegmentCursor,
    bytes: number,
    pass: Pass,
  ): Promise<void> {
    if (
      pass.pending.length > 0 &&
      (pass.pendingEvents + events.length > this.#maxBatchEvents ||
        pass.pendingBytes + bytes > this.#maxBatchBytes)
    ) {
      await this.#flush(pass);
    }
    pass.pending.push({ vault: this.vault, device, own, events, cursor });
    pass.pendingEvents += events.length;
    pass.pendingBytes += bytes;
  }

  /**
   * Commit the collected batches in one sink transaction. A failure applied nothing: the gate
   * forgets which data it accepted (judged again from the log on the next pass) and the error
   * ends the pass.
   */
  async #flush(pass: Pass): Promise<void> {
    const batches = pass.pending;
    if (batches.length === 0) return;
    pass.pending = [];
    pass.pendingEvents = 0;
    pass.pendingBytes = 0;
    let outcomes: readonly { applied: number; duplicates: number; parked: number }[];
    try {
      if (this.#foreignWalls !== null && this.#clockGuard !== undefined) {
        const next = { ...this.#foreignWalls };
        for (const batch of batches) {
          if (batch.own) continue;
          for (const event of batch.events) {
            const wall = Number.parseInt(event.h.slice(0, 9), 36);
            if (!Number.isSafeInteger(wall) || wall < 0)
              throw new SyncError("invalid-event", "invalid foreign clock wall");
            next[batch.device] = Math.max(next[batch.device] ?? 0, wall);
          }
        }
        await this.#clockGuard.save(next);
        this.#foreignWalls = next;
      }
      outcomes = await this.#sink.applyBatches(batches);
    } catch (e) {
      this.#gate.reset();
      this.#primed = false;
      throw e;
    }
    for (const [i, batch] of batches.entries()) {
      const outcome = outcomes[i] ?? { applied: 0, duplicates: 0, parked: 0 };
      pass.batches += 1;
      pass.applied += outcome.applied;
      pass.duplicates += outcome.duplicates;
      pass.parked += outcome.parked;
      if (outcome.parked > 0) {
        pass.needsUpgrade = true;
        pass.parkedDevices.add(batch.device);
      }
      for (const e of batch.events) pass.types.add(e.t);
      if (batch.own) continue;
      for (const e of batch.events) {
        const warning = this.#clock.receive(e.h);
        if (!warning) {
          pass.clockDirty = true;
          continue;
        }
        const prev = pass.warnings.get(warning.device);
        if (!prev || warning.aheadMs > prev.aheadMs) pass.warnings.set(warning.device, warning);
      }
    }
  }
}
