// The long property search (exhaustive tier, testing.md "Test tiers"): the convergence property of
// property.test.ts over many fixed seeds, one small test per seed slice.
import fc from "fast-check";
import { describe, it } from "vitest";
import { convergesProperty } from "./testing/property-script.js";

const SLICES = Array.from({ length: 40 }, (_, i) => i);
const RUNS_PER_SLICE = 8;

describe("property search (exhaustive)", () => {
  it.each(SLICES)("convergence, derived oracle, rebuild: seed slice %i", (i) => {
    fc.assert(convergesProperty, { numRuns: RUNS_PER_SLICE, seed: 24_000 + i });
  });
});
