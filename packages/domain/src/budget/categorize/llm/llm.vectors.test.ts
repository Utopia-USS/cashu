import { describe, expect, it } from "vitest";
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
import { categorizeRows, LLM_FAST } from "../testing/vectors.js";

const llm = categorizeRows<MerchantCase | PassCase>("llm");
const merchants = llm.filter((r): r is MerchantCase => r[0] === "merchants");
const passes = llm.filter((r): r is PassCase => r[0] === "pass");
const scenarios = categorizeRows<ReclassifyScenario>("reclassify").filter(
  (r) => r[0] === "scenario",
);

describe("LLM requests and replies equal Python (MockTransport recordings, fast slice)", () => {
  it("backends on raw merchant lists: bodies, json.dumps, parsing, Q12 guard", () => {
    const m = new Mismatches();
    const c = newCounts();
    checkMerchantCases(merchants.slice(0, LLM_FAST), m, c);
    expectAll(m);
    expect(c.bodiesCompared).toBeGreaterThan(5);
  });

  it("categorize_all(use_llm=True): unknown merchants, bodies, cached rules", () => {
    const m = new Mismatches();
    checkPassCases(passes.slice(0, LLM_FAST), m, newCounts());
    expectAll(m);
  });

  it("reclassify_all: plan, bodies, final rows", () => {
    const m = new Mismatches();
    checkReclassifyScenarios(scenarios.slice(0, LLM_FAST), m, newCounts());
    expectAll(m);
  });
});
