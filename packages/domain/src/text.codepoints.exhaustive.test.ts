import { describe, expect, it } from "vitest";
import {
  BLOCK_SIZE,
  BLOCKS_PER_PLANE,
  blockHash,
  loadVectors,
  Mismatches,
  PLANES,
} from "./testing/vectors.js";
import { normalizeText, pyLower, pyStrip, pyUpper } from "./text.js";

// The per-code-point sweeps of the text functions against Python (exhaustive tier, see
// references/testing.md). Vectors: parity/python/vectors.py.
const text = loadVectors("text");

describe("text vectors over every code point (parity/python/vectors.py)", () => {
  // One test per function and plane (16 blocks, 65,536 code points): no single test is a whole scan.
  const perCodePoint: Record<string, (s: string) => string> = {
    normalize_text: normalizeText,
    upper: pyUpper,
    lower: pyLower,
    strip: (s) => pyStrip(`x${s}x${s}`),
  };
  const blockRows = text.rows.filter((r) => r[0] === "blocks") as [string, string, string[]][];

  it("block hashes cover exactly the per-code-point functions", () => {
    expect(blockRows.map(([, name]) => name).sort()).toEqual(Object.keys(perCodePoint).sort());
  });

  for (const [, name, hashes] of blockRows) {
    it.each(PLANES)(`every code point: ${name} in plane %i`, (plane) => {
      const fn = perCodePoint[name];
      if (!fn) throw new Error(`no TS function for ${name}`);
      expect(hashes).toHaveLength(272);
      const m = new Mismatches();
      for (let block = plane * BLOCKS_PER_PLANE; block < (plane + 1) * BLOCKS_PER_PLANE; block++) {
        m.check(
          `${name} block U+${(block * BLOCK_SIZE).toString(16)}`,
          blockHash(fn, block),
          hashes[block],
        );
      }
      expect(m.checked).toBe(BLOCKS_PER_PLANE);
      expect(m.items, m.report()).toEqual([]);
    });
  }
});
