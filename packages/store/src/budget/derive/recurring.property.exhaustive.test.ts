// The long property search for the recurring payments (exhaustive tier, testing.md "Test tiers"):
// recurringProperty over many fixed seeds of the recurring, categories and transfers scripts, one
// small test per seed slice.
import fc from "fast-check";
import { describe, it } from "vitest";
import { categoryScript } from "../../testing/category-script.js";
import { recurringProperty } from "../../testing/recurring-oracle.js";
import { recurringScript } from "../../testing/recurring-script.js";
import { transferScript } from "../../testing/transfer-script.js";

const SLICES = Array.from({ length: 30 }, (_, i) => i);
const RUNS_PER_SLICE = 8;

describe("recurring payments property search (exhaustive)", () => {
  it.each(SLICES)("recurring script: seed slice %i", (i) => {
    fc.assert(recurringProperty(recurringScript), { numRuns: RUNS_PER_SLICE, seed: 97_000 + i });
  });

  it.each(SLICES)("categories script: seed slice %i", (i) => {
    fc.assert(recurringProperty(categoryScript), { numRuns: RUNS_PER_SLICE, seed: 98_000 + i });
  });

  it.each(SLICES)("transfers script: seed slice %i", (i) => {
    fc.assert(recurringProperty(transferScript), { numRuns: RUNS_PER_SLICE, seed: 99_000 + i });
  });
});
