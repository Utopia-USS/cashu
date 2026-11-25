/**
 * Range metrics on a combined daily series (`performance/report.py`): value, contributions, TWR, XIRR,
 * drawdowns, the benchmark and its same-cash-flow simulation, rolling relative windows, calendar
 * years. Pure.
 *
 * Ranges (`RANGES`) end on the series' last day; the start is the base day whose end-of-day value is
 * the starting capital: `1m` / `3m` / `1y` / `3y` = the same calendar day that many months back
 * (clamped to the month's last day), `ytd` = 31 December of the previous year, `max` = the day before
 * the first transaction (value 0). A base day before the series start is clamped to it.
 *
 * Rolling windows (12 / 24 / 36 months): at every month end (and the last day) whose window start lies
 * inside the history and finds capital at work, `portfolio` = TWR over the window, `benchmark` = the
 * proxy's price change over the same days, `excess` = portfolio - benchmark (cumulative).
 */

import { daysBetween, daysInMonth, monthsBack, parseDate } from "../../dates.js";
import type { CalendarDate } from "../domain/values.js";
import { priceIndex, type Simulation, simulate } from "./benchmark.js";
import { pySum } from "./floats.js";
import {
  annualized,
  CAPITAL_EPSILON,
  type Drawdown,
  drawdownSeries,
  maxDrawdown,
  periodReturn,
  twrIndex,
  xirr,
  xirrAnnual,
  xirrPeriod,
} from "./returns.js";
import type { Combined } from "./series.js";

export const RANGES = Object.freeze(["1m", "3m", "ytd", "1y", "3y", "max"] as const);
export type RangeKey = (typeof RANGES)[number];
export const ROLLING_MONTHS: readonly number[] = Object.freeze([12, 24, 36]);

export function isRangeKey(value: string): value is RangeKey {
  return (RANGES as readonly string[]).includes(value);
}

/** `range_base`: base day of range `key` ending on `end` (`anchor` = the series' first day). */
export function rangeBase(key: RangeKey, end: CalendarDate, anchor: CalendarDate): CalendarDate {
  let start: CalendarDate;
  switch (key) {
    case "1m":
      start = monthsBack(end, 1);
      break;
    case "3m":
      start = monthsBack(end, 3);
      break;
    case "ytd":
      start = `${String(parseDate(end).year - 1).padStart(4, "0")}-12-31`;
      break;
    case "1y":
      start = monthsBack(end, 12);
      break;
    case "3y":
      start = monthsBack(end, 36);
      break;
    case "max":
      start = anchor;
      break;
    default:
      throw new RangeError(`unknown range ${String(key)}; use one of ${RANGES.join(", ")}`);
  }
  return laterDate(start, anchor);
}

/** Python `max(a, b)` of two dates (ISO text compares as dates). */
function laterDate(a: CalendarDate, b: CalendarDate): CalendarDate {
  if (b > a) return b;
  return a;
}

/** Python `min(a, b)` of two dates. */
function earlierDate(a: CalendarDate, b: CalendarDate): CalendarDate {
  if (b < a) return b;
  return a;
}

/** The range summary (`RangeMetrics.summary`): floats as Python computes them. */
export interface RangeSummary {
  readonly startValue: number;
  readonly endValue: number;
  readonly netContributions: number;
  readonly deposits: number;
  readonly withdrawals: number;
  readonly impliedFunding: number;
  readonly accountFees: number; // float-ok: Python float
  readonly contributionsGross: number; // float-ok: Python float
  readonly pnl: number;
  readonly twr: number | null;
  readonly twrAnnualized: number | null;
  readonly xirr: number | null;
  readonly mwr: number | null;
  readonly maxDrawdown: Drawdown;
  readonly days: number;
  readonly incompleteDays: number;
  readonly endComplete: boolean;
}

