import { describe, it } from "vitest";
import { expectAll, Mismatches } from "../../../testing/vectors.js";
import {
  checkMerchantCases,
  checkPassCases,
  checkReclassifyScenarios,
  type MerchantCase,
  newCounts,
  type PassCase,
  type ReclassifyScenario,
} from "../testing/llmCases.js";
import { categorizeRows, LLM_FAST, sliceStarts } from "../testing/vectors.js";

const llm = categorizeRows<MerchantCase | PassCase>("llm");
const merchants = llm.filter((r): r is MerchantCase => r[0] === "merchants").slice(LLM_FAST);
const passes = llm.filter((r): r is PassCase => r[0] === "pass").slice(LLM_FAST);
const scenarios = categorizeRows<ReclassifyScenario>("reclassify")
  .filter((r) => r[0] === "scenario")
  .slice(LLM_FAST);
const SLICE = 30;

describe("LLM requests and replies equal Python (every recorded case)", () => {
  it.each(sliceStarts(merchants.length, SLICE))("merchant cases %i..", (start) => {
    const m = new Mismatches();
    checkMerchantCases(merchants.slice(start, start + SLICE), m, newCounts());
    expectAll(m);
  });
  it.each(sliceStarts(passes.length, SLICE))("categorize_all passes %i..", (start) => {
    const m = new Mismatches();
    checkPassCases(passes.slice(start, start + SLICE), m, newCounts());
    expectAll(m);
  });
  it.each(sliceStarts(scenarios.length, SLICE))("reclassify scenarios %i..", (start) => {
    const m = new Mismatches();
    checkReclassifyScenarios(scenarios.slice(start, start + SLICE), m, newCounts());
    expectAll(m);
  });
});
