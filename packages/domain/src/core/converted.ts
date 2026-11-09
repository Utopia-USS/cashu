/**
 * Net worth converted into one currency (the owner's choice of 2026-11-09): every currency's net worth
 * at the NBP rate of the day, summed into the headline currency, with the per-currency amounts kept
 * next to it. Per currency stays the truth (`networth.ts` never sums currencies); this is a clearly
 * labelled conversion on top of it, so money that changes currency (PLN into USD investments) no
 * longer reads as a gain or a loss. Pure: the caller hands over the rates (`RateAt`).
 */

import { addDays, type IsoDate } from "../dates.js";
import { D, type Decimal, ZERO } from "../decimal.js";
import type { UiLang } from "./i18n.js";
import {
  componentOrder,
  type NetWorthBook,
  netWorthBreakdown,
  netWorthSeriesCompleteFrom,
  resamplePeriodEnd,
} from "./networth.js";
import {
  HERO_LIQUID_TYPES,
  type HeroFacts,
  type NetWorthSummary,
  type SeriesComponent,
  type SeriesPoint,
  type SeriesRequest,
  type SeriesView,
  seriesView,
} from "./overview.js";
import { ZERO_00 } from "./zero.js";

/** A rate: units of the target currency per 1 unit of the source currency, and its table date. */
export interface RateQuote {
  readonly rate: Decimal;
  readonly date: IsoDate;
}

/** The rate of `currency` on or before `on` into the target currency; null without one. */
export type RateAt = (currency: string, on: IsoDate) => RateQuote | null;

const CENT = D("0.01");
const toTarget = (amount: Decimal, quote: RateQuote): Decimal =>
  amount.mul(quote.rate).quantize(CENT);

/** One other currency inside the converted total: its own net worth and the rate it was converted at. */
export interface ConvertedPart {
  readonly currency: string;
  /** Net worth in that currency, never converted. */
  readonly amount: Decimal;
  /** The rate used; null when none is known (the part is left out of the total). */
  readonly quote: RateQuote | null;
}

/** The hero's facts with every currency converted into the headline one. */
export interface ConvertedHero {
  /** The headline currency every converted figure is in. */
  readonly currency: string;
  readonly net: Decimal;
  readonly assets: Decimal;
  /** Positive magnitude of debts. */
  readonly liabilities: Decimal;
  /** Checking, savings and cash of every currency. */
  readonly liquid: Decimal;
  /** The other currencies, code order. */
  readonly parts: readonly ConvertedPart[];
  /** The oldest rate date used; null when no part has a rate. */
  readonly rateDate: IsoDate | null;
}

/**
 * The hero converted into its headline currency at the rates of `today`: the headline facts plus
 * every other currency's net worth, assets, liabilities and liquid money at its rate. null when the
 * profile holds no other currency. A currency without a rate stays out of the sums and is listed
 * with `quote: null`.
 */
export function convertedHero(
  book: NetWorthBook,
  summary: NetWorthSummary,
  facts: HeroFacts,
  rateAt: RateAt,
  today: IsoDate,
): ConvertedHero | null {
  const others = Object.entries(facts.otherCurrencies);
  if (others.length === 0) return null;
  let net = facts.net;
  let assets = facts.assets;
  let liabilities = facts.liabilities;
  let liquid = facts.liquid;
  let rateDate: IsoDate | null = null;
  const parts: ConvertedPart[] = [];
  for (const [currency, amount] of others) {
    const quote = rateAt(currency, today);
    parts.push({ currency, amount, quote });
    if (quote === null) continue;
    if (rateDate === null || quote.date < rateDate) rateDate = quote.date;
    const bd = netWorthBreakdown(book, currency);
    net = net.add(toTarget(bd.net, quote));
    assets = assets.add(toTarget(bd.assets, quote));
    liabilities = liabilities.add(toTarget(bd.liabilities, quote));
    let cash = ZERO_00;
    for (const l of summary.lines) {
      if (l.account.currency !== currency || !HERO_LIQUID_TYPES.has(l.account.type)) continue;
      if (l.contribution !== null) cash = cash.add(l.contribution);
    }
    liquid = liquid.add(toTarget(cash, quote));
  }
  return { currency: facts.currency, net, assets, liabilities, liquid, parts, rateDate };
}