/** The benchmark side of a range (`RangeMetrics.benchmark`). */
export interface RangeBenchmark {
  readonly twr: number | null;
  readonly twrAnnualized: number | null;
  readonly maxDrawdown: Drawdown;
  readonly firstPriced: CalendarDate | null;
  readonly coversRange: boolean;
  readonly lastPriced: CalendarDate | null;
  readonly coversRangeEnd: boolean;
  readonly simulationEndValue: number | null;
  readonly simulationEndValueWithFees: number | null; // float-ok: Python float
  readonly simulationPnl: number | null;
  readonly simulationXirr: number | null;
  readonly simulationMwr: number | null;
  readonly simulationStarted: CalendarDate | null;
  readonly simulationCapped: boolean;
  readonly excessTwr: number | null;
  readonly excessValue: number | null;
  readonly excessVsSimulation: number | null;
}

/** Everything one range needs: aligned daily arrays (index 0 = base day) and the summary. */
export interface RangeMetrics {
  readonly key: RangeKey;
  readonly dates: readonly CalendarDate[];
  readonly values: readonly number[];
  readonly flows: readonly number[];
  readonly complete: readonly boolean[];
  readonly twr: readonly (number | null)[];
  readonly drawdown: readonly (number | null)[];
  readonly benchmarkIndex: readonly (number | null)[] | null;
  readonly benchmarkDrawdown: readonly (number | null)[] | null;
  readonly simulation: Simulation | null;
  readonly summary: RangeSummary;
  /** null without benchmark prices (Python's empty dict). */
  readonly benchmark: RangeBenchmark | null;
}

/** `RangeMetrics.start`. */
export const rangeStart = (m: RangeMetrics): CalendarDate => m.dates[0] as CalendarDate;
/** `RangeMetrics.end`. */
export const rangeEnd = (m: RangeMetrics): CalendarDate =>
  m.dates[m.dates.length - 1] as CalendarDate;

/** Python `float(sum(values))` (compensated float sum). */
const floatSum = (values: Iterable<number>): number => pySum(values);

