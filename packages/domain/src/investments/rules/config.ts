/** Configured rules and strategy policies, independent of evaluation. */
import type { Decimal } from "../../decimal.js";
import type { SignalSeverity } from "../domain/enums.js";
import { DEFAULT_MAX_FX_AGE_DAYS } from "../domain/fx.js";
import type { SignalPolarity } from "./polarity.js";

/** A configured rule from strategy.yaml with parsed params (`RuleSpec`). */
export interface RuleSpec<P = unknown> {
  /** Unique rule id within the strategy (`dip_review`). */
  readonly id: string;
  readonly kind: string;
  readonly params: P;
  /** Severity of signals this rule fires (YAML `severity`, default info). */
  readonly severity: SignalSeverity;
  /** YAML `cooldown_days`: a resolved signal of the same key does not come back within this many days. */
  readonly cooldownDays: number | null;
  /** YAML `polarity`: overrides the kind's default polarity (null = the kind's default). */
  readonly polarity: SignalPolarity | null;
}

export const DEFAULT_MAX_UNVERIFIED_DAYS = 14;
export const MAX_UNVERIFIED_DAYS = 3650;

/** Data-quality thresholds from the strategy's `data:` section (`DataQualityPolicy`). */
export interface DataQualityPolicy {
  /** A price older than this many calendar days (relative to as_of) is stale. */
  readonly maxPriceAgeDays: number; // float-ok: a day count, not a price
  /** Portfolio-weight rules skip when the stale-priced share of the portfolio exceeds this (0..1). */
  readonly maxStaleWeight: number;
  /** allocation_drift (and tagged_weight) skip while holdings matching no bucket exceed this share. */
  readonly maxUnclassifiedWeight: number;
  /** An FX rate older than this many days relative to the date it is needed for counts as missing. */
  readonly maxFxAgeDays: number;
  /** An open signal no run confirmed for more than this many days expires; null = never. */
  readonly maxUnverifiedDays: number | null;
}

export const DATA_QUALITY_KEYS = [
  "max_price_age_days",
  "max_stale_weight",
  "max_unclassified_weight",
  "max_fx_age_days",
  "max_unverified_days",
] as const;

/** `DataQualityPolicy()`: the defaults. */
export const DEFAULT_DATA_QUALITY: DataQualityPolicy = Object.freeze({
  maxPriceAgeDays: 5,
  maxStaleWeight: 0.05,
  maxUnclassifiedWeight: 0.02,
  maxFxAgeDays: DEFAULT_MAX_FX_AGE_DAYS,
  maxUnverifiedDays: DEFAULT_MAX_UNVERIFIED_DAYS,
});

/** Planned contributions from the strategy's `contributions:` section (`ContributionPlan`). */
export interface ContributionPlan {
  /** Planned deposit per month in the base currency. */
  readonly monthlyAmount: Decimal;
  readonly dayOfMonth: number | null;
}
