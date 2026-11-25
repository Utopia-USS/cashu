// The long property search for internal transfers (exhaustive tier, testing.md "Test tiers"):
// transfersProperty over many fixed seeds, one small test per seed slice.
import fc from "fast-check";
import { describe, it } from "vitest";
import { transfersProperty } from "../../testing/transfer-script.js";

const SLICES = Array.from({ length: 50 }, (_, i) => i);
const RUNS_PER_SLICE = 8;

describe("internal transfers property search (exhaustive)", () => {
  it.each(SLICES)("orders, derived oracle, recompute, rebuild: seed slice %i", (i) => {
    fc.assert(transfersProperty, { numRuns: RUNS_PER_SLICE, seed: 82_000 + i });
  });
});
