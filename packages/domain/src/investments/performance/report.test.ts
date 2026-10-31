/**
 * Test-for-test translation of `tests/investments/performance/test_perf_report.py`: range base days,
 * a portfolio that is exactly the benchmark (same TWR, zero excess), rolling windows, calendar years.
 * Synthetic data only. Each `it` names its Python test in a comment.
 *
 * Not here: `test_sample` (chart sampling is `performance/service.py:sample`, the service layer of
 * S19b, not part of the pure core).
 */
import { describe, expect, it } from "vitest";
import type { CalendarDate } from "../domain/values.js";
import {
  type Combined,
  computeRange,
  isRangeKey,
  perYear,
  type RangeBenchmark,
  type RangeKey,
  rangeBase,
  rolling,
  rollingSummary,
  type Simulation,
  twrIndex,
} from "./index.js";
import { day, days } from "./testing/support.js";

// --------------------------------------------------------------------------- //
// pytest.approx (rel 1e-6, abs 1e-12; abs alone when only abs is given)
// --------------------------------------------------------------------------- //

interface Tolerance {
  readonly rel?: number;
  readonly abs?: number;
}

function approxEq(actual: number | null | undefined, expected: number, tol: Tolerance): boolean {
  if (actual == null) return false;
  if (actual === expected) return true;
  const limit =
    tol.abs !== undefined && tol.rel === undefined
      ? tol.abs
      : Math.max((tol.rel ?? 1e-6) * Math.abs(expected), tol.abs ?? 1e-12);
  return Math.abs(actual - expected) <= limit;
}

function expectApprox(
  actual: number | null | undefined,
  expected: number,
  tol: Tolerance = {},
): void {
  expect(approxEq(actual, expected, tol), `${actual} ~ ${expected}`).toBe(true);
}

function expectApproxList(
  actual: readonly (number | null)[],
  expected: readonly (number | null)[],
): void {
  expect(actual.length).toBe(expected.length);
  actual.forEach((a, i) => {
    const e = expected[i] as number | null;
    if (e === null) expect(a).toBeNull();
    else expectApprox(a, e);
  });
}

/** Python float `==` (IEEE equality: `-0.0 == 0.0`, unlike `toBe`). */
function expectFloatEq(actual: number | null | undefined, expected: number): void {
  expect(actual === expected, `${actual} == ${expected}`).toBe(true);
}

function must<T>(value: T | null | undefined): T {
  expect(value).not.toBeNull();
  expect(value).toBeDefined();
  return value as T;
}

function combined(
  values: readonly number[],
  flows: readonly number[] | null = null,
  complete: readonly boolean[] | null = null,
): Combined {
  const n = values.length;
  return {
    values: [...values],
    flows: [...(flows ?? Array<number>(n).fill(0.0))],
    fees: Array<number>(n).fill(0.0),
    complete: [...(complete ?? Array<boolean>(n).fill(true))],
    implied: Array<number>(n).fill(0.0),
  };
}

function growth(start: string, end: string, daily: number, base: number): number[] {
  return days(start, end).map((_, i) => base * daily ** i);
}

