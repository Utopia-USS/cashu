/** Benchmark prices in the base currency and the same-cash-flow simulation, hand-computed. */
import { describe, expect, it } from "vitest";
import { InMemoryFxLookup } from "../portfolio/index.js";
import { benchmarkPrices, priceIndex, simulate } from "./index.js";
import {
  bars,
  days,
  EUR,
  expectApprox,
  expectApproxList,
  expectFloatEq,
  PLN,
  rates,
} from "./testing/support.js";

describe("benchmark", () => {
  it("proxy prices converted and aged", () => {
    const ds = days("2025-01-02", "2025-01-12");
    const fx = new InMemoryFxLookup(rates(EUR, { "2025-01-02": "4.0", "2025-01-03": "4.1" }));
    const proxy = bars("P", { "2025-01-02": "50", "2025-01-03": "51" });
    const out = benchmarkPrices(ds, proxy, EUR, fx, PLN, { maxPriceAgeDays: 5, maxFxAgeDays: 7 });
    expectApprox(out[0], 200.0); // 50 * 4.0
    expectApprox(out[1], 209.1); // 51 * 4.1
    expectApprox(out[6], 209.1); // 01-08: the 01-03 close is 5 days old, still usable
    expect(out[7]).toBeNull(); // 01-09: 6 days old
    // the FX rate ages too: a fresh close with an 8-day-old rate is unusable
    const late = benchmarkPrices(
      days("2025-01-11", "2025-01-11"),
      bars("P", { "2025-01-11": "52" }),
      EUR,
      fx,
      PLN,
      { maxPriceAgeDays: 5, maxFxAgeDays: 7 },
    );
    expect(late).toEqual([null]);
  });

  it("price index starts at the first known price", () => {
    expect(priceIndex([null, 200.0, 220.0, null, 250.0])).toEqual([null, 1.0, 1.1, null, 1.25]);
  });

  it("same-cash-flow simulation", () => {
    // start value 1000 at price 100 = 10 units; flat; 1100 deposited at 110 = 10 more units; then 121
    const ds = days("2025-01-01", "2025-01-04");
    const sim = simulate(ds, [100.0, 100.0, 110.0, 121.0], 1000.0, [0.0, 0.0, 1100.0, 0.0]);
    expectApproxList(sim.values, [1000.0, 1000.0, 2200.0, 2420.0]);
    expect(sim.started === ds[0] && !sim.capped).toBe(true);
  });

  it("simulation with fees sells units", () => {
    const ds = days("2025-01-01", "2025-01-03");
    const sim = simulate(ds, [100.0, 100.0, 200.0], 1000.0, [0.0, 0.0, 0.0], [0.0, 10.0, 0.0]);
    expectApproxList(sim.values, [1000.0, 1000.0, 2000.0]);
    expectApproxList(sim.withFees, [1000.0, 990.0, 1980.0]); // 9.9 units at 200
  });

  it("simulation waits for the first price and caps withdrawals", () => {
    const ds = days("2025-01-01", "2025-01-05");
    const sim = simulate(ds, [null, null, 50.0, 50.0, 100.0], 0.0, [0.0, 500.0, 0.0, -1000.0, 0.0]);
    // the 01-02 deposit waits for 01-03 (10 units); the 1000 withdrawal empties them
    expect(sim.values.length).toBe(5);
    expect(sim.values[0]).toBeNull();
    expect(sim.values[1]).toBeNull();
    expectApprox(sim.values[2], 500.0);
    expectFloatEq(sim.values[3], 0.0);
    expectFloatEq(sim.values[4], 0.0);
    expect(sim.started === ds[2] && sim.capped).toBe(true);
  });
});
