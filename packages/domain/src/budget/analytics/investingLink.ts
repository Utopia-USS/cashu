/**
 * The budget's read-only link to the investments strategy (`modules/budget/investing_link.py`): the
 * planned monthly contribution the month close compares the surplus with. The caller loads the
 * strategy (state + the valid or partial config) only when the investments module is enabled for the
 * profile, and never records a strategy version for it.
 */

import type { Decimal } from "../../decimal.js";

/** The investments strategy service's states. */
export type StrategyState = "missing" | "valid" | "partial" | "invalid";

/** `PlannedContribution`. */
export interface PlannedContribution {
  readonly strategyState: StrategyState;
  /** `contributions.monthly_amount`; null when the strategy has no contributions plan. */
  readonly amount: Decimal | null;
  /** The strategy's base currency (the plan is in it). */
  readonly currency: string | null;
  readonly dayOfMonth: number | null;
}

/** What the month close reads from a loaded strategy config. */
export interface StrategyPlanSource {
  readonly baseCurrency: string;
  /** The `contributions` section, null when the strategy has none. */
  readonly contributions: {
    readonly monthlyAmount: Decimal;
    readonly dayOfMonth: number | null;
  } | null;
}

/**
 * `planned_contribution` of a loaded strategy: `config` is the valid config or the partial one (only
 * some rules inactive), null for a missing or invalid strategy.
 */
export function plannedContribution(
  state: StrategyState,
  config: StrategyPlanSource | null,
): PlannedContribution {
  const plan = config?.contributions ?? null;
  if (config === null || plan === null) {
    return { strategyState: state, amount: null, currency: null, dayOfMonth: null };
  }
  return {
    strategyState: state,
    amount: plan.monthlyAmount,
    currency: config.baseCurrency,
    dayOfMonth: plan.dayOfMonth,
  };
}
