// The own-log carrier: a `Transport` decorator between the engine and a byte store (synced folder,
// relay, memory) that makes eventual storage safe for the engine's per-device streams.
//
// Why: the engine applies a device's segments in order and moves its cursor into segment N as soon
// as it applies a frame there. On eventual storage a device can see segment N while N - 1 is missing
// or still an older, frame-aligned version; applying N would skip the rest of N - 1 until a rebuild.
//
// How: the writer records "segment N - 1 is final at S bytes" in its manifest stream (segment 0,
// manifest.ts) BEFORE it creates segment N. Readers expose another device's segment N only once
// N - 1 is present up to its recorded size; a missing early segment, an incomplete one or a manifest
// still on its way holds the rest of that stream (reported by `status`, retried on the next pass).
// Records are sealed with the vault codec at their position, so storage can withhold them (the stream
// waits) but not forge them. The device's own segments pass through ungated (its local log is the
// authority; the engine's rollback check needs their true sizes).
//
// Compaction hooks (full compaction is S32): `markSnapshot` records a snapshot boundary,
// `retireBefore` records that early segments may disappear (a gap below it is reported as
// `compacted`, not `missing`), and `resumeFrom` lets a device that installed a snapshot start a
// stream at the snapshot's segment.
import type {
  DeviceId,
  FrameCodec,
  SegmentCursor,
  SegmentInfo,
  Transport,
  TransportConsistency,
  VaultId,
} from "../../carrier.js";
import { rejectionCode, TransportError } from "../../errors.js";
import { frameBytes, scanFrames } from "../../segment.js";
import {
  decodeRecord,
  encodeRecord,
  MANIFEST_SEG,
  type ManifestRecord,
  SNAPSHOT_REF_RE,
} from "./manifest.js";

export type HoldReason =
  /** An earlier segment is not in storage (not synced yet, evicted, lost). */
  | "missing"
  /** The earlier segment is shorter than its recorded final size (still syncing). */
  | "incomplete"
  /** The writer's "closed" record for the earlier segment has not arrived yet. */
  | "awaiting-manifest"
  /** The earlier segment was retired by compaction: this device needs a snapshot (S32). */
  | "compacted"
  /** Two verified records give one segment two final sizes (a forked writer: re-pair it, S29). */
  | "conflict";

export interface SnapshotMarker {
  readonly at: SegmentCursor;
  readonly ref: string;
}

export interface StreamStatus {
  readonly device: DeviceId;
  /** Last segment shown to the engine and its readable size (undefined: nothing yet). */
  readonly exposed?: { readonly seg: number; readonly size: number };
  /** The first segment held back and why. */
  readonly held?: { readonly seg: number; readonly reason: HoldReason };
  /** First manifest record that did not open or parse; later records wait for it. */
  readonly manifestRejected?: { readonly offset: number; readonly code: string };
  /** Segments that are longer in storage than their recorded final size (only the size is read). */
  readonly overrun: readonly number[];
  readonly snapshots: readonly SnapshotMarker[];
  /** Segments below this were retired by the writer (1 = none). */
  readonly retiredBefore: number;
}

export interface OwnLogCarrierOptions {
  /** The byte store: a folder transport, a relay client, a memory transport. */
  readonly transport: Transport;
  /** The vault's frame codec; seals and opens manifest records. */
  readonly codec: FrameCodec;
  /** The device using this handle: its own segments are not gated. */
  readonly device: DeviceId;
  /** S32: where a device's stream resumes after its snapshot was installed (earlier segments not needed). */
  readonly resumeFrom?: (vault: VaultId, device: DeviceId) => SegmentCursor | undefined;
}

interface ManifestState {
  /** Verified bytes of segment 0. */
  offset: number;
  readonly closed: Map<number, number>;
  readonly conflicts: Set<number>;
  readonly snapshots: SnapshotMarker[];
  retiredBefore: number;
  rejected: { offset: number; code: string } | undefined;
}

