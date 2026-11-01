import { describe, it } from "vitest";
import { expectAll, Mismatches } from "../../testing/vectors.js";
import { checkTexts, type TextVector } from "./testing/reclassifyRows.js";
import { categorizeRows, TEXT_FAST } from "./testing/vectors.js";

describe("txn_signature and txn_context equal Python (budget-categorize-reclassify, fast slice)", () => {
  it("first adversarial texts (dates, card masks, amounts, long numbers, Unicode)", () => {
    const rows = categorizeRows<TextVector>("reclassify").filter((r) => r[0] === "text");
    const m = new Mismatches();
    checkTexts(rows.slice(0, TEXT_FAST), m, 0);
    expectAll(m);
  });
});