/** The currencies of the accounts the history counts (removed ones never count). */
function bookCurrencies(book: NetWorthBook): string[] {
  const out = new Set<string>();
  for (const a of book.accounts) if (a.removedAt === null) out.add(a.currency);
  return [...out].sort();
}

/**
 * The net-worth history of every currency converted into `request.currency` at the rate of each day
 * and summed, split into the same buckets. With no other currency it is the plain `seriesView`. A
 * point counts (`completeFrom`) once every currency's accounts are known and every non-zero amount of
 * another currency has a rate on or before that day; `convertedFrom` names the converted currencies.
 */
export function convertedSeriesView(
  book: NetWorthBook,
  request: SeriesRequest,
  lang: UiLang,
  rateAt: RateAt,
): SeriesView {
  const target = request.currency;
  const others = bookCurrencies(book).filter((c) => c !== target);
  const own = seriesView(book, request, lang);
  if (others.length === 0) return own;
  // A currency without any rate up to today cannot be converted at all: it stays out (the hero lists
  // it as missing) instead of leaving every point incomplete.
  const views = [target, ...others]
    .filter((currency) => currency === target || rateAt(currency, book.today) !== null)
    .map((currency) => ({
      currency,
      view: seriesView(book, { ...request, currency, granularity: "daily" }, lang),
      from: netWorthSeriesCompleteFrom(book, currency, request.scope),
    }))
    .filter((v) => v.view.points.length > 0);
  const converted = views.map((v) => v.currency).filter((c) => c !== target);
  if (converted.length === 0) return own;

  const dates = [...new Set(views.flatMap((v) => v.view.points.map((p) => p.date)))].sort();
  const cursor = views.map(() => -1);
  let rateGap: IsoDate | null = null;
  const daily: [IsoDate, Map<string, Decimal>][] = [];
  for (const d of dates) {
    const comps = new Map<string, Decimal>();
    for (const [i, v] of views.entries()) {
      const points = v.view.points;
      let at = cursor[i] as number;
      while (at + 1 < points.length && (points[at + 1] as SeriesPoint).date <= d) at += 1;
      cursor[i] = at;
      const p = points[at];
      if (p === undefined) continue;
      const quote = v.currency === target ? null : rateAt(v.currency, d);
      if (v.currency !== target && quote === null) {
        if (!p.value.isZero()) rateGap = d;
        continue;
      }
      for (const [k, amount] of Object.entries(p.components)) {
        const value = quote === null ? amount : toTarget(amount, quote);
        comps.set(k, (comps.get(k) ?? ZERO_00).add(value));
      }
    }
    daily.push([d, comps]);
  }
  const series =
    request.granularity === "daily" ? daily : resamplePeriodEnd(daily, request.granularity);

  let from: IsoDate | null = rateGap === null ? null : addDays(rateGap, 1);
  for (const v of views) if (v.from !== null && (from === null || v.from > from)) from = v.from;

  const present = componentOrder(book.types).filter((k) => series.some(([, c]) => c.has(k)));
  const labels = new Map<string, SeriesComponent>();
  for (const v of views) for (const c of v.view.components) labels.set(c.key, c);
  const points = series.map(([date, comps]): SeriesPoint => {
    let value = ZERO;
    const components: Record<string, Decimal> = {};
    for (const k of present) {
      const v = comps.get(k);
      if (v === undefined) continue;
      components[k] = v;
      value = value.add(v);
    }
    return { date, value, components };
  });
  return {
    currency: target,
    points,
    components: present.flatMap((k) => {
      const c = labels.get(k);
      return c === undefined ? [] : [c];
    }),
    completeFrom: from !== null && points.some((p) => p.date < from) ? from : null,
    convertedFrom: converted,
  };
}
