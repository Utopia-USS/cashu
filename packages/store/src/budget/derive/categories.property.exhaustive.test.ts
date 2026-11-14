// The long property search for the effective categories (exhaustive tier, testing.md "Test tiers"):
// categoriesProperty over many fixed seeds, one small test per seed slice.
import fc from "fast-check";
import { describe, it } from "vitest";
import { categoriesProperty } from "../../testing/category-script.js";

const SLICES = Array.from({ length: 50 }, (_, i) => i);
const RUNS_PER_SLICE = 8;

describe("effective categories property search (exhaustive)", () => {
  it.each(SLICES)("orders, derived oracle, recompute, rebuild: seed slice %i", (i) => {
    fc.assert(categoriesProperty, { numRuns: RUNS_PER_SLICE, seed: 72_000 + i });
  });
});
