// In-memory carrier pieces: a transport (a device's local log, or a shared "relay" that several
// engines use as their remote) and a clock store. Reference implementations for the contract suite
// and for store / ui-logic tests; nothing here touches disk or network.
import type {
  ClockStore,
  DeviceId,
  SegmentInfo,
  Transport,
  TransportConsistency,
  VaultId,
} from "../carrier.js";
import { TransportError } from "../errors.js";
import type { HlcState } from "../hlc.js";
import { queueTask } from "../runtime.js";
import { concatBytes } from "../segment.js";

interface MemorySegment {
  chunks: Uint8Array[];
  size: number;
}

export class MemoryTransport implements Transport {
  /** One in-process map: every handle sees an append once it resolved. */
  readonly consistency: TransportConsistency = { kind: "linearizable" };
  readonly #vaults = new Map<VaultId, Map<string, MemorySegment>>();
  readonly #watchers = new Map<VaultId, Set<() => void>>();

  async list(vault: VaultId): Promise<readonly SegmentInfo[]> {
    const segs = this.#vaults.get(vault);
    if (!segs) return [];
    return [...segs.entries()].map(([key, s]) => {
      const [device, seg] = splitKey(key);
      return { device, seg, size: s.size };
    });
  }

  async read(
    vault: VaultId,
    device: DeviceId,
    seg: number,
    fromOffset: number,
  ): Promise<Uint8Array> {
    const s = this.#vaults.get(vault)?.get(segKey(device, seg));
    if (!s || fromOffset >= s.size) return new Uint8Array(0);
    if (s.chunks.length > 1) s.chunks = [concatBytes(s.chunks)];
    const all = s.chunks[0] ?? new Uint8Array(0);
    return all.slice(Math.max(0, fromOffset));
  }

  async append(
    vault: VaultId,
    device: DeviceId,
    seg: number,
    atOffset: number,
    bytes: Uint8Array,
  ): Promise<void> {
    let segs = this.#vaults.get(vault);
    if (!segs) {
      segs = new Map();
      this.#vaults.set(vault, segs);
    }
    const key = segKey(device, seg);
    const s = segs.get(key) ?? { chunks: [], size: 0 };
    if (atOffset !== s.size) {
      throw new TransportError("offset-conflict", "append offset is not the segment size");
    }
    if (bytes.length === 0) return;
    s.chunks.push(bytes.slice());
    s.size += bytes.length;
    segs.set(key, s);
    for (const w of this.#watchers.get(vault) ?? []) queueTask(w);
  }

  watch(vault: VaultId, onChange: () => void): () => void {
    let set = this.#watchers.get(vault);
    if (!set) {
      set = new Set();
      this.#watchers.set(vault, set);
    }
    const fn = () => onChange();
    set.add(fn);
    return () => {
      set.delete(fn);
    };
  }
}

function segKey(device: DeviceId, seg: number): string {
  return `${device}/${seg}`;
}

function splitKey(key: string): [DeviceId, number] {
  const slash = key.lastIndexOf("/");
  return [key.slice(0, slash), Number(key.slice(slash + 1))];
}

export class MemoryClockStore implements ClockStore {
  #state: HlcState | undefined;
  constructor(initial?: HlcState) {
    this.#state = initial ? { ...initial } : undefined;
  }
  load(): HlcState | undefined {
    return this.#state ? { ...this.#state } : undefined;
  }
  save(state: HlcState): void {
    this.#state = { ...state };
  }
}
