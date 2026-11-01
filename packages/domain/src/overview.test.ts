// The overview read models (core/overview.ts + budget/analytics/overview.ts) on the seeded household,
// test-for-test: tests/test_api.py test_summary, test_networth (the breakdown half),
// test_networth_series_daily, test_networth_series_monthly, test_networth_series_liquid_and_other_currency,
// test_empty_db_reads (the summary and series halves); tests/test_profiles.py
// test_a_eur_profile_sees_its_own_net_worth (summary and series halves). Python's floats (`f()`) are the
// API layer's; here the Decimals are compared. Plus the hero facts the SPA computed (NetHero).

import { describe, expect, it } from "vitest";
import { Household } from "./budget/analytics/testing/household.js";
import { assets, budget, core, D, type Decimal, loans } from "./index.js";
import { seedHousehold } from "./testing/seedHousehold.js";

const TODAY = "2026-10-01";
const s = (d: Decimal | null) => (d === null ? null : d.toString());
const REGISTRY = core.builtinRegistry();
const NOT_SUBSCRIPTION = budget.subscriptionExclusions(REGISTRY);

/** Mortgage outstanding and car value as of today, from the library itself (`_today_values`). */
function todayValues(today: string): { mortgage: Decimal; car: Decimal } {
  const loan = loans.summarize(D("400000"), D("6.0"), 300, "2025-01-05", today, "2024-12-10");
  const car = assets.curveValue(
    {
      accountId: "car",
      purchasePrice: D("80000"),
      purchaseDate: "2025-05-01",
      annualRate: D("15"),
      floor: D("10000"),
    },
    today,
  );
  return { mortgage: loan.outstanding, car };
}

/** The summary as `GET /summary` composes it (core half + budget half). */
function summary(seed = seedHousehold(), today = TODAY) {
  const book = seed.netWorthBook(today);
  const core_ = core.netWorthSummary(book, "PLN");
  const cashflow = budget.monthlyCashflow(seed.budgetBook);
  const active = budget.activeRecurring(
    budget.recurringPayments(seed.budgetBook, seed.household.engineContext(), NOT_SUBSCRIPTION),
    seed.budgetBook,
  );
  return {
    core: core_,
    month: budget.monthSummary(cashflow),
    subscriptions: budget.subscriptionsSummary(active),
  };
}

describe("summary (test_api.py)", () => {
  it("test_summary", () => {
    const body = summary();
    const { mortgage, car } = todayValues(TODAY);
    const pln = D("5000").add(D("24000")).add(D("600000")).add(D("260")).add(car).sub(mortgage);
    expect(Object.keys(body.core.networth)).toEqual(["EUR", "PLN"]);
    expect(s(body.core.networth.EUR as Decimal)).toBe("460.04");
    expect((body.core.networth.PLN as Decimal).sub(pln).abs().lte(D("0.01"))).toBe(true);
    const m = body.month;
    expect(m && [m.label, s(m.income), s(m.expense), s(m.net)]).toEqual([
      "2026-09",
      "9000.00",
      "4275.75",
      "4724.25",
    ]);
    // Netflix + sports club (PLN) and Spotify (EUR); totals per currency (B2 fix).
    const subs = body.subscriptions;
    expect(subs.count).toBe(3);
    expect(s(subs.monthlyTotal)).toBe("182.00");
    expect(Object.entries(subs.monthlyTotals).map(([k, v]) => [k, s(v)])).toEqual([
      ["EUR", "9.99"],
      ["PLN", "182.00"],
    ]);
  });

  it("test_networth (the breakdown half)", () => {
    const bd = summary().core.breakdown;
    const { mortgage, car } = todayValues(TODAY);
    expect(bd.currency).toBe("PLN");
    expect(s(bd.propertyValue)).toBe("600000.00");
    expect(bd.mortgage.sub(mortgage).abs().lte(D("0.01"))).toBe(true);
    expect(bd.homeEquity.eq(D("600000").sub(bd.mortgage))).toBe(true);
    const assetsSum = D("5000").add(D("24000")).add(D("600000")).add(D("260")).add(car);
    expect(bd.assets.sub(assetsSum).abs().lte(D("0.01"))).toBe(true);
    expect(new Set(bd.byType.keys())).toEqual(
      new Set(["checking", "savings", "property", "mortgage", "vehicle", "cash"]),
    );
    expect(s(bd.byType.get("checking") ?? null)).toBe("5000.00"); // PLN only
  });

  it("test_empty_db_reads (summary and series halves)", () => {
    const empty = new Household("PLN");
    const book = empty.netWorthBook(TODAY);
    const body = core.netWorthSummary(book, null);
    expect(body.networth).toEqual({});
    expect(body.breakdown.currency).toBe("PLN");
    expect(budget.monthSummary(budget.monthlyCashflow(empty.book()))).toBeNull();
    const subs = budget.subscriptionsSummary([]);
    expect([subs.count, s(subs.monthlyTotal), subs.monthlyTotals]).toEqual([0, "0", {}]);
    const req = core.seriesRequest({ baseCurrency: null });
    expect(core.seriesView(book, req, "pl")).toEqual({
      currency: "PLN",
      points: [],
      components: [],
    });
  });
});