/** Metrics of range `key` over a full-history combined series (`dates` aligned with it). */
export function computeRange(
  key: RangeKey,
  dates: readonly CalendarDate[],
  combined: Combined,
  benchPrices: readonly (number | null)[] | null, // float-ok: Python float prices
): RangeMetrics {
  const base = rangeBase(key, dates[dates.length - 1] as CalendarDate, dates[0] as CalendarDate);
  const i0 = daysBetween(dates[0] as CalendarDate, base);
  const ds = dates.slice(i0);
  const values = combined.values.slice(i0);
  const flows = combined.flows.slice(i0);
  const fees = combined.fees.slice(i0);
  const complete = combined.complete.slice(i0);
  const implied = combined.implied.slice(i0);
  const index = twrIndex(values, flows, complete);
  const first = ds[0] as CalendarDate;
  const last = ds[ds.length - 1] as CalendarDate;
  const span = daysBetween(first, last);
  const startValue = values[0] as number;
  const endValue = values[values.length - 1] as number;
  const inner = flows.slice(1);
  const netFlows = floatSum(inner);
  const deposits = floatSum(inner.filter((f) => f > 0));
  const withdrawals = floatSum(inner.filter((f) => f < 0).map((f) => -f));
  const twr = periodReturn(index);
  const cashflows: [CalendarDate, number][] = [[first, -startValue]];
  for (let i = 1; i < ds.length; i++)
    cashflows.push([ds[i] as CalendarDate, -(flows[i] as number)]);
  const solved = xirr([...cashflows, [last, endValue]]);
  const dd = maxDrawdown(ds, index);
  const summary: RangeSummary = Object.freeze({
    startValue,
    endValue,
    netContributions: netFlows,
    deposits,
    withdrawals,
    impliedFunding: floatSum(implied.slice(1)),
    accountFees: floatSum(fees.slice(1)),
    contributionsGross: startValue + deposits,
    pnl: endValue - startValue - netFlows,
    twr,
    twrAnnualized: annualized(twr, span),
    xirr: solved === null ? null : xirrAnnual(solved),
    mwr: solved === null ? null : xirrPeriod(solved),
    maxDrawdown: dd,
    days: span,
    incompleteDays: complete.slice(1).filter((c) => !c).length,
    endComplete: complete[complete.length - 1] as boolean,
  });
  const metrics = {
    key,
    dates: ds,
    values,
    flows,
    complete,
    twr: index,
    drawdown: drawdownSeries(index),
    benchmarkIndex: null,
    benchmarkDrawdown: null,
    simulation: null,
    summary,
    benchmark: null,
  };
  if (benchPrices === null) return Object.freeze(metrics);
  const prices = benchPrices.slice(i0);
  const bindex = priceIndex(prices);
  const sim = simulate(ds, prices, startValue, flows, fees);
  const btwr = periodReturn(bindex);
  let firstPriced: CalendarDate | null = null;
  for (let i = 0; i < ds.length; i++) {
    if (prices[i] !== null) {
      firstPriced = ds[i] as CalendarDate;
      break;
    }
  }
  let lastPriced: CalendarDate | null = null;
  for (let i = ds.length - 1; i >= 0; i--) {
    if (prices[i] !== null) {
      lastPriced = ds[i] as CalendarDate;
      break;
    }
  }
  // a stale tail (the proxy's newest close older than the price age limit at the range end): the
  // benchmark stops at its last priced day while the portfolio runs to the end, so no excess figure
  // compares the two; the simulation's end figures are comparison figures too and are dropped as
  // well, while the benchmark's own TWR stays, annualized over the days it covers.
  const coversEnd = prices[prices.length - 1] !== null;
  const simEnd = coversEnd ? (sim.values[sim.values.length - 1] ?? null) : null;
  const simFeesEnd = coversEnd ? (sim.withFees[sim.withFees.length - 1] ?? null) : null;
  const simSolved = simEnd === null ? null : xirr([...cashflows, [last, simEnd]]);
  const benchmark: RangeBenchmark = Object.freeze({
    twr: btwr,
    twrAnnualized: annualized(
      btwr,
      firstPriced !== null && lastPriced !== null ? daysBetween(firstPriced, lastPriced) : 0,
    ),
    maxDrawdown: maxDrawdown(ds, bindex),
    firstPriced,
    coversRange: firstPriced !== null && firstPriced <= first,
    lastPriced,
    coversRangeEnd: coversEnd,
    simulationEndValue: simEnd,
    simulationEndValueWithFees: simFeesEnd,
    simulationPnl: simEnd === null ? null : simEnd - startValue - netFlows,
    simulationXirr: simSolved === null ? null : xirrAnnual(simSolved),
    simulationMwr: simSolved === null ? null : xirrPeriod(simSolved),
    simulationStarted: sim.started,
    simulationCapped: sim.capped,
    excessTwr: !coversEnd || twr === null || btwr === null ? null : twr - btwr,
    excessValue: !coversEnd || simEnd === null ? null : endValue - simEnd,
    excessVsSimulation: !coversEnd || !simEnd ? null : (endValue - simEnd) / simEnd,
  });
  return Object.freeze({
    ...metrics,
    benchmarkIndex: bindex,
    benchmarkDrawdown: drawdownSeries(bindex),
    simulation: sim,
    benchmark,
  });
}

function lastKnown(index: readonly (number | null)[], at: number, floor = 0): number | null {
  for (let i = at; i >= floor; i--) {
    const v = index[i];
    if (v !== null && v !== undefined) return v;
  }
  return null;
}

function isMonthEnd(day: CalendarDate): boolean {
  const { year, month, day: d } = parseDate(day);
  return d === daysInMonth(year, month);
}

/** `month_ends`: positions of the month ends inside `dates` plus the last day. */
export function monthEndPositions(dates: readonly CalendarDate[]): number[] {
  const out: number[] = [];
  dates.forEach((d, i) => {
    if (isMonthEnd(d)) out.push(i);
  });
  if (out.length === 0 || out[out.length - 1] !== dates.length - 1) out.push(dates.length - 1);
  return out;
}

export interface RollingPoint {
  readonly date: CalendarDate;
  readonly portfolio: number;
  readonly benchmark: number | null;
  readonly excess: number | null;
}

