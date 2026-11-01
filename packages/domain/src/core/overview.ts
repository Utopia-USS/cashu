/**
 * Core read models of the overview (Przegląd): the net-worth history view (`GET /networth/series` of
 * `core/api.py`), the core half of the shell summary (`GET /summary` of `api/app.py`) and the hero
 * facts the SPA computed from those responses (`frontend/src/core/Overview.tsx` `NetHero`). Pure over a
 * `NetWorthBook`; per currency, never summed across currencies. Values stay `Decimal`; the API layer
 * turns them into JSON numbers.
 */

import type { IsoDate } from "../dates.js";
import { type Decimal, ZERO } from "../decimal.js";
import { bucketLabel } from "./accountTypes.js";
import type { UiLang } from "./i18n.js";
import {
  componentOrder,
  type Granularity,
  liabilityComponents,
  type NetWorth,
  type NetWorthBook,
  type NetWorthBreakdown,
  netWorth,
  netWorthBreakdown,
  netWorthComponentSeries,
  type SeriesScope,
} from "./networth.js";
import { ZERO_00 } from "./zero.js";

/** The profile's headline currency: its base currency, `PLN` when none is stored (`or "PLN"`). */
export function headlineCurrency(baseCurrency: string | null | undefined): string {
  return baseCurrency || "PLN";
}

// --------------------------------------------------------------------------- series view

export interface SeriesRequest {
  readonly currency: string;
  readonly granularity: Granularity;
  readonly scope: SeriesScope;
}

/**
 * The route's query parameters as the series reads them: a granularity other than `weekly` /
 * `monthly` keeps every point (daily), a scope other than `liquid` counts every account (total), no
 * currency means the profile's base currency.
 */
export function seriesRequest(params: {
  readonly currency?: string | null;
  readonly granularity?: string | null;
  readonly scope?: string | null;
  readonly baseCurrency: string | null | undefined;
}): SeriesRequest {
  const g = params.granularity;
  return {
    currency: params.currency || headlineCurrency(params.baseCurrency),
    granularity: g === "weekly" || g === "monthly" ? g : "daily",
    scope: params.scope === "liquid" ? "liquid" : "total",
  };
}

export interface SeriesPoint {
  readonly date: IsoDate;
  /** The net worth at `date`: the sum of the components. */
  readonly value: Decimal;
  /** Bucket -> contribution, only buckets present in the series, in component order. */
  readonly components: Readonly<Record<string, Decimal>>;
}

export interface SeriesComponent {
  readonly key: string;
  /** The bucket label in the request's language. */
  readonly label: string;
  readonly liability: boolean;
}

export interface SeriesView {
  /** The one currency of the series (never converted or summed across currencies). */
  readonly currency: string;
  readonly points: readonly SeriesPoint[];
  /** The buckets that hold a value at some point, in stacking order. */
  readonly components: readonly SeriesComponent[];
}

/** `GET /networth/series`: the net-worth history in one currency, split into its present buckets. */
export function seriesView(book: NetWorthBook, request: SeriesRequest, lang: UiLang): SeriesView {
  const series = netWorthComponentSeries(
    book,
    request.currency,
    request.granularity,
    request.scope,
  );
  const present = componentOrder(book.types).filter((k) =>
    series.some(([, comps]) => comps.has(k)),
  );
  const liabilities = liabilityComponents(book.types);
  const labels = new Map(book.types.buckets().map((b) => [b.id, bucketLabel(b, lang)]));
  const points = series.map(([date, comps]): SeriesPoint => {
    // Python sum(comps.values(), Decimal(0)): the start has no places.
    let value = ZERO;
    for (const v of comps.values()) value = value.add(v);
    const components: Record<string, Decimal> = {};
    for (const k of present) {
      const v = comps.get(k);
      if (v !== undefined) components[k] = v;
    }
    return { date, value, components };
  });
  return {
    currency: request.currency,
    points,
    components: present.map((key) => ({
      key,
      label: labels.get(key) ?? key,
      liability: liabilities.has(key),
    })),
  };
}

// --------------------------------------------------------------------------- summary (core half)

export interface NetWorthSummary {
  /** Net worth per currency, currencies in code order (every currency keeps its own total). */
  readonly networth: Readonly<Record<string, Decimal>>;
  /** Assets vs liabilities in the headline currency. */
  readonly breakdown: NetWorthBreakdown;
  /** The net-worth lines (active, non-removed accounts) the hero facts read. */
  readonly lines: NetWorth["lines"];
}