describe("test_perf_report", () => {
  // test_range_base (parametrized)
  it.each([
    ["1m", "2026-03-31", "2026-02-28"],
    ["3m", "2026-03-31", "2025-12-31"],
    ["ytd", "2026-03-31", "2025-12-31"],
    ["1y", "2026-03-31", "2025-03-31"],
    ["3y", "2026-03-31", "2024-06-30"], // clamped to the series start
    ["max", "2026-03-31", "2024-06-30"],
  ] as const)("range base %s ending %s is %s", (key: RangeKey, end, expected) => {
    expect(rangeBase(key, day(end), day("2024-06-30"))).toBe(day(expected));
  });

  // test_one_year_back_from_a_leap_day
  it("one year back from a leap day", () => {
    expect(rangeBase("1y", day("2024-02-29"), day("2020-01-01"))).toBe(day("2023-02-28"));
  });

  // test_unknown_range
  it("unknown range", () => {
    // Adapted: Python's `range_base("5y", ...)` raises ValueError("unknown range"); the TS port types
    // the key as `RangeKey`, so an unknown key is rejected by the `isRangeKey` guard instead.
    expect(isRangeKey("5y")).toBe(false);
  });

  // test_portfolio_that_is_the_benchmark_has_zero_excess
  it("portfolio that is the benchmark has zero excess", () => {
    // 10 units at 100; 1100 deposited and invested at the 110 close; 121 at the end
    const ds = days("2025-01-01", "2025-01-04");
    const c = combined([1000.0, 1000.0, 2200.0, 2420.0], [0.0, 0.0, 1100.0, 0.0]);
    const m = computeRange("max", ds, c, [100.0, 100.0, 110.0, 121.0]);
    const s = m.summary;
    const b: RangeBenchmark = must(m.benchmark);
    expect(approxEq(s.twr, 0.21, {}) && approxEq(b.twr, 0.21, {})).toBe(true);
    expectApprox(b.excessTwr, 0.0, { abs: 1e-12 });
    const sim: Simulation = must(m.simulation);
    expectApproxList(sim.values, c.values);
    expect(approxEq(b.excessValue, 0.0, {}) && approxEq(b.excessVsSimulation, 0.0, {})).toBe(true);
    expect(approxEq(s.pnl, 320.0, {}) && approxEq(b.simulationPnl, 320.0, {})).toBe(true);
    expectApprox(s.mwr, must(b.simulationMwr));
    expect(s.xirr).toBeNull(); // four days are not annualized
    expect(b.coversRange && b.firstPriced === ds[0]).toBe(true);
  });

  // test_benchmark_beats_a_flat_portfolio
  it("benchmark beats a flat portfolio", () => {
    const ds = days("2025-01-01", "2025-01-03");
    const c = combined([1000.0, 1000.0, 1000.0]);
    const m = computeRange("max", ds, c, [null, 100.0, 120.0]);
    const b = must(m.benchmark);
    expectApprox(b.twr, 0.2);
    expect(b.coversRange).toBe(false);
    expectApprox(b.simulationEndValue, 1200.0); // invested at the first price
    expectApprox(b.excessValue, -200.0);
    expectFloatEq(b.maxDrawdown.depth, 0.0);
  });

  // test_rolling_windows_and_calendar_years
  it("rolling windows and calendar years", () => {
    const ds = days("2023-01-01", "2025-03-31");
    const c = combined(growth("2023-01-01", "2025-03-31", 1.0002, 1000.0));
    const bench = growth("2023-01-01", "2025-03-31", 1.0001, 100.0);
    const twr = twrIndex(c.values, c.flows, c.complete);
    const windows = rolling(ds, c, twr, bench, 12);
    const first = must(windows[0]);
    expect(first.date).toBe(day("2024-01-31")); // the first month end with a full year behind it
    expectApprox(first.portfolio, 1.0002 ** 365 - 1);
    expectApprox(first.benchmark, 1.0001 ** 365 - 1);
    expectApprox(first.excess, first.portfolio - must(first.benchmark));
    expect(windows[windows.length - 1]?.date).toBe(day("2025-03-31"));
    const summary = rollingSummary(windows);
    expect(summary.windows === windows.length && windows.length === 15).toBe(true);
    expectFloatEq(summary.shareOutperforming, 1.0);
    expect(rolling(ds, c, twr, bench, 24)[0]?.date).toBe(day("2025-01-31"));
    expect(rolling(ds, c, twr, bench, 36)).toEqual([]);
    const later = rolling(ds, c, twr, bench, 12, day("2025-01-01"));
    expect(later.map((w) => w.date)).toEqual([
      day("2025-01-31"),
      day("2025-02-28"),
      day("2025-03-31"),
    ]);

    const years = perYear(ds, twr, bench);
    expect(years.map((y) => [y.year, y.partial])).toEqual([
      [2023, true],
      [2024, false],
      [2025, true],
    ]);
    expectApprox(years[1]?.portfolio, 1.0002 ** 366 - 1); // 2024 is a leap year
    expectApprox(years[1]?.benchmark, 1.0001 ** 366 - 1);
  });

  // test_rolling_skips_windows_without_capital
  it("rolling skips windows without capital", () => {
    const ds = days("2024-01-01", "2025-02-28");
    const values = [...Array<number>(40).fill(0.0), ...Array<number>(ds.length - 40).fill(1000.0)];
    const flows = [
      ...Array<number>(40).fill(0.0),
      1000.0,
      ...Array<number>(ds.length - 41).fill(0.0),
    ];
    const c = combined(values, flows);
    const twr = twrIndex(c.values, c.flows, c.complete);
    const windows = rolling(ds, c, twr, null, 12);
    // 2024-02-09 is the first funded day: the window ending 2025-01-31 starts on an empty account
    expect(windows.map((w) => w.date)).toEqual([day("2025-02-28")] as CalendarDate[]);
    expect(windows[0]?.benchmark).toBeNull();
    expect(windows[0]?.excess).toBeNull();
  });
});
