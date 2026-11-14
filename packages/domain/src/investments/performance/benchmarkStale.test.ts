/**
 * A benchmark proxy whose closes end before the range end: the simulation waits for the next priced
 * day, and rolling windows and calendar years ending on a stale benchmark tail compare nothing.
 */
import { describe, expect, it } from "vitest";
import { type Combined, perYear, rolling, simulate, twrIndex } from "./index.js";
import { approxEq, days, expectApprox, expectApproxList } from "./testing/support.js";

describe("stale benchmark tail", () => {
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
