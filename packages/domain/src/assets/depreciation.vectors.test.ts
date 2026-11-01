// Python differential: `depreciation.value` over random curves and ages (Python's float `**` against
// V8's, `round(v, 2)`, `Decimal(str(...))`): `parity/python/vectors_loans_assets.py`,
// assets-depreciation.jsonl. The 16,000-case sweep is depreciation.sweep.exhaustive.test.ts.

import { describe, it } from "vitest";
import { expectAll, loadVectors, Mismatches } from "../testing/vectors.js";
import { checkDepreciationCases, type DepreciationCase } from "./testing/depreciationCases.js";

const CASES = loadVectors("assets-depreciation").rows as DepreciationCase[];
const SLICE = 200;
const SLICES = Array.from({ length: Math.ceil(CASES.length / SLICE) }, (_, i) => i);

describe("depreciatedValue: Python differential", () => {
  it.each(SLICES)("cases slice %i", (slice) => {
    const m = new Mismatches();
    checkDepreciationCases(m, CASES.slice(slice * SLICE, (slice + 1) * SLICE), slice * SLICE);
    expectAll(m);
  });
});
