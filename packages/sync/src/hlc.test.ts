import { describe, expect, it } from "vitest";
import { SyncError } from "./errors.js";
import {
  compareHlc,
  formatHlc,
  HLC_COUNTER_MAX,
  HybridClock,
  type PhysicalClock,
  parseHlc,
} from "./hlc.js";

const DEV = "k3v9q2m8x1c7b4n6";
const OTHER = "a000000000000000";
const T = 1793448000000; // 2026-10-31T12:00:00.000Z, the events.md 3.1 example

function clockAt(ms: number): PhysicalClock & { ms: number } {
  return {
    ms,
    now() {
      return this.ms;
    },
  };
}

describe("HLC format", () => {
  it("matches the spec example and round-trips", () => {
    const h = formatHlc({ wall: T, counter: 0, device: DEV });
    expect(h).toBe(`0mvwcmtc0-0000-${DEV}`);
    expect(parseHlc(h)).toEqual({ wall: T, counter: 0, device: DEV });
  });

  it("orders by wall, counter, then device as plain strings", () => {
    const a = formatHlc({ wall: T, counter: 1, device: DEV });
    const b = formatHlc({ wall: T, counter: 2, device: OTHER });
    const c = formatHlc({ wall: T + 1, counter: 0, device: OTHER });
    expect([c, b, a].sort(compareHlc)).toEqual([a, b, c]);
  });

  it("rejects out-of-range parts and bad strings", () => {
    expect(() => formatHlc({ wall: -1, counter: 0, device: DEV })).toThrow(RangeError);
    expect(() => formatHlc({ wall: T, counter: HLC_COUNTER_MAX + 1, device: DEV })).toThrow();
    expect(() => formatHlc({ wall: T, counter: 0, device: "SHORT" })).toThrow();
    expect(() => parseHlc("nope")).toThrow(SyntaxError);
  });
});

describe("HybridClock (events.md 3.3)", () => {
  it("send: physical time when ahead, else counter + 1", () => {
    const pt = clockAt(T);
    const c = new HybridClock(DEV, { physical: pt });
    expect(c.tick()).toBe(formatHlc({ wall: T, counter: 0, device: DEV }));
    expect(c.tick()).toBe(formatHlc({ wall: T, counter: 1, device: DEV }));
    pt.ms = T + 5;
    expect(c.tick()).toBe(formatHlc({ wall: T + 5, counter: 0, device: DEV }));
  });

  it("send: counter overflow moves to the next millisecond", () => {
    const c = new HybridClock(DEV, {
      physical: clockAt(T),
      restore: { wall: T, counter: HLC_COUNTER_MAX },
    });
    expect(parseHlc(c.tick())).toMatchObject({ wall: T + 1, counter: 0 });
  });

  it("receive: takes the max wall and 1 + the max counter at that wall", () => {
    const pt = clockAt(T);
    const c = new HybridClock(DEV, { physical: pt, restore: { wall: T, counter: 3 } });
    c.receive(formatHlc({ wall: T, counter: 7, device: OTHER }));
    expect(c.state).toEqual({ wall: T, counter: 8 });
    c.receive(formatHlc({ wall: T + 10, counter: 2, device: OTHER }));
    expect(c.state).toEqual({ wall: T + 10, counter: 3 });
    pt.ms = T + 20;
    c.receive(formatHlc({ wall: T + 15, counter: 9, device: OTHER }));
    expect(c.state).toEqual({ wall: T + 20, counter: 0 });
    c.receive(formatHlc({ wall: T + 1, counter: 0, device: OTHER }));
    expect(c.state).toEqual({ wall: T + 20, counter: 1 });
  });

  it("a stamp after receive sorts after the received one, even with a slow physical clock", () => {
    const c = new HybridClock(DEV, { physical: clockAt(T - 60_000) });
    const remote = formatHlc({ wall: T, counter: 4, device: "zzzzzzzzzzzzzzzz" });
    c.receive(remote);
    expect(c.tick() > remote).toBe(true);
  });

  it("emit guard: refuses to stamp when the physical clock is far behind the restored state", () => {
    const c = new HybridClock(DEV, {
      physical: clockAt(T - 6 * 60_000),
      restore: { wall: T, counter: 0 },
    });
    expect(() => c.tick()).toThrow(SyncError);
    const ok = new HybridClock(DEV, {
      physical: clockAt(T - 4 * 60_000),
      restore: { wall: T, counter: 0 },
    });
    expect(parseHlc(ok.tick())).toMatchObject({ wall: T, counter: 1 });
  });

  it("far-future guard: a remote stamp beyond the drift limit is reported and not absorbed", () => {
    const c = new HybridClock(DEV, { physical: clockAt(T) });
    const w = c.receive(formatHlc({ wall: T + 6 * 60_000, counter: 0, device: OTHER }));
    expect(w).toEqual({ kind: "remote-far-future", device: OTHER, aheadMs: 6 * 60_000 });
    expect(c.state).toEqual({ wall: 0, counter: 0 });
    expect(c.receive(formatHlc({ wall: T + 4 * 60_000, counter: 0, device: OTHER }))).toBe(
      undefined,
    );
  });
});
