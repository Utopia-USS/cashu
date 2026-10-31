/**
 * The pure part of the macro service (`macro/service.py`, P6 / P7 / P9): a regime as its API card
 * (`regime_dict`, `metric_dict`), the review digest's regime switches (`changes`), the dollar card's
 * currency effect from the weekly segment attribution, and which macro brief / note the card shows.
 *
 * Reading the stored closes, the per-(vault, as_of, data version) cache of `evaluate` and joining the
 * notes (`macro_view`) need the store and live with the investments read models (S22a); the refresh
 * glue (`refresh_and_store`) with the refresh orchestration (S22c).
 */

import type { UiLang } from "../../core/i18n.js";
import { type IsoDate, isoWeekLabel } from "../../dates.js";
import { roundFloat } from "../../decimal.js";
import { isEmptyAttribution, type SegmentAttribution } from "../performance/segmentAttribution.js";
import { type Instant, instantDate } from "../research/instant.js";
import {
  displayLabel,
  displayMeaning,
  displayStateLabel,
  formatMetric,
  HISTORY_MAX,
  type Metric,
  type MetricUnit,
  metricLabel,
  type Regime,
  type RegimeKey,
  type StateRun,
  stateLabel,
  type Tone,
} from "./regimes.js";
import { type CurrencyEffect, explain, plain, summary } from "./texts.js";

/** Digits a metric value keeps in the API. */
export const DIGITS = 6;

export interface MetricDict {
  readonly label: string;
  readonly value: number;
  readonly unit: MetricUnit;
  readonly text: string;
  readonly stale: boolean;
}

export interface HistoryDict {
  readonly date: IsoDate;
  readonly state: string;
  readonly state_label: string;
  readonly open: boolean;
}

/** A regime card without its notes (the API JSON shape, snake_case as the Python API). */
export interface RegimeDict {
  readonly key: RegimeKey;
  readonly label: string;
  readonly state: string;
  readonly state_label: string;
  readonly tone: Tone;
  readonly since: IsoDate | null;
  readonly since_open: boolean;
  readonly since_min: IsoDate | null;
  readonly as_of: IsoDate | null;
  readonly stale: boolean;
  readonly missing: boolean;
  readonly flags: readonly string[];
  readonly meaning: string;
  readonly summary: string;
  readonly plain: string;
  readonly explain: string;
  readonly metrics: readonly MetricDict[];
  readonly history: readonly HistoryDict[];
}

/** Python `round(float(value), DIGITS) + 0.0` (never `-0.0`). */
function apiValue(value: number): number {
  return roundFloat(value, DIGITS) + 0;
}

export function metricDict(m: Metric, lang: UiLang): MetricDict {
  return {
    label: metricLabel(m, lang),
    value: apiValue(m.value),
    unit: m.unit,
    text: formatMetric(m, lang),
    stale: m.stale,
  };
}

/**
 * A regime without its notes (the card's market part) with its human texts (`summary`, `plain`,
 * `explain`) in `lang`; `currency` folds the portfolio's weekly currency effect into the dollar card.
 * The history shows the last `HISTORY_MAX` runs.
 */
export function regimeDict(
  r: Regime,
  lang: UiLang,
  currency: CurrencyEffect | null = null,
): RegimeDict {
  return {
    key: r.key,
    label: displayLabel(r.key, lang),
    state: r.state,
    state_label: displayStateLabel(r, lang),
    tone: r.tone,
    since: r.since,
    since_open: r.sinceOpen,
    since_min: r.sinceMin,
    as_of: r.asOf,
    stale: r.stale,
    missing: r.missing,
    flags: [...r.flags],
    meaning: displayMeaning(r, lang),
    summary: summary(r, lang, currency),
    plain: plain(r, lang),
    explain: explain(r, lang),
    metrics: r.metrics.map((m) => metricDict(m, lang)),
    history: r.history.slice(-HISTORY_MAX).map((run) => ({
      date: run.date,
      state: run.state,
      state_label: stateLabel(r.key, run.state, lang),
      open: run.open,
    })),
  };
}

/** The newest bar any regime used (`macro_view`'s `as_of`), null without data. */
export function newestAsOf(regimes: readonly Regime[]): IsoDate | null {
  let last: IsoDate | null = null;
  for (const r of regimes) if (r.asOf !== null && (last === null || r.asOf > last)) last = r.asOf;
  return last;
}

export interface MacroChange {
  readonly key: RegimeKey;
  readonly label: string;
  readonly from_label: string;
  readonly to_label: string;
  readonly since: IsoDate | null;
}

/**
 * Regimes whose reported state changed within `start..end` (the review digest period), from the
 * regimes evaluated as of `end`. A switch counts in the period where it became visible
 * (`StateRun.confirmed`, the 5th session), never where its run began, so a switch straddling two
 * periods shows exactly once. from = the state reported before `start`, to = the current one;
 * `since` = the run's first session. A regime that came back to its starting state within the
 * period, a missing one and one whose state before `start` is unknown are left out.
 */
export function macroChanges(
  regimes: readonly Regime[],
  start: IsoDate,
  end: IsoDate,
  lang: UiLang,
): MacroChange[] {
  const out: MacroChange[] = [];
  for (const r of regimes) {
    if (r.missing || r.history.length === 0) continue;
    const before = r.history.filter((run) => run.confirmed < start);
    const within = r.history.some((run) => start <= run.confirmed && run.confirmed <= end);
    if (before.length === 0 || !within) continue;
    const old = (before[before.length - 1] as StateRun).state;
    const current = (r.history[r.history.length - 1] as StateRun).state;
    if (old === current) continue;
    out.push({
      key: r.key,
      label: displayLabel(r.key, lang),
      from_label: stateLabel(r.key, old, lang),
      to_label: stateLabel(r.key, current, lang),
      since: r.since,
    });
  }
  return out;
}

/**
 * The portfolio's currency effect over the last week for the dollar card, from the 1w segment
 * attribution ending on the card's day; null for an empty attribution (the card keeps its market
 * text). The caller treats a failing attribution as null too.
 */
export function currencyEffectOf(attribution: SegmentAttribution): CurrencyEffect | null {
  if (isEmptyAttribution(attribution)) return null;
  return {
    contribution: attribution.currencyContribution,
    foreign: attribution.currencies.length > 0,
  };
}

/**
 * The macro brief a card shows (P9): the newest active one (`briefs`, newest first), unless it was
 * observed before the current state began (a brief of the previous state would contradict the card,
 * which then falls back to `plain`). An open-ended state (`since` unknown) keeps it.
 */
export function currentBrief<T extends { readonly observedAt: Instant }>(
  briefs: readonly T[],
  r: Regime,
): T | null {
  const row = briefs[0];
  if (row === undefined) return null;
  if (r.since !== null && instantDate(row.observedAt) < r.since) return null;
  return row;
}

/** A note observed in the ISO week of `now` (UTC calendar), the card's `note_this_week`. */
export function inSameIsoWeek(observedAt: Instant | null, now: Instant): boolean {
  if (observedAt === null) return false;
  return isoWeekLabel(instantDate(observedAt)) === isoWeekLabel(instantDate(now));
}