/** A series point with its Decimals as text. */
const pointText = (p: core.SeriesPoint) => ({
  date: p.date,
  value: s(p.value),
  components: Object.fromEntries(Object.entries(p.components).map(([k, v]) => [k, s(v)])),
});

describe("net-worth series view (test_api.py)", () => {
  const book = seedHousehold().netWorthBook(TODAY);
  const view = (params: { currency?: string; granularity?: string; scope?: string }) =>
    core.seriesView(book, core.seriesRequest({ ...params, baseCurrency: "PLN" }), "pl");

  it("test_networth_series_daily", () => {
    const body = view({});
    expect(body.points.map((p) => p.date)).toEqual([
      "2026-06-01",
      "2026-09-15",
      "2026-09-16",
      "2026-09-30",
    ]);
    expect(body.components.map((c) => c.key)).toEqual(["money", "property", "vehicle", "mortgage"]);
    expect(body.components[3]).toEqual({ key: "mortgage", label: "Hipoteka", liability: true });
    for (const p of body.points) {
      let sum = D("0");
      for (const v of Object.values(p.components)) sum = sum.add(v);
      expect(p.value.eq(sum)).toBe(true);
    }
  });

  it("test_networth_series_monthly", () => {
    expect(view({ granularity: "monthly" }).points.map(pointText)).toEqual([
      {
        date: "2026-06-01",
        value: "277291.01",
        components: { property: "600000.00", vehicle: "67075.94", mortgage: "-389784.93" },
      },
      {
        date: "2026-09-30",
        value: "305567.25",
        components: {
          money: "29260.00",
          property: "600000.00",
          vehicle: "63560.12",
          mortgage: "-387252.87",
        },
      },
    ]);
  });

  it("test_networth_series_liquid_and_other_currency", () => {
    const liquid = view({ granularity: "monthly", scope: "liquid" });
    expect(liquid.currency).toBe("PLN"); // additive (R-04): the series names its currency
    expect(liquid.points.map(pointText)).toEqual([
      { date: "2026-09-30", value: "29260.00", components: { money: "29260.00" } },
    ]);
    expect(liquid.components).toEqual([{ key: "money", label: "Pieniądze", liability: false }]);
    const eur = view({ currency: "EUR" });
    expect(eur.points.map(pointText)).toEqual([
      { date: "2026-09-30", value: "460.04", components: { money: "460.04" } },
    ]);
  });

  it("labels follow the request's language", () => {
    expect(view({}).components.map((c) => c.label)).toEqual([
      "Pieniądze",
      "Nieruchomości",
      "Auto",
      "Hipoteka",
    ]);
    const en = core.seriesView(book, core.seriesRequest({ baseCurrency: "PLN" }), "en");
    expect(en.components.map((c) => c.label)).toEqual(["Money", "Property", "Car", "Mortgage"]);
  });

  it("an unknown granularity keeps every point, an unknown scope counts every account", () => {
    expect(core.seriesRequest({ granularity: "yearly", scope: "x", baseCurrency: "" })).toEqual({
      currency: "PLN",
      granularity: "daily",
      scope: "total",
    });
    expect(view({ granularity: "yearly" })).toEqual(view({}));
  });
});

