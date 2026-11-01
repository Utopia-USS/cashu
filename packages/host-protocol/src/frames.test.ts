import { describe, expect, it } from "vitest";
import { encodeFrame, FrameError, FrameReader } from "./frames.js";

const bytes = (...n: number[]) => Uint8Array.from(n);

describe("frames", () => {
  it("round-trips bodies split at every byte boundary and glued together", () => {
    const bodies = [
      bytes(1, 2, 3),
      bytes(),
      bytes(...Array.from({ length: 300 }, (_, i) => i % 256)),
    ];
    const stream = Uint8Array.from(bodies.flatMap((b) => [...encodeFrame(b)]));
    for (let size = 1; size <= stream.length; size++) {
      const reader = new FrameReader();
      const out: Uint8Array[] = [];
      for (let i = 0; i < stream.length; i += size)
        out.push(...reader.push(stream.subarray(i, i + size)));
      expect(out.map((b) => [...b])).toEqual(bodies.map((b) => [...b]));
      expect(reader.buffered).toBe(0);
    }
  });

  it("writes a 4-byte big-endian length", () => {
    expect([...encodeFrame(bytes(9, 9)).subarray(0, 4)]).toEqual([0, 0, 0, 2]);
  });

  it("refuses an oversize frame from its header, before the body arrives", () => {
    const reader = new FrameReader(8);
    expect(() => reader.push(bytes(0, 0, 0, 9))).toThrow(FrameError);
    expect(() => encodeFrame(new Uint8Array(9), 8)).toThrow(/exceeds/);
    try {
      new FrameReader(8).push(bytes(255, 255, 255, 255));
    } catch (e) {
      expect((e as FrameError).reason).toBe("oversize");
    }
  });
});
