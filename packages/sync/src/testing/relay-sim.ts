// A simulated relay for the propagation conformance check and the contract suite (synthetic data,
// manual clock). Appends are linearizable at the relay (one authoritative size per segment, so the
// append offset check is exact), but another device's handle sees an append only `actualDelayMs`
// after it was made (a reader served by a lagging replica, a cache, an eventually consistent store).
// The writer's own handle sees its appends at once. Per segment, a later chunk is never visible
// before an earlier one. What the relay DECLARES is configured separately from what it DOES, so a
// test can build an honest relay (actual <= declared) and a lying one (actual > declared).

import type {
  DeviceId,
  SegmentInfo,
  Transport,
  TransportConsistency,
  VaultId,
} from "../carrier.js";
import { TransportError } from "../errors.js";
import { concatBytes } from "../segment.js";
import type { ManualClock } from "./faults.js";

export interface SimulatedRelayOptions {
  readonly clock: ManualClock;
  /** What every handle declares. */
  readonly consistency: TransportConsistency;
  /** How long an append really takes to reach another device's handle (ms). */
  readonly actualDelayMs: number;
}

interface Chunk {
  readonly bytes: Uint8Array;
  readonly at: number;
  readonly by: DeviceId;
}

export class SimulatedRelay {
  readonly #o: SimulatedRelayOptions;
  readonly #segments = new Map<VaultId, Map<string, Chunk[]>>();

  constructor(options: SimulatedRelayOptions) {
    this.#o = options;
  }

  /** The relay as `device` sees it. */
  handle(device: DeviceId): Transport {
    return {
      consistency: this.#o.consistency,
      list: async (vault) => this.#list(vault, device),
      read: async (vault, dev, seg, from) => this.#read(vault, dev, seg, from, device),
      append: async (vault, dev, seg, at, bytes) =>
        this.#append(vault, dev, seg, at, bytes, device),
    };
  }

  /** Lets every append reach every handle (the medium's `settle`). */
  async settle(): Promise<void> {
    this.#o.clock.advance(this.#o.actualDelayMs);
  }

  #visible(chunks: readonly Chunk[], reader: DeviceId): Chunk[] {
    const now = this.#o.clock.now();
    const out: Chunk[] = [];
    for (const c of chunks) {
      if (c.by !== reader && now < c.at + this.#o.actualDelayMs) break;
      out.push(c);
    }
    return out;
  }

  #list(vault: VaultId, reader: DeviceId): readonly SegmentInfo[] {
    const out: SegmentInfo[] = [];
    for (const [key, chunks] of this.#segments.get(vault) ?? []) {
      const size = this.#visible(chunks, reader).reduce((n, c) => n + c.bytes.length, 0);
      if (size === 0) continue;
      const slash = key.lastIndexOf("/");
      out.push({ device: key.slice(0, slash), seg: Number(key.slice(slash + 1)), size });
    }
    return out;
  }

  #read(vault: VaultId, device: DeviceId, seg: number, from: number, reader: DeviceId) {
    const chunks = this.#segments.get(vault)?.get(`${device}/${seg}`) ?? [];
    const all = concatBytes(this.#visible(chunks, reader).map((c) => c.bytes));
    return from >= all.length ? new Uint8Array(0) : all.slice(Math.max(0, from));
  }

  #append(
    vault: VaultId,
    device: DeviceId,
    seg: number,
    at: number,
    bytes: Uint8Array,
    by: DeviceId,
  ): void {
    let segs = this.#segments.get(vault);
    if (!segs) {
      segs = new Map();
      this.#segments.set(vault, segs);
    }
    const key = `${device}/${seg}`;
    const chunks = segs.get(key) ?? [];
    const size = chunks.reduce((n, c) => n + c.bytes.length, 0);
    if (at !== size) throw new TransportError("offset-conflict", "append offset is not the size");
    if (bytes.length === 0) return;
    chunks.push({ bytes: bytes.slice(), at: this.#o.clock.now(), by });
    segs.set(key, chunks);
  }
}
