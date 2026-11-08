import { describe, expect, it } from "vitest";
import { expectAll, Mismatches } from "../../testing/vectors.js";
import { type AllCounts, type AllScenario, checkAll } from "./testing/allScenarios.js";
import { categorizeRows } from "./testing/vectors.js";

describe("categorize_all + detect_recurring equal Python (budget-categorize-all)", () => {
  it("every scenario: per-row (category, source), recurring candidates in order, payees", () => {
    const m = new Mismatches();
    const counts: AllCounts = { rows: 0, cashUnclaimed: 0 };
    checkAll(categorizeRows<AllScenario>("all"), m, counts);
    expectAll(m);
    expect(counts.rows).toBe(540);
  });
});
