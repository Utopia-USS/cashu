/** Pure rule inputs (`rules/kind.py`), with the caller's language made explicit. */
import type { UiLang } from "../../core/i18n.js";
import type {
  AllocationResult,
  BucketAllocation,
  MarketView,
  ValuedHolding,
  ValuedPortfolio,
} from "../domain/snapshot.js";
import type { CalendarDate, ProfileId } from "../domain/values.js";
import { type ContributionPlan, type DataQualityPolicy, DEFAULT_DATA_QUALITY } from "./config.js";
export interface RuleContext {
  readonly profileId: ProfileId;
  readonly asOf: CalendarDate;
  readonly portfolio: ValuedPortfolio;
  readonly market: MarketView;
  readonly allocations: readonly BucketAllocation[];
  readonly unclassified: readonly ValuedHolding[];
  readonly data: DataQualityPolicy;
  readonly contributions: ContributionPlan | null;
  readonly lang: UiLang;
}
export function buildRuleContext(init: {
  readonly profileId: ProfileId;
  readonly asOf: CalendarDate;
  readonly portfolio: ValuedPortfolio;
  readonly market: MarketView;
  readonly allocation?: AllocationResult | null;
  readonly data?: DataQualityPolicy | null;
  readonly contributions?: ContributionPlan | null;
  readonly lang?: UiLang;
}): RuleContext {
  return Object.freeze({
    profileId: init.profileId,
    asOf: init.asOf,
    portfolio: init.portfolio,
    market: init.market,
    allocations: [...(init.allocation?.allocations ?? [])],
    unclassified: [...(init.allocation?.unclassified ?? [])],
    data: init.data ?? DEFAULT_DATA_QUALITY,
    contributions: init.contributions ?? null,
    lang: init.lang ?? "en",
  });
}
