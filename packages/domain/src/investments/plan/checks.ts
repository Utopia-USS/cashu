/** Deterministic recommendation checks, not owner decisions or trading instructions. */
import { roundFloat } from "../../decimal.js";
import {
  BUY_PLANS,
  HELD_ONLY_PLANS,
  type InstrumentId,
  type PlanLanguage,
  planLabel,
  SignalSeverity,
} from "../domain/index.js";
import { Health } from "../research/index.js";
import {
  Fired,
  NotFired,
  type RuleOutcome,
  type RuleSpec,
  SignalPolarity,
  Skipped,
} from "../rules/index.js";
import { planDedupKey, planRuleId } from "./keys.js";

export const GAIN_REVIEW = 1.0;
export const PLAN_NO_EXIT = "plan_no_exit";
export const PLAN_VS_THESIS = "plan_vs_thesis";
export const CHECKS = [PLAN_NO_EXIT, PLAN_VS_THESIS] as const;

export interface PlanFacts {
  readonly instrumentId: InstrumentId;
  readonly label: string;
  readonly plan: string | null;
  readonly health: string;
  readonly hasExitPlan: boolean;
  readonly unrealized: number | null;
  readonly priceStale?: boolean;
  readonly symbol?: string | null;
  readonly held?: boolean;
}

export function planRuleSpecs(): readonly RuleSpec<null>[] {
  return CHECKS.map((check) => ({
    id: planRuleId(check),
    kind: planRuleId(check),
    params: null,
    severity: SignalSeverity.INFO,
    polarity: SignalPolarity.NEGATIVE,
    cooldownDays: null,
  }));
}

function fired(
  check: string,
  f: PlanFacts,
  severity: SignalSeverity,
  message: string,
  extra: Readonly<Record<string, unknown>> = {},
): Fired {
  return new Fired({
    ruleId: planRuleId(check),
    kind: planRuleId(check),
    dedupKey: planDedupKey(check, f.instrumentId),
    severity,
    message,
    instrumentId: f.instrumentId,
    accountId: null,
    polarity: SignalPolarity.NEGATIVE,
    payload: {
      check,
      plan: f.plan,
      health: f.health,
      has_exit_plan: f.hasExitPlan,
      unrealized: f.unrealized === null ? null : roundFloat(f.unrealized, 2),
      symbol: f.symbol ?? null,
      ...extra,
    },
  });
}

export function checkNoExit(f: PlanFacts, lang: PlanLanguage = "pl"): RuleOutcome {
  const rule = planRuleId(PLAN_NO_EXIT);
  const key = planDedupKey(PLAN_NO_EXIT, f.instrumentId);
  if (f.held === false || (f.plan !== null && HELD_ONLY_PLANS.has(f.plan)) || f.hasExitPlan)
    return new NotFired(rule, key);
  if (f.health === Health.FULFILLED)
    return fired(
      PLAN_NO_EXIT,
      f,
      SignalSeverity.INFO,
      lang === "en" ? "Thesis fulfilled, no exit plan" : "Teza spełniona, brak planu wyjścia",
      { trigger: "fulfilled" },
    );
  if (f.unrealized === null || f.priceStale === true)
    return new Skipped(
      rule,
      lang === "en" ? `No current price: ${f.label}` : `Brak aktualnej ceny: ${f.label}`,
      key,
    );
  if (f.unrealized >= GAIN_REVIEW)
    return fired(
      PLAN_NO_EXIT,
      f,
      SignalSeverity.INFO,
      lang === "en" ? "+100% from cost, no exit plan" : "+100 % od kosztu, brak planu wyjścia",
      { trigger: "gain", threshold: GAIN_REVIEW },
    );
  return new NotFired(rule, key);
}

export function planContradictsThesis(plan: string | null, health: string): boolean {
  return (
    plan !== null &&
    BUY_PLANS.has(plan) &&
    (health === Health.WEAKENED || health === Health.INVALIDATED)
  );
}

export function checkVsThesis(f: PlanFacts, lang: PlanLanguage = "pl"): RuleOutcome {
  const rule = planRuleId(PLAN_VS_THESIS);
  const key = planDedupKey(PLAN_VS_THESIS, f.instrumentId);
  if (!planContradictsThesis(f.plan, f.health)) return new NotFired(rule, key);
  const health =
    f.health === Health.INVALIDATED
      ? lang === "en"
        ? "invalidated"
        : "podważona"
      : lang === "en"
        ? "weakened"
        : "osłabiona";
  const label = planLabel(f.plan, { held: true, lang });
  const message =
    lang === "en"
      ? `Recommendation: ${label}, thesis ${health}`
      : `Rekomendacja: ${label}, teza ${health}`;
  return fired(
    PLAN_VS_THESIS,
    f,
    f.health === Health.INVALIDATED ? SignalSeverity.ACTION : SignalSeverity.INFO,
    message,
  );
}

export function evaluatePlanChecks(
  facts: Iterable<PlanFacts>,
  lang: PlanLanguage = "pl",
): RuleOutcome[] {
  return Array.from(facts).flatMap((f) => [checkNoExit(f, lang), checkVsThesis(f, lang)]);
}
