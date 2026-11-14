// Budget's net-worth contributor (networth.py: CashContributor). Translates the net-worth parts of
// tests/test_cash.py through core netWorth / netWorthSeries over a synthetic book.

import { describe, expect, it } from "vitest";
import {
  type BalanceSnapshot,
  builtinRegistry,
  completePoints,
  convertedHero,
  convertedSeriesView,
  heroFacts,
  type NetWorthAccount,
  type NetWorthBook,
  netWorth,
  netWorthBreakdown,
  netWorthChange,
  netWorthSeries,
  netWorthSummary,
  type RateAt,
} from "../core/index.js";
import { D } from "../decimal.js";
import { CASH_ACCOUNT_TYPE, cashExpenseAmount, cashLegFields } from "./cash.js";
import {
  type CashPoolTxn,
  cashContributor,
  cashPoolPartId,
  cashPoolPartOf,
  netWorthLineMeta,
} from "./networth.js";

const types = builtinRegistry().accountTypes;
const BANK: NetWorthAccount = {
  id: "bank",
  type: "checking",
  currency: "PLN",
  active: true,
  removedAt: null,
};
const POOL: NetWorthAccount = {
  id: "pool",
  type: CASH_ACCOUNT_TYPE,
  currency: "PLN",
  active: true,
  removedAt: null,
};

function book(
  balances: BalanceSnapshot[],
  pool: CashPoolTxn[],
  today = "2024-01-10",
): NetWorthBook {
  return {
    accounts: pool.length > 0 ? [BANK, POOL] : [BANK],
    balances: new Map([["bank", balances]]),
    contributors: [cashContributor(pool)],
    types,
    today,
  };
}

const csv = (date: string, amount: string): BalanceSnapshot => ({
  date,
  amount: D(amount),
  source: "csv",
});
const withdrawal = {
  bookingDate: "2024-01-05",
  valueDate: null,
  amount: D("-200.00"),
  currency: "PLN",
  description: null,
  reference: "WYPLATA W BANKOMACIE",
};
const leg: CashPoolTxn = {
  account: "pool",
  bookingDate: "2024-01-05",
  amount: cashLegFields(withdrawal, null).amount,
};

function expense(amount: string, bookingDate: string): CashPoolTxn {
  const r = cashExpenseAmount(D(amount));
  if (!r.ok) throw new Error("test expense must be non-zero");
  return { account: "pool", bookingDate, amount: r.amount };
}

describe("cash pool in net worth (tests/test_cash.py)", () => {
  // test_marking_withdrawal_feeds_pool_and_is_networth_neutral
  it("a marked withdrawal moves money from the bank to the pool: net worth unchanged", () => {
    const before = netWorth(book([csv("2024-01-04", "1200.00")], []));
    const after = netWorth(
      book([csv("2024-01-04", "1200.00"), csv("2024-01-05", "1000.00")], [leg]),
    );
    expect(before.totals.get("PLN")?.toString()).toBe("1200.00");
    expect(after.totals.get("PLN")?.toString()).toBe("1200.00");
    expect(after.lines.find((l) => l.account.id === "pool")?.amount?.toString()).toBe("200.00");
  });

  // test_cash_expense_draws_pool_and_counts_as_spend (the spend half is S10's)
  it("a cash expense draws the pool down: 200 in, 50 out = 150.00", () => {
    const v = cashContributor([leg, expense("50", "2024-01-05")]).valuations(
      new Map([["pool", POOL]]),
    );
    expect(v.get("pool")?.latest(null, "2024-01-10")?.[1].toString()).toBe("150.00");
  });

  // test_cash_account_appears_in_networth_series
  it("the pool is part of the net-worth series: 1000 bank + 150 cash", () => {
    const series = netWorthSeries(
      book([csv("2024-01-10", "1000.00")], [leg, expense("50", "2024-01-08")]),
      "PLN",
      "daily",
    );
    expect(series.length).toBeGreaterThan(0);
    expect(series.at(-1)?.[1].toString()).toBe("1150.00");
  });
});

