import { describe, expect, it } from "vitest";
import { pyReprStr } from "./pyRepr.js";
import {
  BLOCK_SIZE,
  BLOCKS_PER_PLANE,
  blockHash,
  loadVectors,
  Mismatches,
  PLANES,
} from "./testing/vectors.js";

// repr(chr(c)) over every code point against Python (exhaustive tier, see references/testing.md).
const hashes = (
  loadVectors("inv-importing-repr").rows.find((r) => r[0] === "blocks") as [string, string[]]
)[1];

describe("pyReprStr over every code point (the retired Python vectors_inv_importing.py)", () => {
  it.each(PLANES)("every code point in plane %i", (plane) => {
    expect(hashes).toHaveLength(272);
    const m = new Mismatches();
    for (let block = plane * BLOCKS_PER_PLANE; block < (plane + 1) * BLOCKS_PER_PLANE; block++) {
      m.check(
        `block U+${(block * BLOCK_SIZE).toString(16)}`,
        blockHash(pyReprStr, block),
        hashes[block],
      );
    }
    expect(m.checked).toBe(BLOCKS_PER_PLANE);
    expect(m.items, m.report()).toEqual([]);
  });
});