interface Gate {
  /** seg -> readable size cap (Infinity for the open, still growing segment). */
  readonly caps: Map<number, number>;
  readonly status: StreamStatus;
}

const EMPTY = new Uint8Array(0);

function key(vault: VaultId, device: DeviceId): string {
  return `${vault}/${device}`;
}

export class OwnLogCarrier implements Transport {
  readonly device: DeviceId;
  /** The wrapped transport's declaration: gating only hides bytes, it never speeds them up. */
  readonly consistency: TransportConsistency;
  readonly watch?: (vault: VaultId, onChange: () => void) => () => void;
  readonly #raw: Transport;
  readonly #codec: FrameCodec;
  readonly #resumeFrom: OwnLogCarrierOptions["resumeFrom"];
  readonly #manifests = new Map<string, ManifestState>();
  readonly #gates = new Map<string, Gate>();

  constructor(options: OwnLogCarrierOptions) {
    this.device = options.device;
    this.#raw = options.transport;
    this.consistency = options.transport.consistency;
    this.#codec = options.codec;
    this.#resumeFrom = options.resumeFrom;
    const rawWatch = options.transport.watch?.bind(options.transport);
    if (rawWatch) this.watch = (vault, onChange) => rawWatch(vault, onChange);
  }

  async list(vault: VaultId): Promise<readonly SegmentInfo[]> {
    const byDevice = new Map<DeviceId, Map<number, number>>();
    for (const s of await this.#raw.list(vault)) {
      const segs = byDevice.get(s.device) ?? new Map<number, number>();
      segs.set(s.seg, s.size);
      byDevice.set(s.device, segs);
    }
    for (const k of this.#gates.keys()) {
      const [v, device] = k.split("/");
      if (v === vault && device !== undefined && !byDevice.has(device)) this.#gates.delete(k);
    }
    const out: SegmentInfo[] = [];
    for (const [device, segs] of byDevice) {
      const manifestSize = segs.get(MANIFEST_SEG) ?? 0;
      segs.delete(MANIFEST_SEG);
      if (device === this.device) {
        for (const [seg, size] of segs) out.push({ device, seg, size });
        continue;
      }
      const manifest = await this.#manifest(vault, device, manifestSize);
      const gate = this.#gate(vault, device, segs, manifest);
      this.#gates.set(key(vault, device), gate);
      for (const [seg, cap] of gate.caps) {
        out.push({ device, seg, size: Math.min(cap, segs.get(seg) ?? 0) });
      }
    }
    return out;
  }

