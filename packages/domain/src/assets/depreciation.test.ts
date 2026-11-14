// Translation of tests/test_depreciation.py (declining-balance value + net-worth integration) over an
// in-memory profile (`testing/netWorthProfile.ts`). TODAY is fixed (Python reads date.today()).

import { describe, expect, it } from "vitest";
import { netWorth, netWorthSeries } from "../core/networth.js";
import { D, decimalKey } from "../decimal.js";
import { SyntheticProfile } from "../testing/netWorthProfile.js";
import { DepreciationRateError, depreciatedValue } from "./depreciation.js";

const TODAY = "2026-10-01";
const key = (d: { toString(): string } | null | undefined) =>
  d == null ? d : decimalKey(D(d.toString()));

describe("test_depreciation.py", () => {
  it("test_value_declining_balance_and_floor", () => {
    const buy = "2025-06-16";
    // Day of purchase: full price.
    expect(key(depreciatedValue(D("62500"), buy, D("15"), buy))).toBe("62500");
    expect(depreciatedValue(D("62500"), buy, D("15"), buy).toString()).toBe("62500.0");
    // Before purchase: not owned yet.
    expect(depreciatedValue(D("62500"), buy, D("15"), "2025-01-01").toString()).toBe("0.00");
    // ~1 year later at 15%/yr ~ price * 0.85.
    const v1 = depreciatedValue(D("62500"), buy, D("15"), "2026-06-16");
    expect(v1.gt(D("53000")) && v1.lt(D("53200"))).toBe(true); // 62500*0.85 = 53125
    // Floor is respected far in the future.
    const vFar = depreciatedValue(D("62500"), buy, D("15"), "2045-06-16", D("8000"));
    expect(key(vFar)).toBe("8000");
  });

  it("test_vehicle_counts_as_illiquid_asset", () => {
    // A bank account with a balance, plus the car.
    const p = new SyntheticProfile(TODAY);
    const acc = p.getOrCreateAccount({
      bank: "mbank",
      name: "mBank",
      iban: "PL10114000000000000001234",
    });
    p.setBalance(acc.id, "2026-01-01", "10000.00", "csv");
    const car = p.setVehicle("Hyundai i30", "62500", "2025-06-16", "15", "8000");
    expect(car.type).toBe("vehicle");

    // Total net worth includes the depreciated car value.
    const { totals, lines } = netWorth(p.book());
    const carLine = lines.find((ln) => ln.account.id === car.id);
    const c = carLine?.contribution;
    expect(c?.gt(D("40000"))).toBe(true); // ~50k now
    expect(key(totals.get("PLN"))).toBe(key(D("10000.00").add(c ?? D("0"))));

    // Liquid scope excludes the car; total includes it.
    const liquid = netWorthSeries(p.book(), "PLN", "daily", "liquid");
    const total = netWorthSeries(p.book(), "PLN", "daily", "total");
    expect(liquid.length > 0 && total.length > 0).toBe(true);
    const lastTotal = total.at(-1)?.[1];
    const lastLiquid = liquid.at(-1)?.[1];
    expect(lastTotal != null && lastLiquid != null && lastTotal.gt(lastLiquid)).toBe(true);
    expect(key(lastLiquid)).toBe("10000");
  });

  it("test_series_declines_over_time", () => {
    const p = new SyntheticProfile(TODAY);
    const acc = p.getOrCreateAccount({
      bank: "mbank",
      name: "mBank",
      iban: "PL10114000000000000001234",
    });
    // two balance points so the series spans purchase -> now
    p.setBalance(acc.id, "2025-01-01", "10000.00", "csv");
    p.setBalance(acc.id, "2027-01-01", "10000.00", "csv");
    p.setVehicle("Car", "62500", "2025-06-16", "15", null);

    const vals = new Map(netWorthSeries(p.book(), "PLN", "daily", "total"));
    // Before purchase: only the 10k bank balance (car not owned).
    expect(key(vals.get("2025-01-01"))).toBe("10000");
    // After purchase: bank + car, and the car value declines toward later dates.
    const later = vals.get("2027-01-01");
    expect(later?.gt(D("10000.00"))).toBe(true);
    expect(later?.lt(D("10000.00").add(D("62500.00")))).toBe(true);
  });
});

describe("depreciatedValue edges (Python float semantics)", () => {
  it("rounds like round(v, 2) and keeps str(float)'s digits", () => {
    // 72000 * 0.86 ** (11 / 365.25): the demo vehicle eleven days after purchase.
    expect(depreciatedValue(D("72000"), "2024-10-20", D("14"), "2024-10-31").toString()).toBe(
      "71673.7",
    );
  });

  it("a 100 % rate is worth nothing after the purchase day; above 100 % Python fails", () => {
    expect(depreciatedValue(D("1000"), "2025-01-01", D("100"), "2025-01-02").toString()).toBe(
      "0.0",
    );
    expect(depreciatedValue(D("1000"), "2025-01-01", D("100"), "2025-01-01").toString()).toBe(
      "1000.0",
    );
    expect(() => depreciatedValue(D("1000"), "2025-01-01", D("150"), "2025-01-02")).toThrow(
      DepreciationRateError,
    );
  });

  it("the floor only lifts a lower value", () => {
    expect(
      depreciatedValue(D("1000"), "2025-01-01", D("10"), "2025-01-01", D("5000")).toString(),
    ).toBe("5000.0");
    expect(
      depreciatedValue(D("1000"), "2025-01-01", D("10"), "2025-01-01", D("10")).toString(),
    ).toBe("1000.0");
  });
});
