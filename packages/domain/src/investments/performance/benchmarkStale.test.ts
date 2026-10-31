/**
 * Test-for-test translation of the pure tests of
 * `tests/investments/performance/test_fxb_benchmark_stale.py` (F6 review V2: a benchmark proxy whose
 * closes end before the range end): the simulation waits for the next priced day, and rolling windows
 * and calendar years ending on a stale benchmark tail compare nothing. Synthetic data only. Each `it`
 * names its Python test in a comment.
 *
 * Not here (DB / HTTP bound, service layer of S19b): `test_stale_benchmark_tail_is_flagged_and_drops_the_excess`
 * (API + MCP over an imported household and the price backfill) and
 * `test_worker_post_run_backfill_refreshes_the_benchmark_proxy` (worker run writing price bars).
 */
import { describe, expect, it } from "vitest";
import { type Combined, perYear, rolling, simulate, twrIndex } from "./index.js";
import { days } from "./testing/support.js";

// --------------------------------------------------------------------------- //
// pytest.approx (rel 1e-6, abs 1e-12)
// --------------------------------------------------------------------------- //

function approxEq(actual: number | null | undefined, expected: number): boolean {
  if (actual == null) return false;
  if (actual === expected) return true;
  return Math.abs(actual - expected) <= Math.max(1e-6 * Math.abs(expected), 1e-12);
}

function expectApprox(actual: number | null | undefined, expected: number): void {
  expect(approxEq(actual, expected), `${actual} ~ ${expected}`).toBe(true);
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

describe("test_fxb_benchmark_stale (pure)", () => {
  // test_simulation_waits_for_the_next_priced_day_and_holds_the_cash_meanwhile
  it("simulation waits for the next priced day and holds the cash meanwhile", () => {
    const ds = days("2025-01-01", "2025-01-05");
    // 10 units at 100; the 500 deposit on 01-03 has no price until 01-05 (110)
    const sim = simulate(
      ds,
      [100.0, 100.0, null, null, 110.0],
      1000.0,
      [0.0, 0.0, 500.0, 0.0, 0.0],
    );
    expectApproxList(sim.values, [1000.0, 1000.0, 1500.0, 1500.0, 1600.0]);
    expectApproxList(sim.withFees, [1000.0, 1000.0, 1500.0, 1500.0, 1600.0]);
  });

  // test_rolling_windows_ending_on_a_stale_benchmark_tail_compare_nothing
  it("rolling windows ending on a stale benchmark tail compare nothing", () => {
    const ds = days("2024-01-01", "2025-03-31");
    const n = ds.length;
    const c: Combined = {
      values: Array<number>(n).fill(1000.0),
      flows: Array<number>(n).fill(0.0),
      fees: Array<number>(n).fill(0.0),
      complete: Array<boolean>(n).fill(true),
      implied: Array<number>(n).fill(0.0),
    };
    const twr = twrIndex(c.values, c.flows, c.complete);
    const staleFrom = ds.indexOf("2025-03-10");
    const bench = [
      ...Array<number>(staleFrom).fill(100.0),
      ...Array<null>(n - staleFrom).fill(null),
    ];
    const windows = rolling(ds, c, twr, bench, 12);
    const beforeLast = windows[windows.length - 2];
    const last = windows[windows.length - 1];
    expect(beforeLast?.date === "2025-02-28" && approxEq(beforeLast.excess, 0.0)).toBe(true);
    expect(last?.date).toBe("2025-03-31");
    expect(last?.benchmark).toBeNull();
    expect(last?.excess).toBeNull();
  });

  // test_a_year_ending_on_a_stale_benchmark_tail_has_no_benchmark_return
  it("a year ending on a stale benchmark tail has no benchmark return", () => {
    const ds = days("2024-01-01", "2025-03-31");
    const n = ds.length;
    const twr = Array<number>(n).fill(1.0);
    const staleFrom = ds.indexOf("2025-03-10");
    const bench = [
      ...Array<number>(staleFrom).fill(100.0),
      ...Array<null>(n - staleFrom).fill(null),
    ];
    const years = perYear(ds, twr, bench);
    const first = years[0];
    const last = years[years.length - 1];
    expect(first?.year === 2024 && approxEq(first.benchmark, 0.0)).toBe(true);
    expect(last?.year).toBe(2025);
    expect(last?.benchmark).toBeNull();
    expectApprox(last?.portfolio, 0.0);
  });
});