/** Rolling `months` windows ending at month ends on/after `fromDate`. */
export function rolling(
  dates: readonly CalendarDate[],
  combined: Combined,
  twrFull: readonly (number | null)[],
  benchFull: readonly (number | null)[] | null,
  months: number,
  fromDate: CalendarDate | null = null,
): RollingPoint[] {
  const out: RollingPoint[] = [];
  const first = dates[0] as CalendarDate;
  for (const i of monthEndPositions(dates)) {
    const endDay = dates[i] as CalendarDate;
    if (fromDate !== null && endDay < fromDate) continue;
    const startDay = monthsBack(endDay, months);
    if (startDay < first) continue;
    const j = daysBetween(first, startDay);
    if ((combined.values[j] as number) <= CAPITAL_EPSILON) continue; // nothing invested at the start
    const a = lastKnown(twrFull, j);
    const b = lastKnown(twrFull, i, j);
    if (a === null || b === null || a <= 0) continue;
    const portfolio = b / a - 1;
    let bench: number | null = null;
    const bAtEnd = benchFull === null ? null : (benchFull[i] ?? null);
    if (benchFull !== null && bAtEnd !== null) {
      // no excess over a stale tail
      const ba = lastKnown(benchFull, j);
      if (ba !== null && ba > 0) bench = bAtEnd / ba - 1;
    }
    out.push(
      Object.freeze({
        date: endDay,
        portfolio,
        benchmark: bench,
        excess: bench === null ? null : portfolio - bench,
      }),
    );
  }
  return out;
}

export interface RollingSummary {
  readonly windows: number;
  readonly latest: RollingPoint | null;
  readonly minExcess: number | null;
  readonly maxExcess: number | null;
  readonly shareOutperforming: number | null;
}

export function rollingSummary(points: readonly RollingPoint[]): RollingSummary {
  const excess = points.map((p) => p.excess).filter((e): e is number => e !== null);
  return Object.freeze({
    windows: points.length,
    latest: points[points.length - 1] ?? null,
    minExcess: excess.length > 0 ? pyMin(excess) : null,
    maxExcess: excess.length > 0 ? pyMax(excess) : null,
    shareOutperforming:
      excess.length > 0 ? excess.filter((e) => e > 0).length / excess.length : null,
  });
}

/** Python `min` of floats: the first smallest (no NaN here). */
function pyMin(values: readonly number[]): number {
  let best = values[0] as number;
  for (const v of values) if (v < best) best = v;
  return best;
}

function pyMax(values: readonly number[]): number {
  let best = values[0] as number;
  for (const v of values) if (v > best) best = v;
  return best;
}

export interface YearReturn {
  readonly year: number;
  readonly portfolio: number | null;
  readonly benchmark: number | null;
  /** The year is not whole inside the history (first or current year). */
  readonly partial: boolean;
}

const isoDay = (year: number, month: number, day: number): CalendarDate =>
  `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;

export function perYear(
  dates: readonly CalendarDate[],
  twrFull: readonly (number | null)[],
  benchFull: readonly (number | null)[] | null,
): YearReturn[] {
  const out: YearReturn[] = [];
  const first = dates[0] as CalendarDate;
  const last = dates[dates.length - 1] as CalendarDate;
  const fromYear = parseDate((dates.length > 1 ? dates[1] : dates[0]) as CalendarDate).year;
  for (let year = fromYear; year <= parseDate(last).year; year++) {
    const prevEnd = isoDay(year - 1, 12, 31);
    const yearEnd = isoDay(year, 12, 31);
    const baseDay = laterDate(prevEnd, first);
    const endDay = earlierDate(yearEnd, last);
    const j = daysBetween(first, baseDay);
    const i = daysBetween(first, endDay);
    const a = lastKnown(twrFull, j);
    const b = lastKnown(twrFull, i, j);
    const portfolio = a === null || b === null || a <= 0 ? null : b / a - 1;
    let bench: number | null = null;
    // a year whose end day has no usable benchmark close (a stale tail) compares nothing
    if (benchFull !== null && (benchFull[i] ?? null) !== null) {
      let ba: number | null = null;
      for (let k = j; k <= i; k++) {
        const v = benchFull[k] ?? null;
        if (v !== null) {
          ba = v;
          break;
        }
      }
      const bb = lastKnown(benchFull, i, j);
      if (ba !== null && bb !== null && ba > 0) bench = bb / ba - 1;
    }
    const partial = baseDay !== prevEnd || endDay !== yearEnd;
    out.push(Object.freeze({ year, portfolio, benchmark: bench, partial }));
  }
  return out;
}
