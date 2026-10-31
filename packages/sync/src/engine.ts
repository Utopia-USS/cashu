// The own-log sync engine: one per (vault, device). See carrier.ts for the model.
//
// Invariants
// - Writes: stamp (HLC) -> persist the clock -> seal every frame -> append to the own local segment ->
//   apply from the local log through the same path as remote frames. The clock is saved before the
//   append, so a persisted clock behind the device's own log means a rollback (events.md 3.2).
// - Pull: a foreign frame enters the local log only after the codec opened it, so the local copy never
//   holds a tampered frame and a rejected frame is retried from the remote on the next pass.
// - Apply: per device stream in segment order, one sink call per frame or per complete frame group,
//   cursor persisted by the sink with the batch. A partial frame or an incomplete group leaves the
//   cursor where it is; a rejected frame stops that device's stream for this pass only.
// - Every public operation runs serialized on one queue.
import type {
  AppliedInfo,
  ClockStore,
  DeviceId,
  EventSink,
  FrameCodec,
  FramePosition,
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
  decodePayload,
  encodePayload,
  frameBytes,
  isRecord,
  LENGTH_BYTES,
  MAX_SEALED_FRAME_BYTES,
  scanFrames,
} from "./segment.js";

export const VAULT_RE = /^[0-9A-Za-z_-]{1,64}$/;

export interface SyncEngineOptions {
  readonly vault: VaultId;
  readonly device: DeviceId;
  /** The device's own full copy of the log (always reachable; writes land here first). */
  readonly local: Transport;
  /** Replication targets: synced folder, relay. Empty = local only. */
  readonly remotes?: readonly Transport[];
  readonly codec: FrameCodec;
  readonly sink: EventSink;
  readonly clockStore: ClockStore;
  readonly physicalClock?: PhysicalClock;
  /** Drift limit for both clock guards (default 5 minutes, events.md 3.3). */
  readonly maxDriftMs?: number;
  /** Events per frame before a batch becomes a frame group (default 1000, as in the spike). */
  readonly maxFrameEvents?: number;
  /** Approximate plaintext bytes per frame before splitting (default 1 MiB). */
  readonly maxFrameBytes?: number;
  /** Soft segment size cap; a new segment starts when a frame would cross it (default 4 MiB). */
  readonly maxSegmentBytes?: number;
}

export async function createSyncEngine(options: SyncEngineOptions): Promise<SyncEngine> {
  if (!VAULT_RE.test(options.vault)) throw new SyncError("invalid-config", "invalid vault id");
  if (!DEVICE_RE.test(options.device)) throw new SyncError("invalid-config", "invalid device id");
  const restored = await options.clockStore.load();
  const engine = new OwnLogEngine(options, restored);
  await engine.init();
  return engine;
}

interface Pass {
  cache: Map<string, Uint8Array>;
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
}

