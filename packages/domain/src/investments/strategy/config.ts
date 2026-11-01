/** The parsed, validated strategy.yaml of one profile (`strategy/config.py`; built only by the loader). */

import type { UiLang } from "../../core/i18n.js";
import type { AllocationPlan } from "../domain/buckets.js";
import type { SignalSeverity } from "../domain/enums.js";
import type { Currency } from "../domain/values.js";
import type { ContributionPlan, DataQualityPolicy, RuleSpec } from "../rules/kind.js";
import type { RebalancePolicy } from "../rules/kinds/allocationDrift.js";
import { reviewNames } from "./strategy.strings.js";

export const Weekday = Object.freeze({
  MONDAY: "monday",
  TUESDAY: "tuesday",
  WEDNESDAY: "wednesday",
  THURSDAY: "thursday",
  FRIDAY: "friday",
  SATURDAY: "saturday",
  SUNDAY: "sunday",
} as const);
export type Weekday = (typeof Weekday)[keyof typeof Weekday];
export const WEEKDAYS: readonly Weekday[] = Object.freeze(Object.values(Weekday));

/** `Weekday.iso_number`: Monday = 1 ... Sunday = 7. */
export function isoNumber(day: Weekday): number {
  return WEEKDAYS.indexOf(day) + 1;
}

/** Screening thresholds from `watchlist.criteria` by YAML key; any numeric key is kept. */
export interface WatchlistCriteria {
  readonly values: ReadonlyMap<string, number>;
}

/** Keys that only drive the typo hints (`WatchlistCriteria.KNOWN_KEYS`). */
export const WATCHLIST_KNOWN_KEYS = [
  "max_pe",
  "min_pe",
  "max_pb",
  "min_dividend_yield",
  "min_market_cap_pln",
  "min_roe",
  "max_debt_to_equity",
] as const;

export const EMPTY_WATCHLIST: WatchlistCriteria = Object.freeze({ values: new Map() });

/** `benchmark:` - what the portfolio is compared with. */
export interface Benchmark {
  /** Display id of the benchmark (`msci_acwi`). */
  readonly id: string;
  /** Instrument alias that tracks it: a Yahoo symbol (`VWCE.DE`) or an ISIN. */
  readonly proxy: string;
  /** Currency the comparison is made in (defaults to `base_currency`). */
  readonly currency: Currency;
}

/** `notifications:` - severities that notify immediately and the weekly digest day. */
export interface NotificationPolicy {
  readonly immediate: ReadonlySet<SignalSeverity>;
  readonly digestWeekday: Weekday;
}

/** Defaults: only `action` signals notify immediately, digest on Sunday. */
export const DEFAULT_NOTIFICATIONS: NotificationPolicy = Object.freeze({
  immediate: new Set<SignalSeverity>(["action"]),
  digestWeekday: Weekday.SUNDAY,
});

/**
 * Cards of the review deck in their default order: Czy świat się wali, Sektory, Pozycje, Wydarzenia,
 * Okazje, Kalendarz, Do decyzji (what needs the owner closes the review).
 */
export const REVIEW_CARDS = [
  "world",
  "sectors",
  "positions",
  "events",
  "ideas",
  "calendar",
  "decide",
] as const;

/** `review.every` values (`REVIEW_EVERY` keys). */
export const REVIEW_EVERY = ["week", "2weeks", "month"] as const;
export type ReviewEvery = (typeof REVIEW_EVERY)[number];

/**
 * `review:` - how often (`every`; a monthly review falls on the first `day` of the month), on which
 * weekday (`day`; default `notifications.digest_weekday`), its name (default by `every`) and the cards
 * of the review deck, in order.
 */
export interface ReviewPolicy {
  readonly every: ReviewEvery;
  readonly day: Weekday | null;
  readonly name: string | null;
  readonly cards: readonly string[];
}

export const DEFAULT_REVIEW: ReviewPolicy = Object.freeze({
  every: "week",
  day: null,
  name: null,
  cards: REVIEW_CARDS,
});

/** `ReviewPolicy.title`: the owner's name or the default of `every` in the UI language. */
export function reviewTitle(policy: ReviewPolicy, lang: UiLang): string {
  return policy.name || reviewNames[policy.every][lang];
}

/** A profile's strategy as the engine sees it (`StrategyConfig`). */
export interface StrategyConfig {
  /** `version:`, currently always 1. */
  readonly version: number;
  readonly baseCurrency: Currency;
  /**
   * `buckets` (declaration order, first match wins) and `allocation.targets` (every bucket has a
   * target; buckets without one in the YAML get 0 and a warning). Both empty without buckets.
   */
  readonly allocation: AllocationPlan;
  readonly horizonYears: number | null;
  /** `allocation.rebalance` (defaults when absent); allocation_drift rules default to it. */
  readonly rebalance: RebalancePolicy;
  readonly data: DataQualityPolicy;
  readonly contributions: ContributionPlan | null;
  /** `rules:` in declaration order. */
  readonly rules: readonly RuleSpec[];
  readonly watchlist: WatchlistCriteria;
  readonly benchmark: Benchmark | null;
  readonly notifications: NotificationPolicy;
  /** `review:` (defaults when absent: weekly on the digest weekday, every card). */
  readonly review: ReviewPolicy;
  /** The strategy.md prose passed to the loader, if any. */
  readonly markdown: string | null;
}

/** `StrategyConfig.rule`: the rule with `ruleId`, or null. */
export function ruleById(config: StrategyConfig, ruleId: string): RuleSpec | null {
  return config.rules.find((rule) => rule.id === ruleId) ?? null;
}
