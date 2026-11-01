import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { asInstrumentId } from "../domain/index.js";
import type { RuleOutcome } from "../rules/index.js";
import {
  CHECKS,
  checkNoExit,
  checkVsThesis,
  evaluatePlanChecks,
  type PlanFacts,
  planRuleSpecs,
} from "./checks.js";
import { isPlanKey, planDedupKey, planRuleId } from "./keys.js";

interface FactsVector {
  readonly instrument_id: number;
  readonly label: string;
  readonly plan: string | null;
  readonly health: string;
  readonly has_exit_plan: boolean;
  readonly unrealized: number | null;
  readonly held: boolean;
  readonly price_stale: boolean;
  readonly symbol: string | null;
}
const vectors = JSON.parse(
  readFileSync(new URL("./fixtures/plan-checks.json", import.meta.url), "utf8"),
) as readonly {
  lang: "pl" | "en";
  facts: FactsVector;
  expected: unknown;
}[];
function facts(f: FactsVector): PlanFacts {
  return {
    instrumentId: asInstrumentId(String(f.instrument_id)),
    label: f.label,
    plan: f.plan,
    health: f.health,
    hasExitPlan: f.has_exit_plan,
    unrealized: f.unrealized,
    held: f.held,
    priceStale: f.price_stale,
    symbol: f.symbol,
  };
}
function pythonOutcome(o: RuleOutcome): unknown {
  if (o.type === "fired") {
    const c = o.candidate;
    return {
      type: "Fired",
      value: {
        candidate: {
          rule_id: c.ruleId,
          kind: c.kind,
          dedup_key: c.dedupKey,
          severity: c.severity,
          message: c.message,
          instrument_id: c.instrumentId,
          account_id: c.accountId,
          payload: c.payload,
          polarity: c.polarity,
        },
      },
    };
  }
  return o.type === "not_fired"
    ? { type: "NotFired", value: { rule_id: o.ruleId, dedup_key: o.dedupKey, details: o.details } }
    : { type: "Skipped", value: { rule_id: o.ruleId, reason: o.reason, dedup_key: o.dedupKey } };
}

it.each(vectors)(
  "matches actual Python plan checks in $lang",
  ({ lang, facts: input, expected }) => {
    const f = facts(input);
    expect(evaluatePlanChecks([f], lang).map(pythonOutcome)).toEqual(expected);
    expect([checkNoExit(f, lang), checkVsThesis(f, lang)].map(pythonOutcome)).toEqual(expected);
  },
);

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
  expect(planRuleSpecs().every((s) => s.params === null)).toBe(true);
});
