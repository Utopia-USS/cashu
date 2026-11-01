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
import type {
  AppliedInfo,
  ClockStore,
  DeviceId,
  EventSink,
  FrameCodec,
  FrameGate,
  FrameHead,
  FramePosition,
  GateStateStore,
  InboundBatch,
  LeaseTransport,
  RejectedFrame,
  SegmentCursor,
  SegmentInfo,
  SyncEngine,
  SyncResult,
  Transport,
  UnstampedEvent,
  VaultId,
  WireEvent,
  WriteResult,
} from "./carrier.js";
import { propagationBound, START_CURSOR } from "./carrier.js";
import { isTransportUnavailable, rejectionCode, SyncError, TransportError } from "./errors.js";
import {
  type ClockWarning,
  DEVICE_RE,
  HybridClock,
  type PhysicalClock,
  systemClock,
} from "./hlc.js";
import { queueTask } from "./runtime.js";
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
  readonly sink: EventSink;
  readonly clockStore: ClockStore;
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
}

/** D12 caps of one sink transaction: a daily pull is one transaction, a 64k first sync three. */
export const DEFAULT_MAX_BATCH_EVENTS = 25_000;
export const DEFAULT_MAX_BATCH_BYTES = 32 * 1024 * 1024;

export async function createSyncEngine(options: SyncEngineOptions): Promise<SyncEngine> {
  if (!VAULT_RE.test(options.vault)) throw new SyncError("invalid-config", "invalid vault id");
  if (!DEVICE_RE.test(options.device)) throw new SyncError("invalid-config", "invalid device id");
  const restored = await options.clockStore.load();
  const engine = new OwnLogEngine(options, restored);
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

/** Rounds of pull + apply in one `sync()` while the registry changes and streams wait. */
const MAX_ROUNDS = 4;

interface Pass {
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
  needsUpgrade: boolean;
  offlineRemotes: number;
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
    needsUpgrade: false,
    offlineRemotes: 0,
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
  readonly #sink: EventSink;
  readonly #clockStore: ClockStore;
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
  #ownSeg = 1;
  #ownSize = 0;
  /** Chain after every frame of the local log, per device, in stream order (data stream). */
  readonly #chains = new Map<DeviceId, ChainEntry[]>();
  /** False until the gate has seen every frame of the local log once (after start). */
  #primed = false;

  constructor(o: SyncEngineOptions, restored: { wall: number; counter: number } | undefined) {
    this.vault = o.vault;
    this.device = o.device;
    this.#local = o.local;
    this.#remotes = o.remotes ?? [];
    this.#codec = o.codec;
    this.#gate = o.gate;
    this.#sink = o.sink;
    this.#clockStore = o.clockStore;
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

  write(events: readonly UnstampedEvent[]): Promise<WriteResult> {
    return this.#run(async () => {
      this.#assertOpen();
      if (this.#rolledBack) {
        throw new SyncError("rolled-back", "this device's log is ahead of its clock; re-pair it");
      }
      if (events.length === 0) throw new SyncError("invalid-event", "empty batch");
      if (!events.every(isUnstampedEvent)) {
        throw new SyncError("invalid-event", "invalid event in batch");
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
    });
  }

  sync(): Promise<SyncResult> {
    return this.#run(async () => {
      this.#assertOpen();
      const pass = newPass();
      // A gate with statement state sees the local log first, so every stream's key is bound by its
      // first frame before anything new is verified.
      if (!this.#primed && this.#gate.needsReplay()) await this.#applyLocal(pass);
      this.#leaseTransport = { kind: "eventual" };
      const bounded: { propagationMs: number; pullAt: number; pushAt: number }[] = [];
      let boundedOffline = false;
      for (const remote of this.#remotes) {
        const bound = propagationBound(remote.consistency);
        const pullAt = this.#physical.now();
        try {
          await this.#replicate(remote, pass);
          if (bound !== undefined) {
            bounded.push({ propagationMs: bound, pullAt, pushAt: this.#physical.now() });
          }
        } catch (e) {
          if (!isTransportUnavailable(e)) throw e;
          pass.offlineRemotes += 1;
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
        for (const remote of this.#remotes) {
          try {
            await this.#replicate(remote, pass, false);
          } catch (e) {
            if (!isTransportUnavailable(e)) throw e;
          }
        }
      }
      this.#leaseTransport =
        bounded.length > 0 && !boundedOffline
          ? {
              kind: "bounded",
              propagationMs: Math.max(...bounded.map((b) => b.propagationMs)),
              lastPullAt: Math.min(...bounded.map((b) => b.pullAt)),
              lastPushAt: Math.max(...bounded.map((b) => b.pushAt)),
            }
          : { kind: "eventual" };
      await this.#applyLocal(pass);
      await this.#rebuildIfNeeded(pass);
      await this.#saveGate();
      return this.#finish(pass);
    });
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
    return this.#leaseTransport;
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
    const p = this.#tail.then(fn);
    this.#tail = p.catch(() => undefined);
    return p;
  }

  #assertOpen(): void {
    if (this.#closed) throw new SyncError("closed", "the sync engine is closed");
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

  /** Push own bytes to `remote`, pull verified foreign frames from it into the local log. */
  async #replicate(remote: Transport, pass: Pass, push = true): Promise<void> {
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

    if (!push) return;
    const own = localList.filter((s) => s.device === this.device).sort(bySegment);
    for (const s of own) {
      const theirs = remoteSize.get(`${s.device}/${s.seg}`) ?? 0;
      if (s.size <= theirs) continue;
      const bytes = await this.#local.read(this.vault, this.device, s.seg, theirs);
      try {
        await remote.append(this.vault, this.device, s.seg, theirs, bytes);
      } catch (e) {
        // Someone else changed our segment between list and append (a lost ack, or a clone);
        // the next pass re-lists and decides (rollback check above).
        if (e instanceof TransportError && e.code === "offset-conflict") break;
        throw e;
      }
      pass.pushedBytes += bytes.length;
    }
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

  /** Append new fork proofs to the evidence record (after every write and sync pass). */
  async #saveEvidence(): Promise<void> {
    const evidence = this.#gate.takeEvidence?.() ?? [];
    if (evidence.length > 0) await this.#gateState?.appendEvidence?.(evidence);
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
    for (const [device, head] of imported.positions) {
      if (!(await this.#matchesLog(device, head, pass))) return undefined;
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
      if (outcome.parked > 0) pass.needsUpgrade = true;
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