function newPass(): Pass {
  return {
    cache: new Map(),
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
  readonly #sink: EventSink;
  readonly #clockStore: ClockStore;
  readonly #clock: HybridClock;
  readonly #maxFrameEvents: number;
  readonly #maxFrameBytes: number;
  readonly #maxSegmentBytes: number;
  readonly #physical: PhysicalClock;
  readonly #listeners = new Set<(info: AppliedInfo) => void>();
  #leaseTransport: LeaseTransport = { kind: "eventual" };
  #tail: Promise<unknown> = Promise.resolve();
  #closed = false;
  #rolledBack = false;
  #ownSeg = 1;
  #ownSize = 0;

  constructor(o: SyncEngineOptions, restored: { wall: number; counter: number } | undefined) {
    this.vault = o.vault;
    this.device = o.device;
    this.#local = o.local;
    this.#remotes = o.remotes ?? [];
    this.#codec = o.codec;
    this.#sink = o.sink;
    this.#clockStore = o.clockStore;
    this.#physical = o.physicalClock ?? systemClock;
    this.#clock = new HybridClock(o.device, {
      ...(o.physicalClock ? { physical: o.physicalClock } : {}),
      ...(o.maxDriftMs === undefined ? {} : { maxDriftMs: o.maxDriftMs }),
      ...(restored ? { restore: restored } : {}),
    });
    this.#maxFrameEvents = Math.max(1, o.maxFrameEvents ?? 1000);
    this.#maxFrameBytes = Math.max(1, o.maxFrameBytes ?? 1024 * 1024);
    this.#maxSegmentBytes = Math.max(1, o.maxSegmentBytes ?? 4 * 1024 * 1024);
  }

  /** Find the own write position and detect a rolled-back clock (own log ahead of the clock). */
  async init(): Promise<void> {
    const own = (await this.#local.list(this.vault))
      .filter((s) => s.device === this.device)
      .sort(bySegment);
    const last = own.at(-1);
    if (!last) return;
    this.#ownSeg = last.seg;
    this.#ownSize = last.size;
    const bytes = await this.#local.read(this.vault, this.device, last.seg, 0);
    const frame = scanFrames(bytes, 0).frames.at(-1);
    if (!frame) return;
    const at = { vault: this.vault, device: this.device, seg: last.seg, offset: frame.offset };
    let lastHlc: string | undefined;
    try {
      const decoded = decodePayload(await this.#codec.open(frame.sealed, at), this.device);
      lastHlc = decoded.ok ? decoded.payload.events.at(-1)?.h : undefined;
    } catch {
      lastHlc = undefined;
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
      const sealedFrames: { at: FramePosition; bytes: Uint8Array }[] = [];
      const cache = new Map<string, Uint8Array>();
      let seg = this.#ownSeg;
      let size = this.#ownSize;
      for (const [index, group] of groups.entries()) {
        const plain = encodePayload(
          groups.length > 1 ? { events: group, part: [index, groups.length] } : { events: group },
        );
        if (size > 0 && size + LENGTH_BYTES + plain.length > this.#maxSegmentBytes) {
          seg += 1;
          size = 0;
        }
        const at = { vault: this.vault, device: this.device, seg, offset: size };
        const sealed = await this.#codec.seal(plain, at);
        if (sealed.length > MAX_SEALED_FRAME_BYTES) {
          throw new SyncError("frame-too-large", "an event is larger than the frame limit");
        }
        const bytes = frameBytes(sealed);
        sealedFrames.push({ at, bytes });
        cache.set(posKey(at), plain);
        size += bytes.length;
      }
      for (const f of sealedFrames) {
        await this.#local.append(this.vault, this.device, f.at.seg, f.at.offset, f.bytes);
        this.#ownSeg = f.at.seg;
        this.#ownSize = f.at.offset + f.bytes.length;
      }

      const pass = newPass();
      pass.cache = cache;
      await this.#applyLocal(pass);
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
      return this.#finish(pass);
    });
  }

  rebuild(): Promise<SyncResult> {
    return this.#run(async () => {
      this.#assertOpen();
      await this.#sink.reset();
      const pass = newPass();
      await this.#applyLocal(pass);
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

  /** Push own bytes to `remote`, pull verified foreign frames from it into the local log. */
  async #replicate(remote: Transport, pass: Pass): Promise<void> {
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
      if (r.size <= have || blocked.has(r.device)) continue;
      const bytes = await remote.read(this.vault, r.device, r.seg, have);
      const scan = scanFrames(bytes, have);
      let end = have;
      let frames = 0;
      for (const f of scan.frames) {
        const at = { vault: this.vault, device: r.device, seg: r.seg, offset: f.offset };
        try {
          pass.cache.set(posKey(at), await this.#codec.open(f.sealed, at));
        } catch (e) {
          this.#reject(pass, at, rejectionCode(e));
          blocked.add(r.device);
          break;
        }
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
      }
    }

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

  /** Apply every complete, not yet applied frame or frame group of the local log. */
  async #applyLocal(pass: Pass): Promise<void> {
    const cursors = await this.#sink.cursors();
    const streams = new Map<DeviceId, SegmentInfo[]>();
    for (const s of [...(await this.#local.list(this.vault))].sort(bySegment)) {
      const list = streams.get(s.device) ?? [];
      list.push(s);
      streams.set(s.device, list);
    }
    for (const [device, segs] of streams) {
      await this.#applyStream(device, segs, cursors.get(device) ?? START_CURSOR, pass);
    }
  }

  async #applyStream(
    device: DeviceId,
    segs: readonly SegmentInfo[],
    cursor: SegmentCursor,
    pass: Pass,
  ): Promise<void> {
    const own = device === this.device;
    let group: { events: WireEvent[]; count: number; next: number } | undefined;
    for (const s of segs) {
      if (s.seg < cursor.seg) continue;
      const start = s.seg === cursor.seg ? cursor.offset : 0;
      if (start >= s.size) continue;
      const bytes = await this.#local.read(this.vault, device, s.seg, start);
      const scan = scanFrames(bytes, start);
      for (const f of scan.frames) {
        const at = { vault: this.vault, device, seg: s.seg, offset: f.offset };
        let plain = pass.cache.get(posKey(at));
        if (!plain) {
          try {
            plain = await this.#codec.open(f.sealed, at);
          } catch (e) {
            this.#reject(pass, at, rejectionCode(e));
            return;
          }
        }
        const decoded = decodePayload(plain, device);
        if (!decoded.ok) {
          this.#reject(pass, at, decoded.code);
          return;
        }
        const { events, part } = decoded.payload;
        const next = { seg: s.seg, offset: f.end };
        if (!part) {
          if (group) {
            this.#reject(pass, at, "malformed");
            return;
          }
          await this.#deliver(device, own, events, next, pass);
          continue;
        }
        const [index, count] = part;
        const prevLast = group?.events.at(-1)?.h;
        if (index === 0 && !group) {
          group = { events: [...events], count, next: 1 };
        } else if (
          group &&
          index === group.next &&
          count === group.count &&
          prevLast !== undefined &&
          (events[0]?.h ?? "") > prevLast
        ) {
          group.events.push(...events);
          group.next += 1;
        } else {
          this.#reject(pass, at, "malformed");
          return;
        }
        if (group.next === group.count) {
          await this.#deliver(device, own, group.events, next, pass);
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

  async #deliver(
    device: DeviceId,
    own: boolean,
    events: readonly WireEvent[],
    cursor: SegmentCursor,
    pass: Pass,
  ): Promise<void> {
    const outcome = await this.#sink.apply({ vault: this.vault, device, own, events, cursor });
    pass.batches += 1;
    pass.applied += outcome.applied;
    pass.duplicates += outcome.duplicates;
    pass.parked += outcome.parked;
    if (outcome.parked > 0) pass.needsUpgrade = true;
    for (const e of events) pass.types.add(e.t);
    if (own) return;
    for (const e of events) {
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