describe("cashContributor", () => {
  it("values only cash accounts, an empty pool too; same-day rows keep input order", () => {
    const accounts = new Map([
      ["bank", BANK],
      ["pool", POOL],
      ["pool2", { ...POOL, id: "pool2" }],
    ]);
    const v = cashContributor([
      { account: "pool", bookingDate: "2024-01-06", amount: D("-1.5") },
      { account: "bank", bookingDate: "2024-01-01", amount: D("9") },
      { account: "pool", bookingDate: "2024-01-05", amount: D("10") },
      { account: "pool", bookingDate: "2024-01-06", amount: D("2") },
    ]).valuations(accounts);
    expect([...v.keys()]).toEqual(["pool", "pool2"]);
    expect(v.get("pool")?.axisDates()).toEqual(["2024-01-05", "2024-01-06"]);
    expect(v.get("pool")?.at("2024-01-06")?.toString()).toBe("10.50");
    expect(v.get("pool")?.at("2024-01-04")).toBeNull();
    expect(v.get("pool2")?.axisDates()).toEqual([]);
  });
});

describe("a cash pool's rows in another currency (data-safety rule 5)", () => {
  // The phone test's scenario (companion-queries.test.ts "overview inputs"): bank 1000.00 PLN, a PLN
  // pool with -12.00 PLN and two EUR rows of a foreign or malformed event. Hand-computed: PLN
  // 1000.00 - 12.00 = 988.00; EUR -3.00 - 5.00 = -8.00. Adding them gives the wrong 980.00 PLN.
  const rows: CashPoolTxn[] = [
    { account: "pool", bookingDate: "2024-01-05", amount: D("-12.00"), currency: "PLN" },
    { account: "pool", bookingDate: "2024-01-03", amount: D("-3.00"), currency: "EUR" },
    { account: "pool", bookingDate: "2024-01-08", amount: D("-5.00"), currency: "EUR" },
  ];
  const mixed = (pool: NetWorthAccount = POOL): NetWorthBook => ({
    accounts: [BANK, pool],
    balances: new Map([["bank", [csv("2024-01-04", "1000.00")]]]),
    contributors: [cashContributor(rows)],
    types,
    today: "2024-01-10",
  });

  it("counts them in their own currency as a part of the pool, never in the pool's", () => {
    const nw = netWorth(mixed());
    expect([...nw.totals].map(([c, v]) => [c, v.toString()])).toEqual([
      ["PLN", "988.00"],
      ["EUR", "-8.00"],
    ]);
    expect(nw.lines.map((l) => [l.account.id, l.account.currency, l.amount?.toString()])).toEqual([
      ["bank", "PLN", "1000.00"],
      ["pool", "PLN", "-12.00"],
      [cashPoolPartId("pool", "EUR"), "EUR", "-8.00"],
    ]);
    expect(netWorthBreakdown(mixed(), "EUR").net.toString()).toBe("-8.00");
    expect(netWorthBreakdown(mixed(), "PLN").net.toString()).toBe("988.00");
  });

  it("keeps each currency's history apart", () => {
    const eur = netWorthSeries(mixed(), "EUR", "daily").map(([d, v]) => [d, v.toString()]);
    expect(eur).toContainEqual(["2024-01-03", "-3.00"]);
    expect(eur.at(-1)).toEqual(["2024-01-08", "-8.00"]);
    const pln = netWorthSeries(mixed(), "PLN", "daily").map(([d, v]) => [d, v.toString()]);
    // the EUR days are no PLN points: the PLN line only moves on PLN data
    expect(pln).toEqual([
      ["2024-01-04", "1000.00"],
      ["2024-01-05", "988.00"],
    ]);
  });

  it("drops the part with its pool when the pool is removed", () => {
    const nw = netWorth(mixed({ ...POOL, removedAt: "2024-01-09T00:00:00Z" }));
    expect([...nw.totals].map(([c, v]) => [c, v.toString()])).toEqual([["PLN", "1000.00"]]);
  });

  it("values a pool whose rows name its own currency exactly like rows without one", () => {
    const own = rows.filter((t) => t.currency === "PLN");
    const bare = own.map(({ account, bookingDate, amount }) => ({ account, bookingDate, amount }));
    const total = (pool: CashPoolTxn[]) =>
      netWorth({ ...mixed(), contributors: [cashContributor(pool)] }).totals;
    expect([...total(own)].map(([c, v]) => [c, v.toString()])).toEqual([["PLN", "988.00"]]);
    expect([...total(bare)].map(([c, v]) => [c, v.toString()])).toEqual([["PLN", "988.00"]]);
  });
});

