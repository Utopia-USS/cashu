// The long property search for the month aggregates (exhaustive tier, testing.md "Test tiers"):
// monthsProperty over many fixed seeds of both budget scripts, one small test per seed slice.
import fc from "fast-check";
import { describe, it } from "vitest";
import { categoryScript } from "../../testing/category-script.js";
import { monthsProperty } from "../../testing/months-oracle.js";
import { transferScript } from "../../testing/transfer-script.js";

const SLICES = Array.from({ length: 30 }, (_, i) => i);
const RUNS_PER_SLICE = 8;

describe("month aggregates property search (exhaustive)", () => {
  it.each(SLICES)("categories script: seed slice %i", (i) => {
    fc.assert(monthsProperty(categoryScript), { numRuns: RUNS_PER_SLICE, seed: 92_000 + i });
  });

  it.each(SLICES)("transfers script: seed slice %i", (i) => {
    fc.assert(monthsProperty(transferScript), { numRuns: RUNS_PER_SLICE, seed: 93_000 + i });
  });
});
