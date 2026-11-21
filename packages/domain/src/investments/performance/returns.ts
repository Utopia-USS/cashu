/**
 * Return math on daily series (`performance/returns.py`): contributions-neutral TWR, money-weighted
 * XIRR, drawdowns, annualizing. Pure, floats (money stays `Decimal` until it reaches this module).
 *
 * Conventions (as in Python):
 *
 * - A daily series is aligned arrays: `values[i]` is the end-of-day value of day `i`, `flows[i]` the
 *   external flows booked on day `i` (+ = money put in), `complete[i]` whether the value is whole.
 * - TWR treats a day's flows as arriving at the end of that day: `r_i = (V_i - F_i) / V_prev - 1`.
 *   With no capital at the start of the day (`V_prev` <= half a cent) the day's return is 0.
 *   Incomplete days are linked over: from the last complete value `V_p` to the next one `V_q` the
 *   flows `F` of the stretch count from its start, `r = V_q / (V_p + F) - 1`.
 * - XIRR solves `sum(cf_i * (1 + d) ** -t_i) = 0` for a daily rate `d` by bisection on
 *   `x = ln(1 + d)`. Annual rate `(1 + d) ** 365 - 1`; the period return `(1 + d) ** span - 1`.
 *
 * Float note: `Math.exp` / `Math.expm1` / `**` are V8's fdlibm ports, CPython calls the platform
 * libm; both are faithfully rounded, so a result can differ in the last bit (parity tolerance).
 */

import { toOrdinal } from "../../dates.js";
import { roundFloat } from "../../decimal.js";
import type { CalendarDate } from "../domain/values.js";
import { pySum } from "./floats.js";

/** Capital (base currency units) below which a day earns nothing (half a cent). */
export const CAPITAL_EPSILON = 0.005;

/** Returns over shorter spans are not annualized (a week's gain to the power of 52 means nothing). */
export const MIN_ANNUALIZE_DAYS = 365;

/** The deepest fall of an index from a running peak. */
export interface Drawdown {
  /** Fraction <= 0 (-0.18 = an 18 % fall); 0 when the index never fell. */
  readonly depth: number;
  readonly peak: CalendarDate | null;
  readonly trough: CalendarDate | null;
  /** First date after the trough when the index was back at the peak, null while it is not. */
  readonly recovered: CalendarDate | null;
}

export function drawdown(
  depth: number,
  peak: CalendarDate | null = null,
  trough: CalendarDate | null = null,
  recovered: CalendarDate | null = null,
): Drawdown {
  return Object.freeze({ depth, peak, trough, recovered });
}

/** `Drawdown.to_dict`: the depth rounded to 6 places, dates as ISO text. */
export function drawdownToDict(dd: Drawdown): {
  readonly depth: number;
  readonly peak: CalendarDate | null;
  readonly trough: CalendarDate | null;
  readonly recovered: CalendarDate | null;
} {
  return {
    depth: roundFloat(dd.depth, 6),
    peak: dd.peak,
    trough: dd.trough,
    recovered: dd.recovered,
  };
}

/**
 * Growth of 1 from the first point (index 1.0 there), linked daily. Incomplete points are null. The
 * first point is the base: its value is the starting capital and its own flows are ignored.
 */
export function twrIndex(
  values: readonly number[],
  flows: readonly number[],
  complete: readonly boolean[],
): (number | null)[] {
  if (values.length !== flows.length || values.length !== complete.length) {
    throw new RangeError("twrIndex: arrays of different length");
  }
  const out: (number | null)[] = [];
  let index = 1.0;
  let prev: number | null = null;
  let prevAt = 0;
  let pending = 0.0;
  for (let i = 0; i < values.length; i++) {
    const value = values[i] as number;
    const flow = flows[i] as number;
    const whole = complete[i] as boolean;
    if (i === 0) {
      out.push(whole ? 1.0 : null);
      prev = whole ? value : null;
      continue;
    }
    pending += flow;
    if (!whole) {
      out.push(null);
      continue;
    }
    if (prev === null) {
      // No complete point yet: this one becomes the base.
      prev = value;
      prevAt = i;
      pending = 0.0;
      out.push(index);
      continue;
    }
    if (i - prevAt === 1) {
      // One day: the flows came at its end.
      if (prev > CAPITAL_EPSILON && value - pending >= 0) index *= (value - pending) / prev;
    } else {
      // Over unvalued days the flows count from the start of the stretch.
      const capital = prev + pending;
      if (capital > CAPITAL_EPSILON) index *= value / capital;
    }
    prev = value;
    prevAt = i;
    pending = 0.0;
    out.push(index);
  }
  return out;
}

/**
 * `index[end] / index[start] - 1` using the nearest complete points (start: first on/after, end:
 * last on/before); null without both.
 */
