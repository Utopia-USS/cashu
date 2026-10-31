// Hybrid logical clock (events.md section 3). Format and order are the spec's; the clock adds the
// generation rules (3.3), restore on restart and the two drift guards.
//
// The wire format is also fixed in `packages/store/src/events/v1/hlc-format.ts` (zod side); sync may not
// import store (layering), so the few format lines live here too. Both are pinned by the spec example.
import { SyncError } from "./errors.js";

/** `<wall:9 base36>-<counter:4 base36>-<device:16>`; plain string order is the total order. */
export type Hlc = string;

export const HLC_RE = /^[0-9a-z]{9}-[0-9a-z]{4}-[0-9a-z]{16}$/;
export const DEVICE_RE = /^[0-9a-z]{16}$/;
export const HLC_WALL_MAX = 36 ** 9 - 1;
export const HLC_COUNTER_MAX = 36 ** 4 - 1;
/** Drift limit of events.md 3.3 (O7): 5 minutes. */
export const DEFAULT_MAX_DRIFT_MS = 5 * 60 * 1000;

export interface HlcParts {
  wall: number;
  counter: number;
  device: string;
}

/** The persisted clock state of one device in one vault. */
export interface HlcState {
  wall: number;
  counter: number;
}

export function formatHlc({ wall, counter, device }: HlcParts): Hlc {
  if (!Number.isSafeInteger(wall) || wall < 0 || wall > HLC_WALL_MAX) {
    throw new RangeError("HLC wall out of range");
  }
  if (!Number.isSafeInteger(counter) || counter < 0 || counter > HLC_COUNTER_MAX) {
    throw new RangeError("HLC counter out of range");
  }
  if (!DEVICE_RE.test(device)) throw new RangeError("HLC device id must be 16 chars [0-9a-z]");
  return `${wall.toString(36).padStart(9, "0")}-${counter.toString(36).padStart(4, "0")}-${device}`;
}

export function parseHlc(value: string): HlcParts {
  if (!HLC_RE.test(value)) throw new SyntaxError("not an HLC string");
  return {
    wall: Number.parseInt(value.slice(0, 9), 36),
    counter: Number.parseInt(value.slice(10, 14), 36),
    device: value.slice(15),
  };
}

export function isHlc(value: unknown): value is Hlc {
  return typeof value === "string" && HLC_RE.test(value);
}

export function hlcDevice(value: Hlc): string {
  return value.slice(15);
}

/** Total order of events by HLC: plain code-unit comparison (events.md 3.2). */
export function compareHlc(a: Hlc, b: Hlc): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Physical time source, injectable so tests and simulations control it. */
export interface PhysicalClock {
  now(): number;
}

export const systemClock: PhysicalClock = { now: () => Date.now() };

/** A remote event whose wall is more than the drift limit ahead of the local physical clock. */
export interface ClockWarning {
  readonly kind: "remote-far-future";
  readonly device: string;
  readonly aheadMs: number;
}

/**
 * One device's clock in one vault. `tick` stamps local events (send), `receive` merges a remote stamp.
 *
 * Guards:
 * - Emit guard (O7): `tick` refuses while the physical clock is behind `last.wall` by more than the
 *   drift limit. Restoring a persisted state therefore never lets a slow clock stamp below what the
 *   device already wrote or saw.
 * - Far-future guard: `receive` of a stamp more than the drift limit ahead of the physical clock does
 *   not move the clock (it returns a warning instead). The event itself is still applied by the
 *   caller (convergence), but one device with a wrong clock cannot drag every other device's clock
 *   into the future and trip their emit guard (the failure Evolu tracks as #712).
 */
export class HybridClock {
  readonly device: string;
  readonly maxDriftMs: number;
  readonly #physical: PhysicalClock;
  #wall = 0;
  #counter = 0;

  constructor(
    device: string,
    options: { physical?: PhysicalClock; maxDriftMs?: number; restore?: HlcState } = {},
  ) {
    if (!DEVICE_RE.test(device)) throw new RangeError("device id must be 16 chars [0-9a-z]");
    this.device = device;
    this.#physical = options.physical ?? systemClock;
    this.maxDriftMs = options.maxDriftMs ?? DEFAULT_MAX_DRIFT_MS;
    if (options.restore) {
      this.#wall = options.restore.wall;
      this.#counter = options.restore.counter;
    }
  }

  /** The state to persist (durably, before the stamped events are appended). */
  get state(): HlcState {
    return { wall: this.#wall, counter: this.#counter };
  }

  /** The last issued or merged stamp of this clock, as an HLC string (for comparisons). */
  get last(): Hlc {
    return formatHlc({ wall: this.#wall, counter: this.#counter, device: this.device });
  }

  /** Send: stamp one local event. Throws `SyncError("clock-behind")` under the emit guard. */
  tick(): Hlc {
    const pt = this.#physical.now();
    if (pt + this.maxDriftMs < this.#wall) {
      throw new SyncError("clock-behind", "the device clock is behind the last stamp");
    }
    if (pt > this.#wall) {
      this.#wall = pt;
      this.#counter = 0;
    } else if (this.#counter >= HLC_COUNTER_MAX) {
      this.#wall += 1;
      this.#counter = 0;
    } else {
      this.#counter += 1;
    }
    return this.last;
  }

  /** Receive: merge a remote stamp before the next local one. Returns a warning when it was ignored. */
  receive(remote: Hlc): ClockWarning | undefined {
    const r = parseHlc(remote);
    const pt = this.#physical.now();
    if (r.wall > pt + this.maxDriftMs) {
      return { kind: "remote-far-future", device: r.device, aheadMs: r.wall - pt };
    }
    const w = Math.max(pt, this.#wall, r.wall);
    let counter: number;
    if (w === this.#wall && w === r.wall) counter = Math.max(this.#counter, r.counter) + 1;
    else if (w === this.#wall) counter = this.#counter + 1;
    else if (w === r.wall) counter = r.counter + 1;
    else counter = 0;
    if (counter > HLC_COUNTER_MAX) {
      this.#wall = w + 1;
      this.#counter = 0;
    } else {
      this.#wall = w;
      this.#counter = counter;
    }
    return undefined;
  }
}
