// The long property search for the search index (exhaustive tier, testing.md "Test tiers"):
// searchProperty over many fixed seeds of both budget scripts, one small test per seed slice.
import fc from "fast-check";
import { describe, it } from "vitest";
import { categoryScript } from "../../testing/category-script.js";
import { searchProperty } from "../../testing/search-oracle.js";
import { transferScript } from "../../testing/transfer-script.js";

const SLICES = Array.from({ length: 30 }, (_, i) => i);
const RUNS_PER_SLICE = 8;

describe("search index property search (exhaustive)", () => {
  it.each(SLICES)("categories script: seed slice %i", (i) => {
    fc.assert(searchProperty(categoryScript), { numRuns: RUNS_PER_SLICE, seed: 96_000 + i });
  });

  it.each(SLICES)("transfers script: seed slice %i", (i) => {
    fc.assert(searchProperty(transferScript), { numRuns: RUNS_PER_SLICE, seed: 97_000 + i });
  });
});
