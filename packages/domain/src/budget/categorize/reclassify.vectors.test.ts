import { describe, it } from "vitest";
import { expectAll, Mismatches } from "../../testing/vectors.js";
import { checkTexts, type TextVector } from "./testing/reclassifyRows.js";
import { categorizeRows } from "./testing/vectors.js";

describe("txn_signature and txn_context equal Python (budget-categorize-reclassify)", () => {
  it("adversarial texts (dates, card masks, amounts, long numbers, Unicode)", () => {
    const rows = categorizeRows<TextVector>("reclassify").filter((r) => r[0] === "text");
    const m = new Mismatches();
    checkTexts(rows, m, 0);
    expectAll(m);
  });
});
