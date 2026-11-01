/** `contribution_gap` (`rules/kinds/contribution_gap.py`), the parsing side. */

import type { PyPlainMap } from "../../../pyYaml/plain.js";
import type { RuleKind } from "../kind.js";
import { type ParamErrors, ParamReader } from "../params.js";
import { SignalPolarity } from "../polarity.js";

export const DEFAULT_PERIOD_DAYS = 31;
export const DEFAULT_GRACE_DAYS = 10;

export interface ContributionGapParams {
  /** Expected days between deposits (31 for a monthly plan). */
  readonly periodDays: number;
  /** Extra days tolerated before the gap fires. */
  readonly graceDays: number;
}

export const CONTRIBUTION_GAP = "contribution_gap";

export const contributionGapRule: RuleKind<ContributionGapParams> = Object.freeze({
  kind: CONTRIBUTION_GAP,
  defaultPolarity: SignalPolarity.NEGATIVE, // a deposit gap
  parseParams(raw: PyPlainMap, errors: ParamErrors): ContributionGapParams {
    const reader = new ParamReader(raw, errors);
    const params = {
      periodDays: reader.integer("period_days", { fallback: DEFAULT_PERIOD_DAYS, minimum: 1 }),
      graceDays: reader.integer("grace_days", { fallback: DEFAULT_GRACE_DAYS, minimum: 0 }),
    };
    reader.finish();
    return params;
  },
});
