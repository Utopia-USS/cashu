import { describe, expect, it } from "vitest";
import { expectAll, Mismatches } from "../../testing/vectors.js";
import { type AllCounts, type AllScenario, checkAll } from "./testing/allScenarios.js";
import { ALL_FAST, categorizeRows } from "./testing/vectors.js";

describe("categorize_all + detect_recurring equal Python (budget-categorize-all, fast slice)", () => {
  it("first scenarios: per-row (category, source), recurring candidates in order, payees", () => {
    const m = new Mismatches();
    const counts: AllCounts = { rows: 0, cashUnclaimed: 0 };
    checkAll(categorizeRows<AllScenario>("all").slice(0, ALL_FAST), m, counts);
    expectAll(m);
    expect(counts.rows).toBeGreaterThan(1000);
  });
});
