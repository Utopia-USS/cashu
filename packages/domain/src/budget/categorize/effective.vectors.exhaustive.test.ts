import { describe, it } from "vitest";
import { expectAll, Mismatches } from "../../testing/vectors.js";
import { type AllCounts, type AllScenario, checkAll } from "./testing/allScenarios.js";
import { ALL_FAST, categorizeRows, sliceStarts } from "./testing/vectors.js";

const rows = categorizeRows<AllScenario>("all").slice(ALL_FAST);
const SLICE = 40;

describe("categorize_all + detect_recurring equal Python (400 scenarios)", () => {
  it.each(sliceStarts(rows.length, SLICE))("scenarios %i..", (start) => {
    const m = new Mismatches();
    const counts: AllCounts = { rows: 0, cashUnclaimed: 0 };
    checkAll(rows.slice(start, start + SLICE), m, counts);
    expectAll(m);
  });
});
