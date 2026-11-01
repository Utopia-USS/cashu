// Exhaustive tier: the 16,000-case `depreciation.value` sweep (assets-depreciation-sweep.jsonl), in
// slices of 1,000 (`parity/python/vectors_loans_assets.py`).

import { describe, it } from "vitest";
import { expectAll, loadVectors, Mismatches } from "../testing/vectors.js";
import { checkDepreciationCases, type DepreciationCase } from "./testing/depreciationCases.js";

const CASES = loadVectors("assets-depreciation-sweep").rows as DepreciationCase[];
const SLICE = 1000;
const SLICES = Array.from({ length: Math.ceil(CASES.length / SLICE) }, (_, i) => i);

describe("depreciatedValue: Python sweep", () => {
  it.each(SLICES)("cases slice %i", (slice) => {
    const m = new Mismatches();
    checkDepreciationCases(m, CASES.slice(slice * SLICE, (slice + 1) * SLICE), slice * SLICE);
    expectAll(m);
  });
});
