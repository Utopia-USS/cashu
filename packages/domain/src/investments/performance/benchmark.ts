/**
 * The benchmark (`performance/benchmark.py`): daily proxy prices in the base currency and the
 * same-cash-flow simulation. Pure.
 *
 * - Price for day `d`: the newest stored close of the proxy on/before `d` no older than
 *   `maxPriceAgeDays`, converted at the rate on/before `d` no older than `maxFxAgeDays` (the
 *   valuation's limits); null otherwise. Stored closes are split-adjusted by the source.
 * - Simulation: the portfolio's value at the range start buys proxy units at that day's price, then
 *   every external flow buys (withdrawals sell) units at that day's price. A flow on a day without a
 *   price waits for the next priced day (held as cash meanwhile). `withFees` also sells units for the
 *   portfolio's account-level fees. Units never go below 0 (`capped` says it happened).
 */

import { daysBetween } from "../../dates.js";
import { type FxLookup, fxQuoteAgeDays } from "../domain/fx.js";
import type { PriceBar } from "../domain/marketData.js";
import type { CalendarDate, Currency } from "../domain/values.js";
import { bisectRight } from "./search.js";

/** Proxy price in `base` for every day of `dates` (null where unknown or too old). */
export function benchmarkPrices(
  dates: readonly CalendarDate[],
  bars: readonly PriceBar[],
  currency: Currency,
  fx: FxLookup,
  base: Currency,
  limits: { readonly maxPriceAgeDays: number; readonly maxFxAgeDays: number }, // float-ok: day counts (Python int)
): (number | null)[] {
  // Python `sorted(bars, key=date)`: stable
  const ordered = [...bars].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const barDates = ordered.map((b) => b.date);
  const out: (number | null)[] = [];
  for (const day of dates) {
    const i = bisectRight(barDates, day) - 1;
    if (i < 0 || daysBetween(barDates[i] as CalendarDate, day) > limits.maxPriceAgeDays) {
      out.push(null);
      continue;
    }
    const quote = fx.quoteOnOrBefore(currency, day, base);
    if (quote === null || fxQuoteAgeDays(quote, day) > limits.maxFxAgeDays) {
      out.push(null);
      continue;
    }
    out.push((ordered[i] as PriceBar).close.mul(quote.rate).toFloat());
  }
  return out;
}

/** Prices divided by the first known positive price at or after `start` (null before it). */
export function priceIndex(
  prices: readonly (number | null)[], // float-ok: Python float prices
  start = 0,
): (number | null)[] {
  let first: number | null = null;
  for (let i = start; i < prices.length; i++) {
    const p = prices[i] as number | null;
    if (p !== null && p > 0) {
      first = p;
      break;
    }
  }
  const out: (number | null)[] = new Array(prices.length).fill(null);
  if (first === null) return out;
  for (let i = start; i < prices.length; i++) {
    const price = prices[i] as number | null;
    out[i] = price === null ? null : price / first;
  }
  return out;
}

/** Daily values of the same-cash-flow benchmark holding (null before the first priced day). */
export interface Simulation {
  readonly values: readonly (number | null)[];
  readonly withFees: readonly (number | null)[]; // float-ok: Python float values
  /** First day the simulation held units (the range start when the proxy had a price then). */
  readonly started: CalendarDate | null;
  readonly capped: boolean;
}

/**
 * The same-cash-flow simulation over `dates` (index 0 = range start: `startValue` is invested there;
 * flows of index 0 are part of it).
 */
export function simulate(
  dates: readonly CalendarDate[],
  prices: readonly (number | null)[], // float-ok: Python float prices
  startValue: number,
  flows: readonly number[],
  fees: readonly number[] | null = null, // float-ok: Python float fees
): Simulation {
  const n = dates.length;
  const feeList = fees ?? new Array<number>(n).fill(0.0);
  let units = 0.0;
  let unitsFees = 0.0;
  let pending = startValue;
  let pendingFees = 0.0;
  let lastPrice: number | null = null; // float-ok: Python float price
  let started: CalendarDate | null = null;
  let capped = false;
  const values: (number | null)[] = [];
  const withFees: (number | null)[] = []; // float-ok: Python float values
  for (let i = 0; i < n; i++) {
    if (i > 0) {
      pending += flows[i] as number;
      pendingFees += feeList[i] as number;
    }
    const price = prices[i] as number | null;
    const priced = price !== null && price > 0;
    if (priced) lastPrice = price;
    if (lastPrice === null) {
      values.push(null);
      withFees.push(null);
      continue;
    }
    if (priced && (pending !== 0 || pendingFees !== 0)) {
      units += pending / lastPrice;
      unitsFees += (pending - pendingFees) / lastPrice;
      pending = 0.0;
      pendingFees = 0.0;
      if (started === null) started = dates[i] as CalendarDate;
    }
    if (units < 0) {
      units = 0.0;
      capped = true;
    }
    if (unitsFees < 0) {
      unitsFees = 0.0;
      capped = true;
    }
    // a flow waiting for the next priced day is held as cash meanwhile
    values.push(units * lastPrice + pending);
    withFees.push(unitsFees * lastPrice + pending - pendingFees);
  }
  return Object.freeze({ values, withFees, started, capped });
}
