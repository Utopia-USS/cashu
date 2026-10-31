// Test doubles around any transport: a fault injector (offline, a segment tail still arriving, a
// flipped byte) and a manual physical clock. Being decorators, they let the contract suite drive every
// carrier adapter through the same failures without adapter-specific hooks.
import type {
  DeviceId,
  SegmentInfo,
  Transport,
  TransportConsistency,
  VaultId,
} from "../carrier.js";
import { TransportError } from "../errors.js";
import type { PhysicalClock } from "../hlc.js";

export class FaultInjector implements Transport {
  readonly inner: Transport;
  readonly consistency: TransportConsistency;
  readonly watch?: (vault: VaultId, onChange: () => void) => () => void;
  #online = true;
  readonly #caps = new Map<string, number>();
  readonly #flips = new Map<string, Set<number>>();

  constructor(inner: Transport) {
    this.inner = inner;
    this.consistency = inner.consistency;
    const innerWatch = inner.watch?.bind(inner);
    if (innerWatch) this.watch = (vault, onChange) => innerWatch(vault, onChange);
  }

  /** Offline: every call rejects with `TransportError("unavailable")`. */
  setOnline(online: boolean): void {
    this.#online = online;
  }

  /** Show only the first `size` bytes of a segment (a file or upload still arriving). */
  capSize(device: DeviceId, seg: number, size: number): void {
    this.#caps.set(`${device}/${seg}`, size);
  }

  uncap(device: DeviceId, seg: number): void {
    this.#caps.delete(`${device}/${seg}`);
  }

  /** Flip every bit of the byte at an absolute segment offset whenever it is read. */
  corrupt(device: DeviceId, seg: number, offset: number): void {
    const key = `${device}/${seg}`;
    const set = this.#flips.get(key) ?? new Set<number>();
    set.add(offset);
    this.#flips.set(key, set);
  }

  heal(): void {
    this.#flips.clear();
  }

  #check(): void {
    if (!this.#online) throw new TransportError("unavailable", "transport offline (test)");
  }

  async list(vault: VaultId): Promise<readonly SegmentInfo[]> {
    this.#check();
    const list = await this.inner.list(vault);
    return list.map((s) => {
      const cap = this.#caps.get(`${s.device}/${s.seg}`);
      return cap === undefined ? s : { ...s, size: Math.min(s.size, cap) };
    });
  }

  async read(
    vault: VaultId,
    device: DeviceId,
    seg: number,
    fromOffset: number,
  ): Promise<Uint8Array> {
    this.#check();
    const key = `${device}/${seg}`;
    let bytes = (await this.inner.read(vault, device, seg, fromOffset)).slice();
    const cap = this.#caps.get(key);
    if (cap !== undefined) bytes = bytes.slice(0, Math.max(0, cap - fromOffset));
    for (const at of this.#flips.get(key) ?? []) {
      const i = at - fromOffset;
      if (i >= 0 && i < bytes.length) bytes[i] = (bytes[i] ?? 0) ^ 0xff;
    }
    return bytes;
  }

  async append(
    vault: VaultId,
    device: DeviceId,
    seg: number,
    atOffset: number,
    bytes: Uint8Array,
  ): Promise<void> {
    this.#check();
    await this.inner.append(vault, device, seg, atOffset, bytes);
  }
}

export class ManualClock implements PhysicalClock {
  #now: number;
  constructor(start: number) {
    this.#now = start;
  }
  now(): number {
    return this.#now;
  }
  set(ms: number): void {
    this.#now = ms;
  }
  advance(ms: number): void {
    this.#now += ms;
  }
}
