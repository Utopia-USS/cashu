/** Recommendation checks: when "no exit plan" and "plan vs thesis" fire, skip or stay quiet. */
import { describe, expect, it } from "vitest";
import { asInstrumentId } from "../domain/index.js";
import type { RuleOutcome } from "../rules/index.js";
import { CHECKS, checkNoExit, checkVsThesis, type PlanFacts, planRuleSpecs } from "./checks.js";
import { isPlanKey, planDedupKey, planRuleId } from "./keys.js";

const facts = (over: Partial<PlanFacts> = {}): PlanFacts => ({
  instrumentId: asInstrumentId("gid_plan"),
  label: "AAA",
  plan: "hold",
  health: "current",
  hasExitPlan: false,
  unrealized: 0.2,
  held: true,
  priceStale: false,
  symbol: "AAA",
  ...over,
});
const summary = (o: RuleOutcome) =>
  o.type === "fired"
    ? {
        type: o.type,
        severity: o.candidate.severity,
        message: o.candidate.message,
        trigger: o.candidate.payload.trigger,
      }
    : o.type === "skipped"
      ? { type: o.type, reason: o.reason }
      : { type: o.type };

describe("plan_no_exit", () => {
  it("fires on a fulfilled thesis even without a price, and at +100% from cost", () => {
    expect(summary(checkNoExit(facts({ health: "fulfilled", unrealized: null }), "en"))).toEqual({
      type: "fired",
      severity: "info",
      message: "Thesis fulfilled, no exit plan",
      trigger: "fulfilled",
    });
    const gain = checkNoExit(facts({ unrealized: 1.004 }), "pl");
    expect(summary(gain)).toEqual({
      type: "fired",
      severity: "info",
      message: "+100 % od kosztu, brak planu wyjścia",
      trigger: "gain",
    });
    expect(gain.type === "fired" && gain.candidate.payload.unrealized).toBe(1);
    expect(checkNoExit(facts({ unrealized: 0.99 })).type).toBe("not_fired");
  });

  it("is quiet with an exit plan, a held-only plan or when not held", () => {
    for (const over of [{ hasExitPlan: true }, { plan: "reduce" }, { held: false }])
      expect(checkNoExit(facts({ unrealized: 3, ...over })).type).toBe("not_fired");
  });

  it("skips without a current price instead of guessing", () => {
    expect(summary(checkNoExit(facts({ unrealized: null }), "en"))).toEqual({
      type: "skipped",
      reason: "No current price: AAA",
    });
    expect(checkNoExit(facts({ unrealized: 5, priceStale: true })).type).toBe("skipped");
  });
});

describe("plan_vs_thesis", () => {
  it("fires only for a buy plan against a weakened (info) or invalidated (action) thesis", () => {
    expect(summary(checkVsThesis(facts({ plan: "buy", health: "weakened" }), "en"))).toEqual({
      type: "fired",
      severity: "info",
      message: "Recommendation: buy more, thesis weakened",
      trigger: undefined,
    });
    expect(
      summary(checkVsThesis(facts({ plan: "buy_asap", health: "invalidated" }), "pl")),
    ).toMatchObject({ type: "fired", severity: "action" });
    expect(checkVsThesis(facts({ plan: "hold", health: "invalidated" })).type).toBe("not_fired");
    expect(checkVsThesis(facts({ plan: "buy", health: "supported" })).type).toBe("not_fired");
  });
});

it("uses canonical caller identities and ordered specs without allocating ids", () => {
  const instrument = asInstrumentId("gid_synthetic_plan");
  expect(planDedupKey("plan_no_exit", instrument)).toBe("plan:plan_no_exit|i:gid_synthetic_plan");
  expect(planRuleId("plan_vs_thesis")).toBe("plan:plan_vs_thesis");
  expect(isPlanKey(null)).toBe(false);
  expect(isPlanKey("plan:plan_no_exit|i:gid_synthetic_plan")).toBe(true);
  expect(planRuleSpecs().map((s) => s.id)).toEqual(CHECKS.map(planRuleId));
  expect(planRuleSpecs().every((s) => s.polarity === "negative" && s.cooldownDays === null)).toBe(
    true,
  );
});