describe("a EUR profile (test_profiles.py test_a_eur_profile_sees_its_own_net_worth)", () => {
  const h = new Household("EUR");
  const eur = h.account({ name: "EUR", iban: "99114000000000000000000071", currency: "EUR" });
  const pln = h.account({ name: "PLN", iban: "99114000000000000000000072" });
  h.balance(eur, "2026-09-30", "1200.00");
  h.balance(pln, "2026-09-30", "300.00");
  const book = h.netWorthBook(TODAY);

  it("the headline is in the base currency, every currency keeps its own total", () => {
    const body = core.netWorthSummary(book, "EUR");
    expect(body.breakdown.currency).toBe("EUR");
    expect(s(body.breakdown.net)).toBe("1200.00");
    expect(Object.entries(body.networth).map(([k, v]) => [k, s(v)])).toEqual([
      ["EUR", "1200.00"],
      ["PLN", "300.00"],
    ]);
  });

  it("the series defaults to the base currency and names it", () => {
    const series = core.seriesView(book, core.seriesRequest({ baseCurrency: "EUR" }), "pl");
    expect(series.currency).toBe("EUR");
    expect(s(series.points.at(-1)?.value ?? null)).toBe("1200.00");
    const explicit = core.seriesView(
      book,
      core.seriesRequest({ currency: "PLN", baseCurrency: "EUR" }),
      "pl",
    );
    expect(explicit.currency).toBe("PLN");
    expect(s(explicit.points.at(-1)?.value ?? null)).toBe("300.00");
  });
});

describe("hero facts (frontend NetHero)", () => {
  it("liquid money is checking, savings and cash in the headline currency", () => {
    const seed = seedHousehold();
    const hero = core.heroFacts(core.netWorthSummary(seed.netWorthBook(TODAY), "PLN"));
    const { mortgage } = todayValues(TODAY);
    expect(hero.currency).toBe("PLN");
    expect(s(hero.liquid)).toBe("29260.00"); // 5000 + 24000 + 260 cash; the EUR account is not mixed in
    expect(hero.liabilityTypes).toEqual(["mortgage"]);
    expect(hero.homeEquity?.eq(D("600000").sub(mortgage))).toBe(true);
    expect(hero.accounts).toBe(7); // six accounts and the cash pool
    expect(Object.entries(hero.otherCurrencies).map(([k, v]) => [k, s(v)])).toEqual([
      ["EUR", "460.04"],
    ]);
  });

  it("no home equity without property or mortgage; credit cards are not liquid money", () => {
    const h = new Household("PLN");
    const card = h.account({ name: "Karta", iban: "99114000000000000000000081", type: "credit" });
    const main = h.account({ name: "Konto", iban: "99114000000000000000000082" });
    h.balance(card, "2026-09-30", "-120.00");
    h.balance(main, "2026-09-30", "1000.00");
    const hero = core.heroFacts(core.netWorthSummary(h.netWorthBook(TODAY), "PLN"));
    expect(hero.homeEquity).toBeNull();
    expect(s(hero.liquid)).toBe("1000.00");
    expect(hero.liabilityTypes).toEqual(["credit"]);
    expect(s(hero.liabilities)).toBe("120.00");
  });

  it("months of spending divide the liquid money by the norm of complete months (FE10)", () => {
    const seed = seedHousehold();
    const norm = budget.closedMonthNorm(budget.monthlyCashflow(seed.budgetBook), TODAY);
    // June to September are complete on 1 October: (4523.75 + 4527.75 + 4586.75 + 4275.75) / 4
    expect(norm && [norm.months, s(norm.expense), s(norm.income)]).toEqual([
      4,
      "4478.50",
      "9000.00",
    ]);
    const months = core.monthsOfSpending(D("29260.00"), norm?.expense ?? null);
    expect(months?.quantize(D("0.1")).toString()).toBe("6.5");
    expect(core.monthsOfSpending(D("100"), null)).toBeNull();
    expect(core.monthsOfSpending(D("100"), D("0"))).toBeNull();
  });

  it("the change since last month comes from the last two monthly points", () => {
    const book = seedHousehold().netWorthBook(TODAY);
    const monthly = core.seriesView(
      book,
      core.seriesRequest({ granularity: "monthly", baseCurrency: "PLN" }),
      "pl",
    );
    const change = core.netWorthChange(monthly.points);
    expect(change && [s(change.change), change.since]).toEqual(["28276.24", "2026-06-01"]);
    expect(change?.changePct?.eq(D("28276.24").div(D("277291.01")))).toBe(true);
    expect(core.netWorthChange(monthly.points.slice(-1))).toBeNull();
    const zero = [
      { date: "2026-08-31", value: D("0"), components: {} },
      { date: "2026-09-30", value: D("5"), components: {} },
    ];
    expect(core.netWorthChange(zero)?.changePct).toBeNull();
  });
});
