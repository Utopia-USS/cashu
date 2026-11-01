// The month's contribution-plan progress (Python `month_plan`): base currency, FX from the device's
// price cache (trade-date rate for deposits, planned date or today for plans), a missing rate, no
// strategy, the month bounds and the Python dict rendering. Synthetic data only; clock 2026-10-31.
import { D, parseDateTime } from "@cashu/domain";
import { market, toCurrency } from "@cashu/domain/investments";
import { loadStrategy } from "@cashu/domain/investments/strategy";
import { describe, expect, it } from "vitest";
import { addManualTransaction } from "../commands/manual.js";
import { createPlannedDeposit } from "../commands/planned.js";
import { brokerage, type Vault, vault } from "../commands/testing/fixtures.js";
import { type MonthPlanRequest, monthPlan, monthPlanRecord } from "./planned.js";

const yaml = (extra: string) => `version: 1
base_currency: PLN
buckets:
  - id: stocks
    match: { asset_class: [equity, etf] }
allocation:
  targets: { stocks: 1.0 }
${extra}`;

function config(extra = "contributions:\n  monthly_amount: 1500\n  day_of_month: 10\n") {
  const c = loadStrategy(yaml(extra)).config;
  if (c === null) expect.fail("the test strategy must load");
  return c;
}

function eurRates(rows: [string, string][]): market.PriceCache {
  const cache = new market.InMemoryPriceCache();
  cache.upsertRates(
    "nbp",
    toCurrency("EUR"),
    rows.map(([date, rate]) => ({ date, rate: D(rate), fetchedAt: null })),
    parseDateTime("2026-10-31 12:00:00"),
  );
  return cache;
}

function planOf(v: Vault, request: Partial<MonthPlanRequest> = {}) {
  const out = monthPlan(v.store.read.bind(v.store), {
    month: "2026-11",
    today: "2026-10-31",
    strategy: config(),
    prices: new market.InMemoryPriceCache(),
    ...request,
  });
  if (!out.ok) expect.fail(out.reason);
  return out.value;
}

const deposit = (
  v: Vault,
  account: string,
  tradeDate: string,
  cashAmount: string,
  currency = "PLN",
) => v.value(addManualTransaction, { account, type: "deposit", tradeDate, cashAmount, currency });

describe("monthPlan", () => {
  it("converts deposits at their trade date and plans at the planned date or today", () => {
    const v = vault();
    const account = brokerage(v);
    deposit(v, account, "2026-10-05", "100", "EUR");
    deposit(v, account, "2026-10-20", "430");
    v.value(createPlannedDeposit, { amount: "10", plannedDate: "2026-10-25", currency: "EUR" });
    v.value(createPlannedDeposit, { amount: "20", plannedDate: "2026-11-15", currency: "EUR" });
    const prices = eurRates([
      ["2026-10-02", "4.20"], // the newest before the 5th (a weekend start)
      ["2026-10-23", "4.30"],
      ["2026-10-30", "4.40"],
    ]);
    const october = planOf(v, { month: "2026-10", prices });
    expect(october.currency).toBe("PLN");
    expect(october.deposited?.toString()).toBe("850.00"); // 100 * 4.20 + 430
    expect(october.planned?.toString()).toBe("43.00"); // 10 * 4.30 at the planned date
    expect(monthPlanRecord(october)).toMatchObject({ remaining: "607.00", covered: false });
    const november = planOf(v, { prices });
    expect(november.planned?.toString()).toBe("88.00"); // 20 * 4.40: the newest known by today
    expect(november.plannedCount).toBe(1);
  });

  it("gives null amounts when a rate is missing", () => {
    const v = vault();
    const account = brokerage(v);
    deposit(v, account, "2026-11-02", "100", "USD");
    const out = planOf(v);
    expect([out.deposited, out.remaining, out.covered]).toEqual([null, null, null]);
    expect(out.planned?.toString()).toBe("0");
  });

  it("covers the plan when deposits reach the monthly amount (remaining never below 0)", () => {
    const v = vault();
    const account = brokerage(v);
    deposit(v, account, "2026-11-02", "1600");
    const out = planOf(v);
    expect([out.remaining?.toString(), out.covered]).toEqual(["0", true]);
    expect(monthPlanRecord(out).remaining).toBe("0.00");
  });

  it("has no monthly amount without a strategy and uses the profile's base currency", () => {
    const v = vault();
    const out = planOf(v, { strategy: null, month: null });
    expect(out).toMatchObject({
      month: "2026-10",
      currency: "PLN",
      monthlyAmount: null,
      dayOfMonth: null,
      remaining: null,
      covered: null,
      plannedCount: 0,
    });
    const noPlan = planOf(v, { strategy: config("") });
    expect([noPlan.monthlyAmount, noPlan.dayOfMonth]).toEqual([null, null]);
  });

  it("refuses a month that is not YYYY-MM", () => {
    const v = vault();
    const read = v.store.read.bind(v.store);
    for (const month of ["2026", "2026-13", "2026-0", "1899-12", "2026-03-01", "x-1"]) {
      const out = monthPlan(read, {
        month,
        today: "2026-10-31",
        strategy: null,
        prices: new market.InMemoryPriceCache(),
      });
      expect(out.ok, month).toBe(false);
    }
    const loose = planOf(v, { month: " 2026-2 " });
    expect(loose.month).toBe("2026-02");
  });

  it("renders amounts rounded half even to 2 places", () => {
    const v = vault();
    const account = brokerage(v);
    deposit(v, account, "2026-11-02", "0.125");
    expect(monthPlanRecord(planOf(v)).deposited).toBe("0.12");
  });
});