describe("a cash pool's part in another currency, converted at NBP rates", () => {
  // Bank 1000.00 PLN, a PLN pool with -12.00 PLN and EUR rows -3.00, -5.00 (January) and -2.00
  // (February). A fixed synthetic EUR rate of 4.30 PLN. Hand-computed, PLN headline:
  //   January (last data 01-08):  988.00 + (-8.00 x 4.30 = -34.40)  = 953.60
  //   February (last data 02-10): 988.00 + (-10.00 x 4.30 = -43.00) = 945.00, change -8.60
  // Without the part the converted view is the PLN line alone (988.00 both months, change 0.00).
  const rows: CashPoolTxn[] = [
    { account: "pool", bookingDate: "2024-01-05", amount: D("-12.00"), currency: "PLN" },
    { account: "pool", bookingDate: "2024-01-03", amount: D("-3.00"), currency: "EUR" },
    { account: "pool", bookingDate: "2024-01-08", amount: D("-5.00"), currency: "EUR" },
    { account: "pool", bookingDate: "2024-02-10", amount: D("-2.00"), currency: "EUR" },
  ];
  const twoCurrencies: NetWorthBook = {
    accounts: [BANK, POOL],
    balances: new Map([["bank", [csv("2024-01-04", "1000.00")]]]),
    contributors: [cashContributor(rows)],
    types,
    today: "2024-02-20",
  };
  const rateAt: RateAt = (currency, on) =>
    currency === "EUR" && on >= "2024-01-02" ? { rate: D("4.30"), date: "2024-01-02" } : null;
  const request = { currency: "PLN", granularity: "monthly", scope: "total" } as const;

  it("converts the part into the series and the hero's change", () => {
    const view = convertedSeriesView(twoCurrencies, request, "pl", rateAt);
    expect(view.convertedFrom).toEqual(["EUR"]);
    expect(completePoints(view).map((p) => [p.date, p.value.toString()])).toEqual([
      ["2024-01-08", "953.60"],
      ["2024-02-10", "945.00"],
    ]);
    const change = netWorthChange(completePoints(view));
    expect(change?.change.toString()).toBe("-8.60");
  });

  it("converts the part into the hero's figures", () => {
    const summary = netWorthSummary(twoCurrencies, "PLN");
    const hero = convertedHero(twoCurrencies, summary, heroFacts(summary), rateAt, "2024-02-20");
    expect(hero?.parts.map((p) => [p.currency, p.amount.toString()])).toEqual([["EUR", "-10.00"]]);
    expect(hero?.net.toString()).toBe("945.00");
    expect(hero?.liquid.toString()).toBe("945.00");
  });
});

describe("netWorthLineMeta", () => {
  const meta = new Map([
    ["pool", { name: "Cash", bank: "manual" }],
    ["bank", { name: "Main", bank: "mbank" }],
  ]);
  const of = (id: string) => netWorthLineMeta(id, (gid) => meta.get(gid));

  it("names a pool's part after its pool plus the currency code", () => {
    expect(cashPoolPartOf(cashPoolPartId("pool", "EUR"))).toEqual({
      pool: "pool",
      currency: "EUR",
    });
    expect(of(cashPoolPartId("pool", "EUR"))).toEqual({ name: "Cash (EUR)", bank: "manual" });
  });

  it("keeps every stored account's own metadata and knows no other id", () => {
    expect(of("bank")).toEqual({ name: "Main", bank: "mbank" });
    expect(of("pool")).toEqual({ name: "Cash", bank: "manual" });
    expect(of("missing")).toBeUndefined();
    expect(of(cashPoolPartId("missing", "EUR"))).toBeUndefined();
    expect(cashPoolPartOf("pool")).toBeNull();
    expect(cashPoolPartOf("pool#")).toBeNull();
    expect(cashPoolPartOf("#EUR")).toBeNull();
  });
});
