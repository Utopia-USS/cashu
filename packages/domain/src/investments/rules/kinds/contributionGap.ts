import type { RuleContext } from "../context.js";
import type { RuleSpec } from "../kind.js";
import {
  candidate,
  Fired,
  NotFired,
  type RuleOutcome,
  Skipped,
  signalDedupKey,
} from "../outcomes.js";
import { kindStrings as messages } from "./evaluate.strings.js";
/** `contribution_gap` (`rules/kinds/contribution_gap.py`), the parsing side. */

import type { PyPlainMap } from "../../../pyYaml/plain.js";
import { daysBetween } from "../../domain/values.js";
import type { RuleKind } from "../kind.js";
import { type ParamErrors, ParamReader } from "../params.js";
import { SignalPolarity } from "../polarity.js";
import {
  daysPhrase,
  decimalText,
  formatDecimal,
  lastDepositDate,
  noContributionsPlan,
} from "./support.js";

function evaluateContributionGap(
  ctx: RuleContext,
  spec: RuleSpec<ContributionGapParams>,
): RuleOutcome[] {
  const key = signalDedupKey(spec.id);
  const plan = ctx.contributions;
  if (plan === null) return [new Skipped(spec.id, noContributionsPlan(ctx.lang), key)];
  const { periodDays, graceDays } = spec.params;
  const last = lastDepositDate(ctx);
  const days = last === null ? null : daysBetween(last, ctx.asOf);
  const details = {
    monthly_amount: decimalText(plan.monthlyAmount),
    day_of_month: plan.dayOfMonth,
    period_days: periodDays,
    grace_days: graceDays,
    last_deposit: last,
    days_since_last_deposit: days,
  };
  const allowed = periodDays + graceDays;
  if (days !== null && days <= allowed) return [new NotFired(spec.id, key, details)];
  const message =
    days === null || last === null
      ? messages.noDeposits[ctx.lang](
          formatDecimal(plan.monthlyAmount, ctx.lang),
          ctx.portfolio.baseCurrency,
        )
      : messages.contributionGap[ctx.lang](
          daysPhrase(days, ctx.lang),
          last,
          daysPhrase(allowed, ctx.lang),
        );
  return [new Fired(candidate(spec, key, message, details))];
}

export const DEFAULT_PERIOD_DAYS = 31;
export const DEFAULT_GRACE_DAYS = 10;

export class ContributionGapParams {
  /** Expected days between deposits (31 for a monthly plan). */
  readonly periodDays: number;
  /** Extra days tolerated before the gap fires. */
  readonly graceDays: number;
  constructor(init: { readonly periodDays?: number; readonly graceDays?: number } = {}) {
    this.periodDays = init.periodDays ?? DEFAULT_PERIOD_DAYS;
    this.graceDays = init.graceDays ?? DEFAULT_GRACE_DAYS;
  }
}

export const CONTRIBUTION_GAP = "contribution_gap";

export const contributionGapRule: RuleKind<ContributionGapParams> = Object.freeze({
  kind: CONTRIBUTION_GAP,
  defaultPolarity: SignalPolarity.NEGATIVE, // a deposit gap
  paramsType: ContributionGapParams,
  evaluate: evaluateContributionGap,
  parseParams(raw: PyPlainMap, errors: ParamErrors): ContributionGapParams {
    const reader = new ParamReader(raw, errors);
    const params = {
      periodDays: reader.integer("period_days", { fallback: DEFAULT_PERIOD_DAYS, minimum: 1 }),
      graceDays: reader.integer("grace_days", { fallback: DEFAULT_GRACE_DAYS, minimum: 0 }),
    };
    reader.finish();
    return new ContributionGapParams(params);
  },
});
