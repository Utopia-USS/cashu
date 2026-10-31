/**
 * Test-for-test translation of `tests/investments/performance/test_perf_returns.py`: return math with
 * hand-computed results (TWR with deposits / withdrawals / incomplete days, XIRR, drawdowns,
 * annualizing). Synthetic data only. Each `it` names its Python test in a comment.
 */
import { describe, expect, it } from "vitest";
import { addDays } from "../../dates.js";
import type { CalendarDate } from "../domain/values.js";
import {
  annualized,
  drawdownSeries,
  maxDrawdown,
  periodReturn,
  twrIndex,
  xirr,
  xirrAnnual,
  xirrPeriod,
} from "./index.js";

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
  tol: Tolerance = {},
): void {
  expect(actual.length).toBe(expected.length);
  actual.forEach((a, i) => {
    const e = expected[i] as number | null;
    if (e === null) expect(a).toBeNull();
    else expectApprox(a, e, tol);
  });
}

/** Python float `==` (IEEE equality: `-0.0 == 0.0`, unlike `toBe`). */
function expectFloatEq(actual: number | null | undefined, expected: number): void {
  expect(actual === expected, `${actual} == ${expected}`).toBe(true);
}

const D0: CalendarDate = "2025-01-01";

function dates(n: number): CalendarDate[] {
  return Array.from({ length: n }, (_, i) => addDays(D0, i));
}

describe("test_perf_returns", () => {
  // test_twr_ignores_deposits
  it("TWR ignores deposits", () => {
    // 1000 in (no capital before: 0 %), +10 %, then +10 % again and 500 more at the end of that day:
    // (1710 - 500) / 1100 = 1.1
    const index = twrIndex(
      [0, 1000, 1100, 1710, 1710],
      [0, 1000, 0, 500, 0],
      Array<boolean>(5).fill(true),
    );
    expectApproxList(index, [1.0, 1.0, 1.1, 1.21, 1.21]);
    expectApprox(periodReturn(index), 0.21);
  });

  // test_twr_withdrawal_and_empty_account
  it("TWR withdrawal and empty account", () => {
    // 600 out at the start of a flat day: no return; everything out, later 500 in, +10 %
    const index = twrIndex(
      [1000, 1200, 600, 0, 0, 500, 550],
      [0, 0, -600, -600, 0, 500, 0],
      Array<boolean>(7).fill(true),
    );
    expectApproxList(index, [1.0, 1.2, 1.2, 1.2, 1.2, 1.2, 1.32]);
  });

  // test_twr_links_over_incomplete_days
  it("TWR links over incomplete days", () => {
    // the flow of the unvalued day carries to the next valued one: 1650 / (1100 + 500)
    const index = twrIndex([1000, 1100, 999, 1650], [0, 0, 500, 0], [true, true, false, true]);
    expect(index[2]).toBeNull();
    expectApprox(index[3], (1.1 * 1650) / 1600);
  });

  // test_twr_first_complete_point_is_the_base
  it("TWR first complete point is the base", () => {
    const index = twrIndex([5, 1000, 1100], [0, 0, 0], [false, true, true]);
    expect(index.length).toBe(3);
    expect(index[0]).toBeNull();
    expectFloatEq(index[1], 1.0);
    expectApprox(index[2], 1.1);
  });

  // test_xirr_one_year
  it("XIRR one year", () => {
    const solved = xirr([
      [D0, -1000.0],
      [addDays(D0, 365), 1100.0],
    ]);
    expect(solved).not.toBeNull();
    if (solved === null) return;
    expectApprox(xirrAnnual(solved), 0.1, { abs: 1e-9 });
    expectApprox(xirrPeriod(solved), 0.1, { abs: 1e-9 });
  });

  // test_xirr_two_deposits
  it("XIRR two deposits", () => {
    // 1000 on day 0, 1000 on day 182, 2200 back on day 365. By hand (r = 13.47 %):
    // 1000 * 1.1347 + 1000 * 1.1347 ** (183 / 365) = 1134.7 + 1065.3 = 2200.0
    const solved = xirr([
      [D0, -1000.0],
      [addDays(D0, 182), -1000.0],
      [addDays(D0, 365), 2200.0],
    ]);
    expect(solved).not.toBeNull();
    if (solved === null) return;
    const r = xirrAnnual(solved);
    expectApprox(r, 0.1347, { abs: 2e-4 });
    const rr = r as number;
    const npv = -1000 - 1000 / (1 + rr) ** (182 / 365) + 2200 / (1 + rr);
    expectApprox(npv, 0, { abs: 1e-6 });
  });

  // test_xirr_short_span_is_not_annualized
  it("XIRR short span is not annualized", () => {
    const solved = xirr([
      [D0, -1000.0],
      [addDays(D0, 30), 1050.0],
    ]);
    expect(solved).not.toBeNull();
    if (solved === null) return;
    expect(xirrAnnual(solved)).toBeNull();
    expectApprox(xirrPeriod(solved), 0.05, { abs: 1e-9 });
  });

  // test_xirr_needs_both_signs
  it("XIRR needs both signs", () => {
    expect(
      xirr([
        [D0, -1000.0],
        [addDays(D0, 30), -5.0],
      ]),
    ).toBeNull();
    expect(xirr([])).toBeNull();
  });

  // test_max_drawdown_with_recovery
  it("max drawdown with recovery", () => {
    const ds = dates(5);
    const dd = maxDrawdown(ds, [1.0, 1.2, 0.9, 1.0, 1.25]);
    expectApprox(dd.depth, -0.25);
    expect([dd.peak, dd.trough, dd.recovered]).toEqual([ds[1], ds[2], ds[4]]);
    const series = drawdownSeries([1.0, 1.2, 0.9, null, 1.25]);
    expectApproxList(series.slice(0, 3), [0.0, 0.0, -0.25]);
    expect(series[3]).toBeNull();
    expectFloatEq(series[4], 0.0);
  });

  // test_max_drawdown_not_recovered_and_flat
  it("max drawdown not recovered and flat", () => {
    const ds = dates(4);
    const dd = maxDrawdown(ds, [1.0, null, 0.8, 0.9]);
    expectApprox(dd.depth, -0.2);
    expect(dd.recovered).toBeNull();
    expectFloatEq(maxDrawdown(ds, [1.0, 1.0, 1.1, 1.2]).depth, 0.0);
  });

  // test_annualized
  it("annualized", () => {
    expectApprox(annualized(0.21, 730), 0.1);
    expect(annualized(0.1, 100)).toBeNull();
    expect(annualized(null, 800)).toBeNull();
  });
});
