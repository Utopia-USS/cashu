import { describe, expect, it } from "vitest";
import { utf8Encode } from "./runtime.js";
import {
  concatBytes,
  decodePayload,
  encodePayload,
  frameBytes,
  MAX_SEALED_FRAME_BYTES,
  scanFrames,
} from "./segment.js";

const DEV = "3f9a2c8e1d7b4a6050c3e9f12d8b7a64";
const h = (n: number, device = DEV) => `0mvwcmtc${n}-0000-${device}`;
const ev = (n: number, device = DEV) => ({
  t: "test.set",
  v: 1,
  h: h(n, device),
  i: `e${n}`,
  d: {},
});

describe("frame scanning", () => {
  it("splits complete frames and reports a partial tail", () => {
    const f1 = frameBytes(new Uint8Array([1, 2, 3]));
    const f2 = frameBytes(new Uint8Array([4, 5]));
    const all = concatBytes([f1, f2]);
    const full = scanFrames(all, 100);
    expect(full.tail).toBe("none");
    expect(full.frames.map((f) => [f.offset, f.end, [...f.sealed]])).toEqual([
      [100, 107, [1, 2, 3]],
      [107, 113, [4, 5]],
    ]);
    for (const cut of [8, 9, 12]) {
      const partial = scanFrames(all.subarray(0, cut), 100);
      expect(partial.frames).toHaveLength(1);
      expect(partial.tail).toBe("partial");
      expect(partial.tailOffset).toBe(107);
    }
  });

  it("flags an impossible length prefix as too large", () => {
    const bad = new Uint8Array(8);
    new DataView(bad.buffer).setUint32(0, MAX_SEALED_FRAME_BYTES + 1, false);
    expect(scanFrames(bad, 0).tail).toBe("too-large");
  });
});

describe("frame payload", () => {
  it("round-trips single frames and group parts, keeping unknown keys", () => {
    const events = [{ ...ev(1), zz: [1] }, ev(2)];
    expect(decodePayload(encodePayload({ events }), DEV)).toEqual({
      ok: true,
      payload: { events },
    });
    const part = decodePayload(encodePayload({ events, part: [1, 3] }), DEV);
    expect(part).toEqual({ ok: true, payload: { events, part: [1, 3] } });
  });

  it("rejects malformed payloads", () => {
    const cases: unknown[] = [
      "not json {",
      { f: 1, e: [] },
      { f: 1, e: [{ ...ev(1), h: "bad" }] },
      { f: 1, e: [ev(1, "a0000000000000000000000000000000")] },
      { f: 1, e: [ev(2), ev(1)] },
      { f: 1, e: [{ ...ev(1), i: "" }] },
      { f: 1, e: [{ ...ev(1), d: [] }] },
      { f: 1, e: [ev(1)], p: [3, 3] },
      { f: 1, e: [ev(1)], p: [0, 1] },
    ];
    for (const c of cases) {
      const bytes = utf8Encode(typeof c === "string" ? c : JSON.stringify(c));
      expect(decodePayload(bytes, DEV)).toEqual({ ok: false, code: "malformed" });
    }
    expect(decodePayload(new Uint8Array([0xff, 0xfe]), DEV)).toEqual({
      ok: false,
      code: "malformed",
    });
  });

  it("reports a newer payload format separately (needs upgrade)", () => {
    const bytes = utf8Encode(JSON.stringify({ f: 2, e: [ev(1)] }));
    expect(decodePayload(bytes, DEV)).toEqual({ ok: false, code: "frame-format" });
  });
});