/** Code-point order of currency codes (Python `sorted(totals.items())`). */
const byCode = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The core half of `GET /summary` (and of `GET /networth`): totals now plus the headline breakdown. */
export function netWorthSummary(
  book: NetWorthBook,
  baseCurrency: string | null | undefined,
): NetWorthSummary {
  const { totals, lines } = netWorth(book);
  const networth: Record<string, Decimal> = {};
  for (const c of [...totals.keys()].sort(byCode)) networth[c] = totals.get(c) as Decimal;
  return {
    networth,
    breakdown: netWorthBreakdown(book, headlineCurrency(baseCurrency)),
    lines,
  };
}

// --------------------------------------------------------------------------- hero facts

/**
 * Account types the hero counts as liquid money: the budget's accounts and cash. Narrower than the
 * registry's `liquid` flag of the series scope (which also counts credit cards, investments and other
 * assets): the hero shows what can be spent, as the SPA always did.
 */
export const HERO_LIQUID_TYPES: ReadonlySet<string> = new Set(["checking", "savings", "cash"]);

/** How many liability types the hero names under the liabilities fact. */
const LIABILITY_TYPES_SHOWN = 2;

export interface HeroFacts {
  /** The headline currency every fact is in. */
  readonly currency: string;
  readonly net: Decimal;
  readonly assets: Decimal;
  /** Positive magnitude of debts. */
  readonly liabilities: Decimal;
  /** Distinct types (first two, in line order) of the liabilities with a non-zero balance. */
  readonly liabilityTypes: readonly string[];
  /** Property minus mortgage; null when the profile holds neither. */
  readonly homeEquity: Decimal | null;
  /** Checking, savings and cash in the headline currency. */
  readonly liquid: Decimal;
  /** Net-worth lines in every currency (the "N accounts" detail). */
  readonly accounts: number;
  /** Net worth in the other currencies, code order (shown, never converted). */
  readonly otherCurrencies: Readonly<Record<string, Decimal>>;
}

/** The hero strip's facts from the summary (Python had none: the SPA computed them from the API). */
export function heroFacts(summary: NetWorthSummary): HeroFacts {
  const bd = summary.breakdown;
  const c = bd.currency;
  const inCurrency = summary.lines.filter((l) => l.account.currency === c);
  const liabilityTypes: string[] = [];
  for (const l of inCurrency) {
    if (!l.isLiability || l.contribution === null || l.contribution.isZero()) continue;
    if (!liabilityTypes.includes(l.account.type)) liabilityTypes.push(l.account.type);
  }
  let liquid = ZERO_00;
  for (const l of inCurrency) {
    if (HERO_LIQUID_TYPES.has(l.account.type) && l.contribution !== null) {
      liquid = liquid.add(l.contribution);
    }
  }
  const otherCurrencies: Record<string, Decimal> = {};
  for (const [k, v] of Object.entries(summary.networth)) if (k !== c) otherCurrencies[k] = v;
  const hasHome = !bd.propertyValue.isZero() || !bd.mortgage.isZero();
  return {
    currency: c,
    net: bd.net,
    assets: bd.assets,
    liabilities: bd.liabilities,
    liabilityTypes: liabilityTypes.slice(0, LIABILITY_TYPES_SHOWN),
    homeEquity: hasHome ? bd.homeEquity : null,
    liquid,
    accounts: summary.lines.length,
    otherCurrencies,
  };
}

/**
 * Months of spending the liquid money covers: `liquid / norm`, where `norm` is the monthly spending
 * of complete months (budget `closedMonthNorm`); null without a norm or with a zero one.
 */
export function monthsOfSpending(liquid: Decimal, monthlySpending: Decimal | null): Decimal | null {
  if (monthlySpending === null || monthlySpending.isZero()) return null;
  return liquid.div(monthlySpending);
}

export interface NetWorthChange {
  /** Last point minus the one before it. */
  readonly change: Decimal;
  /** `change / |previous|`; null when the previous value is zero. */
  readonly changePct: Decimal | null;
  /** The previous point's date (the hero says "since <its month>"). */
  readonly since: IsoDate;
}

/** The hero's change since last month: the last two points of the monthly total series. */
export function netWorthChange(points: readonly SeriesPoint[]): NetWorthChange | null {
  if (points.length < 2) return null;
  const prev = points[points.length - 2] as SeriesPoint;
  const last = points[points.length - 1] as SeriesPoint;
  const change = last.value.sub(prev.value);
  return {
    change,
    changePct: prev.value.isZero() ? null : change.div(prev.value.abs()),
    since: prev.date,
  };
}