export function periodReturn(
  index: readonly (number | null)[],
  start = 0,
  end: number | null = null,
): number | null {
  const last = end ?? index.length - 1;
  let first: number | null = null;
  for (let i = start; i <= last; i++) {
    const v = index[i];
    if (v !== null && v !== undefined) {
      first = v;
      break;
    }
  }
  let final: number | null = null;
  for (let i = last; i >= start; i--) {
    const v = index[i];
    if (v !== null && v !== undefined) {
      final = v;
      break;
    }
  }
  if (first === null || final === null || first <= 0) return null;
  return final / first - 1;
}

/** `(1 + ret) ** (365 / days) - 1`; null for spans shorter than a year or a total loss. */
export function annualized(ret: number | null, days: number): number | null {
  if (ret === null || days < MIN_ANNUALIZE_DAYS || ret <= -1) return null;
  return (1 + ret) ** (365 / days) - 1;
}

/** A solved money-weighted return. */
export interface Xirr {
  /** `ln(1 + d)` of the daily rate. */
  readonly logDaily: number;
  readonly spanDays: number;
}

/** `Xirr.annual`: annual rate; null for spans shorter than a year (or an absurd value). */
export function xirrAnnual(x: Xirr): number | null {
  if (x.spanDays < MIN_ANNUALIZE_DAYS) return null;
  const exponent = 365 * x.logDaily;
  return exponent > 50 ? null : Math.expm1(exponent);
}

/** `Xirr.period`: money-weighted return over the whole span, not annualized. */
export function xirrPeriod(x: Xirr): number {
  return Math.expm1(x.logDaily * x.spanDays);
}

const solved = (logDaily: number, spanDays: number): Xirr => Object.freeze({ logDaily, spanDays });

/**
 * Money-weighted return of investor cash flows (negative = money put in, the final value as a
 * positive flow on the last day). Null without flows of both signs or without a sign change of the
 * net present value inside the searched range.
 */
export function xirr(cashflows: readonly (readonly [CalendarDate, number])[]): Xirr | null {
  const flows = cashflows.filter(([, a]) => a !== 0);
  if (flows.length === 0 || !flows.some(([, a]) => a > 0) || !flows.some(([, a]) => a < 0)) {
    return null;
  }
  const ordinals = flows.map(([d]) => toOrdinal(d));
  const t0 = Math.min(...ordinals);
  const span = Math.max(...ordinals) - t0;
  const times = flows.map(([, a], i) => [(ordinals[i] as number) - t0, a] as const);
  if (span === 0) return null;
  const bound = Math.min(1.0, 50.0 / span);

  const npv = (x: number): number => pySum(times.map(([t, a]) => a * Math.exp(-x * t)));

  let lo = -bound;
  let hi = bound;
  let fLo = npv(lo);
  const fHi = npv(hi);
  if (fLo === 0) return solved(lo, span);
  if (fHi === 0) return solved(hi, span);
  if (fLo > 0 === fHi > 0) return null;
  for (let k = 0; k < 200; k++) {
    const mid = (lo + hi) / 2;
    const fMid = npv(mid);
    if (fMid === 0 || hi - lo < 1e-15) return solved(mid, span);
    if (fMid > 0 === fLo > 0) {
      lo = mid;
      fLo = fMid;
    } else {
      hi = mid;
    }
  }
  return solved((lo + hi) / 2, span);
}

/** Deepest peak-to-trough fall of `index` (null points skipped) with its dates and recovery. */
export function maxDrawdown(
  dates: readonly CalendarDate[],
  index: readonly (number | null)[],
): Drawdown {
  if (dates.length !== index.length)
    throw new RangeError("maxDrawdown: arrays of different length");
  let peakValue: number | null = null;
  let peakDate: CalendarDate | null = null;
  let best = drawdown(0.0);
  let bestPeakValue: number | null = null;
  for (let i = 0; i < dates.length; i++) {
    const value = index[i] as number | null;
    if (value === null) continue;
    const day = dates[i] as CalendarDate;
    if (peakValue === null || value > peakValue) {
      peakValue = value;
      peakDate = day;
      continue;
    }
    const depth = peakValue > 0 ? value / peakValue - 1 : 0.0;
    if (depth < best.depth) {
      best = drawdown(depth, peakDate, day);
      bestPeakValue = peakValue;
    }
  }
  if (best.trough === null || bestPeakValue === null) return best;
  for (let i = 0; i < dates.length; i++) {
    const day = dates[i] as CalendarDate;
    const value = index[i] as number | null;
    if (day > best.trough && value !== null && value >= bestPeakValue) {
      return drawdown(best.depth, best.peak, best.trough, day);
    }
  }
  return best;
}

/** Per point: the fall from the running peak (0 at a new high, null where the index is null). */
export function drawdownSeries(index: readonly (number | null)[]): (number | null)[] {
  const out: (number | null)[] = [];
  let peak: number | null = null;
  for (const value of index) {
    if (value === null) {
      out.push(null);
      continue;
    }
    if (peak === null || value > peak) peak = value;
    out.push(peak > 0 ? value / peak - 1 : 0.0);
  }
  return out;
}
