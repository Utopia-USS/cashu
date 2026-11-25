/** Synthetic series and regimes for the macro tests (no real data). */

import { addDays, type IsoDate, weekday } from "../../../dates.js";
import { type MacroClose, type Metric, metric } from "../regimes.js";

/** `n` weekdays from `start`. */
export function weekdaysFrom(start: IsoDate, n: number): IsoDate[] {
  const out: IsoDate[] = [];
  let day = start;
  while (out.length < n) {
    if (weekday(day) < 5) out.push(day);
    day = addDays(day, 1);
  }
  return out;
}

/** Every weekday in `start..end`. */
export function sessionsBetween(start: IsoDate, end: IsoDate): IsoDate[] {
  const out: IsoDate[] = [];
  for (let day = start; day <= end; day = addDays(day, 1)) if (weekday(day) < 5) out.push(day);
  return out;
}

/** Closes on the given dates (default: weekdays from 2024-01-01). */
export function seriesOf(values: readonly number[], dates?: readonly IsoDate[]): MacroClose[] {
  const days = dates ?? weekdaysFrom("2024-01-01", values.length);
  if (days.length !== values.length) throw new RangeError("dates and values differ in length");
  return values.map((v, i) => [days[i] as IsoDate, v] as const);
}

/** `p0, p0 * growth, ...` by repeated multiplication (as the Python helper). */
export function geometric(n: number, growth: number, p0 = 100.0): number[] {
  const out: number[] = [];
  let value = p0;
  for (let i = 0; i < n; i++) {
    out.push(value);
    value *= growth;
  }
  return out;
}

/** `[value] * n`. */
export function repeat(value: number, n: number): number[] {
  return Array.from({ length: n }, () => value);
}

/** `start + step * i` for `n` sessions. */
export function linear(n: number, start: number, step: number): number[] {
  return Array.from({ length: n }, (_, i) => start + step * i);
}

/** A metric tuple of the text tests: `[label, value, unit]`. */
export type MetricRow = readonly [string, number, Metric["unit"]];

export function metricsOf(rows: readonly MetricRow[]): Metric[] {
  return rows.map(([label, value, unit]) => metric(label, value, unit));
}
