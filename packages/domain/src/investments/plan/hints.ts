/** Owner-rule hint tables (P2); codes and raw owner text remain independent of UI language. */
import { Decimal, roundFloat } from "../../decimal.js";
import { floatParameter } from "../alerts/index.js";
import { BUY_PLANS } from "../domain/index.js";
import { Health } from "../research/index.js";
import { planContradictsThesis } from "./checks.js";
import type { Freshness } from "./freshness.js";
export const HintSeverity = { RULE: "rule", REVIEW: "review", INFO: "info" } as const;
export type HintSeverity = (typeof HintSeverity)[keyof typeof HintSeverity];
export interface Hint {
  readonly code: string;
  readonly severity: HintSeverity;
  readonly params: Readonly<Record<string, unknown>>;
}
export interface HintSignal {
  readonly kind: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly severity?: string | null;
}
/** Stable request-local rank is internal adapter metadata, not an identity or SQL id. */
export interface HintAlert {
  readonly alertId: string;
  readonly kind: string;
  readonly title?: string | null;
  readonly order: number;
}
export interface HintFacts {
  readonly held: boolean;
  readonly health: string;
  readonly hasThesis: boolean;
  readonly hasExitPlan?: boolean;
  readonly plan?: string | null;
  /** The model's position strength (`POSITION_STRENGTHS`); null = not assessed. */
  readonly positionStrength?: string | null;
  /** The basis of the strength (`STRENGTH_BASES`). */
  readonly strengthBasis?: string | null;
  readonly predatesThesis?: boolean;
  readonly signals?: readonly HintSignal[];
  readonly alerts?: readonly HintAlert[];
  readonly weight?: number | null;
  readonly thesisTracked?: boolean;
  readonly freshness?: Freshness | null;
}
export const HELD_HINT_ORDER = [
  "recommendation_outdated",
  "recommendation_maybe_outdated",
  "thesis_invalidated",
  "plan_vs_thesis",
  "thesis_fulfilled",
  "position_weak",
  "gain_review",
  "loss_review",
  "drawdown_review",
  "concentration",
  "thesis_weakened",
  "no_thesis",
  "no_exit_plan",
] as const;
export const WATCHED_HINT_ORDER = [
  "recommendation_outdated",
  "recommendation_maybe_outdated",
  "alert_triggered",
  "plan_vs_thesis",
  "thesis_invalidated",
  "thesis_weakened",
  "thesis_fulfilled",
  "plan_without_thesis",
  "no_thesis",
] as const;
const RULE_KIND_HINTS: ReadonlyMap<string, string> = new Map([
  ["gain_from_cost", "gain_review"],
  ["loss_from_cost", "loss_review"],
  ["drawdown_from_high", "drawdown_review"],
  ["position_concentration", "concentration"],
]);
const THESIS_CODES = new Set([
  "thesis_invalidated",
  "thesis_weakened",
  "thesis_fulfilled",
  "no_thesis",
  "no_exit_plan",
  "plan_without_thesis",
]);
export function hintNumber(value: unknown): number | null {
  if (typeof value === "boolean" || value == null) return null;
  try {
    return roundFloat(value instanceof Decimal ? value.toFloat() : floatParameter(value), 4);
  } catch (error) {
    if (error instanceof Error && (error.name === "TypeError" || error.name === "ValueError"))
      return null;
    throw error;
  }
}
const hint = (
  code: string,
  severity: HintSeverity,
  params: Readonly<Record<string, unknown>> = {},
): Hint => ({ code, severity, params });
function strongest(signals: readonly HintSignal[], kind: string): HintSignal | undefined {
  const key = kind === "position_concentration" ? "max_weight" : "threshold";
  let found: HintSignal | undefined,
    score = 0;
  for (const s of signals)
    if (s.kind === kind) {
      const value = hintNumber(s.payload[key]),
        n = value === null || value === 0 ? 0 : value;
      if (found === undefined || n > score) {
        found = s;
        score = n;
      }
    }
  return found;
}
function ruleHint(kind: string, s: HintSignal, f: HintFacts): Hint {
  const p = s.payload,
    threshold = hintNumber(p.threshold);
  let params: Readonly<Record<string, unknown>>;
  if (kind === "gain_from_cost")
    params = {
      gain: hintNumber(p.unrealized_pct),
      threshold,
      has_exit_plan: f.hasExitPlan ?? false,
    };
  else if (kind === "loss_from_cost") {
    const loss = hintNumber(p.unrealized_pct);
    params = { loss: loss === null ? null : Math.abs(loss), threshold };
  } else if (kind === "drawdown_from_high")
    params = { drawdown: hintNumber(p.drawdown), threshold };
  else
    params = {
      weight: hintNumber(p.weight) ?? hintNumber(f.weight),
      max_weight: hintNumber(p.max_weight),
    };
  return hint(RULE_KIND_HINTS.get(kind) ?? kind, "review", params);
}
function thesis(f: HintFacts): Hint | null {
  const tagged = { predates_thesis: f.predatesThesis ?? false };
  if (f.health === Health.INVALIDATED) return hint("thesis_invalidated", "rule", tagged);
  if (f.health === Health.WEAKENED) return hint("thesis_weakened", "review", tagged);
  if (f.health === Health.FULFILLED)
    return hint("thesis_fulfilled", "review", { has_exit_plan: f.hasExitPlan ?? false, ...tagged });
  return null;
}
function freshness(f: HintFacts): Hint[] {
  const fresh = f.freshness;
  if (fresh == null || fresh.state === "fresh") return [];
  return [
    hint(
      fresh.state === "outdated" ? "recommendation_outdated" : "recommendation_maybe_outdated",
      fresh.state === "outdated" ? "rule" : "review",
      { reasons: fresh.codes },
    ),
  ];
}
function contradiction(f: HintFacts): Hint | null {
  return planContradictsThesis(f.plan ?? null, f.health)
    ? hint("plan_vs_thesis", "rule", { plan: f.plan, health: f.health })
    : null;
}
/** The model rates a held position weak: review the exit plan (the agent's assessment, not a thesis code). */
function weakPosition(f: HintFacts): Hint | null {
  return f.positionStrength === "weak"
    ? hint("position_weak", "review", {
        basis: f.strengthBasis ?? null,
        has_exit_plan: f.hasExitPlan ?? false,
      })
    : null;
}
function ordered(found: Hint[], order: readonly string[]): readonly Hint[] {
  return found.sort((a, b) => order.indexOf(a.code) - order.indexOf(b.code));
}
export function heldHints(f: HintFacts): readonly Hint[] {
  const found = freshness(f),
    state = thesis(f),
    vs = contradiction(f);
  if (state !== null) found.push(state);
  if (vs !== null) found.push(vs);
  const weak = weakPosition(f);
  if (weak !== null) found.push(weak);
  for (const kind of RULE_KIND_HINTS.keys()) {
    const s = strongest(f.signals ?? [], kind);
    if (s !== undefined) found.push(ruleHint(kind, s, f));
  }
  if (!f.hasThesis) found.push(hint("no_thesis", "review"));
  else if (
    !f.hasExitPlan &&
    !found.some(
      (h) =>
        h.code === "thesis_fulfilled" || h.code === "gain_review" || h.code === "position_weak",
    )
  )
    found.push(hint("no_exit_plan", "info"));
  return ordered(found, HELD_HINT_ORDER);
}
export function watchedHints(f: HintFacts): readonly Hint[] {
  const found = [...(f.alerts ?? [])]
    .sort((a, b) => a.order - b.order)
    .map((a) =>
      hint("alert_triggered", "review", {
        alert_id: a.alertId,
        kind: a.kind,
        title: a.title ?? null,
      }),
    );
  found.push(...freshness(f));
  const vs = contradiction(f),
    state = thesis(f);
  if (vs !== null) found.push(vs);
  if (state !== null) found.push(state);
  if (!f.hasThesis) {
    if (BUY_PLANS.has(f.plan ?? ""))
      found.push(hint("plan_without_thesis", "rule", { plan: f.plan }));
    found.push(hint("no_thesis", "info"));
  }
  return ordered(found, WATCHED_HINT_ORDER);
}
export function instrumentHints(f: HintFacts): readonly Hint[] {
  const found = f.held ? heldHints(f) : watchedHints(f);
  return f.thesisTracked !== false || f.hasThesis
    ? found
    : found.filter((h) => !THESIS_CODES.has(h.code));
}