  async read(
    vault: VaultId,
    device: DeviceId,
    seg: number,
    fromOffset: number,
  ): Promise<Uint8Array> {
    if (seg === MANIFEST_SEG) return EMPTY;
    if (device === this.device) return this.#raw.read(vault, device, seg, fromOffset);
    if (!this.#gates.has(key(vault, device))) await this.list(vault);
    const cap = this.#gates.get(key(vault, device))?.caps.get(seg);
    if (cap === undefined || fromOffset >= cap) return EMPTY;
    const bytes = await this.#raw.read(vault, device, seg, fromOffset);
    return bytes.length > cap - fromOffset ? bytes.subarray(0, cap - fromOffset) : bytes;
  }

  async append(
    vault: VaultId,
    device: DeviceId,
    seg: number,
    atOffset: number,
    bytes: Uint8Array,
  ): Promise<void> {
    if (!Number.isSafeInteger(seg) || seg < 1) {
      throw new RangeError("segment numbers start at 1; segment 0 is the carrier's manifest");
    }
    if (atOffset === 0 && seg > 1 && bytes.length > 0) await this.#close(vault, device, seg - 1);
    await this.#raw.append(vault, device, seg, atOffset, bytes);
  }

  /** Per remote device: what is exposed, what is held and why (as of the last `list`). */
  status(vault: VaultId): StreamStatus[] {
    const prefix = `${vault}/`;
    return [...this.#gates.entries()]
      .filter(([k]) => k.startsWith(prefix))
      .map(([, gate]) => gate.status)
      .sort((a, b) => (a.device < b.device ? -1 : a.device > b.device ? 1 : 0));
  }

  /** Compaction hook (S32): a snapshot of this device's own stream up to `at` exists as `ref`. */
  async markSnapshot(vault: VaultId, at: SegmentCursor, ref: string): Promise<void> {
    if (!SNAPSHOT_REF_RE.test(ref)) throw new RangeError("snapshot ref must match SNAPSHOT_REF_RE");
    if (!Number.isSafeInteger(at.seg) || at.seg < 1 || !Number.isSafeInteger(at.offset)) {
      throw new RangeError("invalid snapshot cursor");
    }
    if (at.offset < 0) throw new RangeError("invalid snapshot cursor");
    await this.#appendOwn(vault, { kind: "snapshot", at: { seg: at.seg, offset: at.offset }, ref });
  }

  /** Compaction hook (S32): segments of this device below `before` may be removed from storage. */
  async retireBefore(vault: VaultId, before: number): Promise<void> {
    if (!Number.isSafeInteger(before) || before < 2) throw new RangeError("invalid segment");
    await this.#appendOwn(vault, { kind: "retired", before });
  }

  /** Snapshot boundaries a device has recorded (verified manifest records). */
  async snapshots(vault: VaultId, device: DeviceId): Promise<readonly SnapshotMarker[]> {
    const size = await this.#manifestSize(vault, device);
    return [...(await this.#manifest(vault, device, size)).snapshots];
  }

  // -------------------------------------------------------------------------------------------

  async #manifestSize(vault: VaultId, device: DeviceId): Promise<number> {
    const raw = await this.#raw.list(vault);
    return raw.find((s) => s.device === device && s.seg === MANIFEST_SEG)?.size ?? 0;
  }

  async #appendOwn(vault: VaultId, record: ManifestRecord): Promise<void> {
    const size = await this.#manifestSize(vault, this.device);
    const manifest = await this.#manifest(vault, this.device, size);
    await this.#appendRecord(vault, this.device, manifest, size, record);
  }

  /** Record that `prev` is final at its current size before the writer creates `prev + 1`. */
  async #close(vault: VaultId, device: DeviceId, prev: number): Promise<void> {
    const raw = await this.#raw.list(vault);
    const info = raw.find((s) => s.device === device && s.seg === prev);
    if (!info) {
      throw new TransportError("offset-conflict", "the previous segment does not exist");
    }
    const size = raw.find((s) => s.device === device && s.seg === MANIFEST_SEG)?.size ?? 0;
    const manifest = await this.#manifest(vault, device, size);
    const known = manifest.closed.get(prev);
    if (known === info.size) return;
    if (known !== undefined) {
      throw new TransportError(
        "offset-conflict",
        "the previous segment was closed at another size",
      );
    }
    await this.#appendRecord(vault, device, manifest, size, {
      kind: "closed",
      seg: prev,
      size: info.size,
    });
  }

  async #appendRecord(
    vault: VaultId,
    device: DeviceId,
    manifest: ManifestState,
    size: number,
    record: ManifestRecord,
  ): Promise<void> {
    const at = { vault, device, seg: MANIFEST_SEG, offset: size };
    const frame = frameBytes(await this.#codec.seal(encodeRecord(record), at));
    await this.#raw.append(vault, device, MANIFEST_SEG, size, frame);
    if (manifest.offset === size && manifest.rejected === undefined) {
      applyRecord(manifest, record);
      manifest.offset = size + frame.length;
    }
  }

  /** Verify and fold the not yet read part of a device's manifest stream. */
  async #manifest(vault: VaultId, device: DeviceId, size: number): Promise<ManifestState> {
    const k = key(vault, device);
    let manifest = this.#manifests.get(k);
    if (!manifest) {
      manifest = {
        offset: 0,
        closed: new Map(),
        conflicts: new Set(),
        snapshots: [],
        retiredBefore: 1,
        rejected: undefined,
      };
      this.#manifests.set(k, manifest);
    }
    if (size <= manifest.offset) return manifest;
    const bytes = await this.#raw.read(vault, device, MANIFEST_SEG, manifest.offset);
    const scan = scanFrames(bytes, manifest.offset);
    manifest.rejected = undefined;
    for (const f of scan.frames) {
      const at = { vault, device, seg: MANIFEST_SEG, offset: f.offset };
      let plain: Uint8Array;
      try {
        plain = await this.#codec.open(f.sealed, at);
      } catch (e) {
        manifest.rejected = { offset: f.offset, code: rejectionCode(e) };
        return manifest;
      }
      const decoded = decodeRecord(plain);
      if (!decoded.ok) {
        manifest.rejected = { offset: f.offset, code: decoded.code };
        return manifest;
      }
      if (decoded.record) applyRecord(manifest, decoded.record);
      manifest.offset = f.end;
    }
    if (scan.tail === "too-large")
      manifest.rejected = { offset: scan.tailOffset, code: "too-large" };
    return manifest;
  }

  #gate(
    vault: VaultId,
    device: DeviceId,
    segs: ReadonlyMap<number, number>,
    manifest: ManifestState,
  ): Gate {
    const caps = new Map<number, number>();
    const overrun: number[] = [];
    const highest = Math.max(0, ...segs.keys());
    let held: StreamStatus["held"];
    let k = Math.max(1, this.#resumeFrom?.(vault, device)?.seg ?? 1);
    for (;;) {
      const size = segs.get(k);
      if (size === undefined) {
        if (highest > k)
          held = { seg: k, reason: k < manifest.retiredBefore ? "compacted" : "missing" };
        break;
      }
      if (manifest.conflicts.has(k)) {
        held = { seg: k, reason: "conflict" };
        break;
      }
      const closed = manifest.closed.get(k);
      if (closed === undefined) {
        caps.set(k, Number.POSITIVE_INFINITY);
        if (highest > k) held = { seg: k + 1, reason: "awaiting-manifest" };
        break;
      }
      caps.set(k, closed);
      if (size > closed) overrun.push(k);
      if (size < closed) {
        if (highest > k) held = { seg: k + 1, reason: "incomplete" };
        break;
      }
      k += 1;
    }
    let exposed: StreamStatus["exposed"];
    for (const [seg, cap] of caps) {
      if (!exposed || seg > exposed.seg) exposed = { seg, size: Math.min(cap, segs.get(seg) ?? 0) };
    }
    const status: StreamStatus = {
      device,
      overrun,
      snapshots: [...manifest.snapshots],
      retiredBefore: manifest.retiredBefore,
      ...(exposed ? { exposed } : {}),
      ...(held ? { held } : {}),
      ...(manifest.rejected ? { manifestRejected: { ...manifest.rejected } } : {}),
    };
    return { caps, status };
  }
}

function applyRecord(manifest: ManifestState, record: ManifestRecord): void {
  switch (record.kind) {
    case "closed": {
      const known = manifest.closed.get(record.seg);
      if (known === undefined) manifest.closed.set(record.seg, record.size);
      else if (known !== record.size) manifest.conflicts.add(record.seg);
      return;
    }
    case "snapshot":
      manifest.snapshots.push({ at: record.at, ref: record.ref });
      return;
    case "retired":
      manifest.retiredBefore = Math.max(manifest.retiredBefore, record.before);
      return;
  }
}

export function createOwnLogCarrier(options: OwnLogCarrierOptions): OwnLogCarrier {
  return new OwnLogCarrier(options);
}
