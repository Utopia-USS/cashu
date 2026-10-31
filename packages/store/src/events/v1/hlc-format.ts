// HLC string format and comparison (spec: events.md section 3). The clock itself (send / receive,
// persistence) is S23's `packages/store/src/hlc.ts`; this file only fixes the wire format.
import { z } from "zod";
import { DEVICE_RE } from "./primitives.js";

export const HLC_RE = /^[0-9a-z]{9}-[0-9a-z]{4}-[0-9a-f]{32}$/;
export const HLC_WALL_MAX = 36 ** 9 - 1;
export const HLC_COUNTER_MAX = 36 ** 4 - 1;

export interface HlcParts {
  wall: number;
  counter: number;
  device: string;
}

export const hlc = z.string().regex(HLC_RE, "expected <wall:9 base36>-<counter:4 base36>-<device>");

export function formatHlc({ wall, counter, device }: HlcParts): string {
  if (!Number.isSafeInteger(wall) || wall < 0 || wall > HLC_WALL_MAX) {
    throw new RangeError(`HLC wall out of range: ${wall}`);
  }
  if (!Number.isSafeInteger(counter) || counter < 0 || counter > HLC_COUNTER_MAX) {
    throw new RangeError(`HLC counter out of range: ${counter}`);
  }
  if (!DEVICE_RE.test(device)) throw new RangeError("HLC device id must be 32 lower-case hex");
  return `${wall.toString(36).padStart(9, "0")}-${counter.toString(36).padStart(4, "0")}-${device}`;
}

export function parseHlc(value: string): HlcParts {
  if (!HLC_RE.test(value)) throw new SyntaxError(`not an HLC string: ${value}`);
  return {
    wall: Number.parseInt(value.slice(0, 9), 36),
    counter: Number.parseInt(value.slice(10, 14), 36),
    device: value.slice(15),
  };
}

/** Total order of events: plain code-unit comparison of the HLC strings. */
export function compareHlc(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
