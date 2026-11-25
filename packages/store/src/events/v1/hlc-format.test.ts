import { describe, expect, it } from "vitest";
import {
  compareHlc,
  formatHlc,
  HLC_COUNTER_MAX,
  HLC_WALL_MAX,
  hlc,
  parseHlc,
} from "./hlc-format.js";

const D1 = "3f9a2c8e1d7b4a6050c3e9f12d8b7a64";
const D2 = "a0000000000000000000000000000000";

describe("HLC format", () => {
  it("encodes the spec example", () => {
    const wall = Date.parse("2026-10-31T12:00:00.000Z");
    expect(formatHlc({ wall, counter: 0, device: D1 })).toBe(`0mvwcmtc0-0000-${D1}`);
  });

  it("round-trips", () => {
    const parts = { wall: 1793448000123, counter: 1295, device: D1 };
    expect(parseHlc(formatHlc(parts))).toEqual(parts);
    expect(formatHlc({ wall: HLC_WALL_MAX, counter: HLC_COUNTER_MAX, device: D1 })).toBe(
      `zzzzzzzzz-zzzz-${D1}`,
    );
  });

  it("string order equals (wall, counter, device) order", () => {
    const samples: Array<[number, number, string]> = [];
    for (const wall of [0, 35, 36, 1295, 1296, 1793448000000, 1793448000001]) {
      for (const counter of [0, 1, 35, 36, 1679615]) {
        for (const device of [D1, D2]) samples.push([wall, counter, device]);
      }
    }
    const encoded = samples.map(([wall, counter, device]) => ({
      key: [wall, counter, device] as const,
      s: formatHlc({ wall, counter, device }),
    }));
    const byString = [...encoded].sort((a, b) => compareHlc(a.s, b.s)).map((e) => e.s);
    const byTuple = [...encoded]
      .sort(
        (a, b) =>
          a.key[0] - b.key[0] ||
          a.key[1] - b.key[1] ||
          (a.key[2] < b.key[2] ? -1 : a.key[2] > b.key[2] ? 1 : 0),
      )
      .map((e) => e.s);
    expect(byString).toEqual(byTuple);
  });

  it("rejects bad values", () => {
    expect(() => formatHlc({ wall: -1, counter: 0, device: D1 })).toThrow(RangeError);
    expect(() => formatHlc({ wall: 0, counter: HLC_COUNTER_MAX + 1, device: D1 })).toThrow(
      RangeError,
    );
    expect(() => formatHlc({ wall: 0, counter: 0, device: "SHORT" })).toThrow(RangeError);
    expect(() => parseHlc("0mvwcmtc0-0000-K3V9Q2M8X1C7B4N6")).toThrow(SyntaxError);
    expect(hlc.safeParse(`0mvwcmtc0-0000-${D1}`).success).toBe(true);
    expect(hlc.safeParse(`mvwcmtc0-0000-${D1}`).success).toBe(false);
    expect(hlc.safeParse(`0mvwcmtc0-000-${D1}`).success).toBe(false);
  });
});
