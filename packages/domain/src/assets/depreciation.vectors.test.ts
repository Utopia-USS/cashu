// Python differential: `depreciation.value` over curves and ages (Python's float `**` against V8's,
// `round(v, 2)`, `Decimal(str(...))`), recorded from the retired Python app in
// assets-depreciation.jsonl (curated: every branch, floor and error kind).

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
