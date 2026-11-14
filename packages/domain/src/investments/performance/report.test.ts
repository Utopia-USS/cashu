/** Range base days, a portfolio that is the benchmark (zero excess), rolling windows, calendar years. */
import { describe, expect, it } from "vitest";
import type { CalendarDate } from "../domain/values.js";
import {
  type Combined,
  computeRange,
  perYear,
  type RangeBenchmark,
  type RangeKey,
  rangeBase,
  rolling,
  rollingSummary,
  type Simulation,
  twrIndex,
} from "./index.js";
import {
  approxEq,
  day,
  days,
  expectApprox,
  expectApproxList,
  expectFloatEq,
} from "./testing/support.js";

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

describe("report", () => {
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

  it("one year back from a leap day", () => {
    expect(rangeBase("1y", day("2024-02-29"), day("2020-01-01"))).toBe(day("2023-02-28"));
  });

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
