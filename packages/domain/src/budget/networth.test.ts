// Budget's net-worth contributor (networth.py: CashContributor). Translates the net-worth parts of
// tests/test_cash.py through core netWorth / netWorthSeries over a synthetic book.

import { describe, expect, it } from "vitest";
import {
  type BalanceSnapshot,
  builtinRegistry,
  type NetWorthAccount,
  type NetWorthBook,
  netWorth,
  netWorthSeries,
} from "../core/index.js";
import { D } from "../decimal.js";
import { CASH_ACCOUNT_TYPE, cashExpenseAmount, cashLegFields } from "./cash.js";
import { type CashPoolTxn, cashContributor } from "./networth.js";

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
