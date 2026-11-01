import { describe, it } from "vitest";
import { expectAll, Mismatches } from "../../testing/vectors.js";
import { checkTexts, type TextVector } from "./testing/reclassifyRows.js";
import { categorizeRows, sliceStarts, TEXT_FAST } from "./testing/vectors.js";

const rows = categorizeRows<TextVector>("reclassify")
  .filter((r) => r[0] === "text")
  .slice(TEXT_FAST);
const SLICE = 600;

describe("txn_signature and txn_context equal Python (3000 adversarial texts)", () => {
  it.each(sliceStarts(rows.length, SLICE))("texts %i..", (start) => {
    const m = new Mismatches();
    checkTexts(rows.slice(start, start + SLICE), m, TEXT_FAST + start);
    expectAll(m);
  });
});
