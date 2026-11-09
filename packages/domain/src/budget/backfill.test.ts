// Bank accounts in the net-worth history after an Open Banking import: one balance (the day of the
// import) next to ~90 days of transactions. The history walks back from that balance over the
// transactions, and the series says from when every account is known. Synthetic data only.

import { describe, expect, it } from "vitest";
import {
  type BalanceSnapshot,
  builtinRegistry,
  completePoints,
  type NetWorthAccount,
  type NetWorthBook,
  netWorth,
  netWorthSeriesCompleteFrom,
  seriesView,
} from "../core/index.js";
import { D } from "../decimal.js";
import {
  BackfilledBalanceValuation,
  bankBalanceContributor,
  budgetContributor,
  type CashPoolTxn,
  openBankingWindowStarts,
} from "./networth.js";

const types = builtinRegistry().accountTypes;
const account = (id: string, type = "checking"): NetWorthAccount => ({
  id,
  type,
  currency: "PLN",
  active: true,
  removedAt: null,
});
const snap = (date: string, amount: string, source = "open_banking"): BalanceSnapshot => ({
  date,
  amount: D(amount),
  source,
});
const txn = (acc: string, bookingDate: string, amount: string): CashPoolTxn => ({
  account: acc,
  bookingDate,
  amount: D(amount),
});

// The Open Banking account: 10 000 today (11-09), salary and spending since 08-11.
const OB_TXNS = [
  txn("ob", "2026-08-11", "-200.00"),
  txn("ob", "2026-09-10", "8000.00"),
  txn("ob", "2026-09-15", "-3000.00"),
  txn("ob", "2026-10-10", "8000.00"),
  txn("ob", "2026-10-20", "-4000.00"),
  txn("ob", "2026-11-05", "-500.00"),
];

describe("BackfilledBalanceValuation", () => {
  const v = new BackfilledBalanceValuation([snap("2026-11-09", "10000.00")], OB_TXNS);

  it("walks the end-of-day balance back from the first snapshot over the transactions", () => {
    expect(v.at("2026-11-09")?.toString()).toBe("10000.00");
    expect(v.at("2026-11-05")?.toString()).toBe("10000.00");
    expect(v.at("2026-11-04")?.toString()).toBe("10500.00");
    expect(v.at("2026-10-20")?.toString()).toBe("10500.00");
    expect(v.at("2026-10-19")?.toString()).toBe("14500.00");
    expect(v.at("2026-09-10")?.toString()).toBe("9500.00");
    expect(v.at("2026-08-11")?.toString()).toBe("1500.00");
  });

  it("before the first transaction the balance is unknown (the import window, not an empty account)", () => {
    expect(v.at("2026-08-10")).toBeNull();
    expect(v.knownFrom()).toBe("2026-08-11");
    expect(v.axisDates()).toEqual([
      "2026-08-11",
      "2026-09-10",
      "2026-09-15",
      "2026-10-10",
      "2026-10-20",
      "2026-11-05",
      "2026-11-09",
    ]);
  });

  it("an account that started empty is known (zero) before its first transaction", () => {
    const fresh = new BackfilledBalanceValuation(
      [snap("2026-11-09", "7500.00")],
      [txn("ob", "2026-10-01", "5000.00"), txn("ob", "2026-11-01", "2500.00")],
    );
    expect(fresh.at("2026-09-01")?.toString()).toBe("0.00");
    expect(fresh.knownFrom()).toBeNull();
  });

  it("net worth now is the snapshot's value, untouched by the walk back", () => {
    expect(v.latest(null, "2026-11-09")).toEqual(["2026-11-09", D("10000.00")]);
  });

  it("transactions after the first snapshot do not move the earlier days", () => {
    const later = new BackfilledBalanceValuation(
      [snap("2026-11-01", "1000.00"), snap("2026-11-09", "900.00")],
      [
        txn("ob", "2026-10-10", "-20.00"),
        txn("ob", "2026-10-15", "-50.00"),
        txn("ob", "2026-11-05", "-100.00"),
      ],
    );
    expect(later.at("2026-10-14")?.toString()).toBe("1050.00");
    expect(later.at("2026-10-15")?.toString()).toBe("1000.00");
    expect(later.at("2026-11-06")?.toString()).toBe("1000.00"); // the step of the snapshots
  });
});

describe("bankBalanceContributor", () => {
  it("values bank accounts with a balance, leaves the rest to core and other modules", () => {
    const accounts = new Map([
      ["ob", account("ob")],
      ["card", account("card", "credit")],
      ["nobalance", account("nobalance")],
      ["broker", account("broker", "brokerage")],
    ]);
    const balances = new Map([
      ["ob", [snap("2026-11-09", "10000.00")]],
      ["card", [snap("2026-11-09", "-300.00")]],
      ["broker", [snap("2026-11-09", "1.00")]],
    ]);
    const v = bankBalanceContributor(OB_TXNS, balances).valuations(accounts);
    expect([...v.keys()]).toEqual(["ob", "card"]);
  });
});

describe("the series after a first Open Banking import", () => {
  // An old savings account with balances since January next to the newly connected account.
  const book = (withTxns: boolean): NetWorthBook => {
    const balances = new Map([
      ["old", [snap("2026-01-31", "20000.00", "csv"), snap("2026-11-09", "20000.00", "csv")]],
      ["ob", [snap("2026-11-09", "10000.00")]],
    ]);
    return {
      accounts: [account("old", "savings"), account("ob")],
      balances,
      contributors: [budgetContributor(withTxns ? OB_TXNS : [], balances)],
      types,
      today: "2026-11-09",
    };
  };

  it("without the walk back the new account exists only today: the history is not whole", () => {
    const view = seriesView(
      book(false),
      { currency: "PLN", granularity: "monthly", scope: "total" },
      "pl",
    );
    // January holds only the old account: 20 000 -> 30 000 would read as +50 %.
    expect(view.points.map((p) => [p.date, p.value.toString()])).toEqual([
      ["2026-01-31", "20000.00"],
      ["2026-11-09", "30000.00"],
    ]);
    expect(view.completeFrom).toBe("2026-11-09");
    expect(completePoints(view).map((p) => p.date)).toEqual(["2026-11-09"]);
  });

  it("with the walk back the history is whole from the first imported day", () => {
    const b = book(true);
    expect(netWorthSeriesCompleteFrom(b, "PLN")).toBe("2026-08-11");
    const view = seriesView(b, { currency: "PLN", granularity: "monthly", scope: "total" }, "pl");
    expect(view.completeFrom).toBe("2026-08-11");
    expect(completePoints(view).map((p) => [p.date, p.value.toString()])).toEqual([
      ["2026-08-11", "21500.00"],
      ["2026-09-15", "26500.00"],
      ["2026-10-20", "30500.00"],
      ["2026-11-09", "30000.00"],
    ]);
    expect(netWorth(b).totals.get("PLN")?.toString()).toBe("30000.00");
  });
});

describe("a quiet account of the same Open Banking fetch", () => {
  // Savings fetched with the checking account on 11-09: its first transaction is 10-04, but the fetch
  // asked from 08-11 (the checking account's first row), so it held its opening balance since then.
  const quiet = new BackfilledBalanceValuation(
    [snap("2026-11-09", "30000.00")],
    [txn("sav", "2026-10-04", "5000.00")],
    "2026-08-11",
  );

  it("holds the opening balance back to the window start, unknown before it", () => {
    expect(quiet.at("2026-10-04")?.toString()).toBe("30000.00");
    expect(quiet.at("2026-10-03")?.toString()).toBe("25000.00");
    expect(quiet.at("2026-08-11")?.toString()).toBe("25000.00");
    expect(quiet.at("2026-08-10")).toBeNull();
    expect(quiet.knownFrom()).toBe("2026-08-11");
    expect(quiet.axisDates()[0]).toBe("2026-08-11");
  });

  it("a window start after the first transaction changes nothing", () => {
    const v = new BackfilledBalanceValuation(
      [snap("2026-11-09", "10000.00")],
      OB_TXNS,
      "2026-09-01",
    );
    expect(v.knownFrom()).toBe("2026-08-11");
  });

  it("the window is the earliest row of the bank's accounts fetched the same day", () => {
    const starts = openBankingWindowStarts([
      { account: "chk", bank: "millennium", day: "2026-11-09", first: "2026-08-11" },
      { account: "sav", bank: "millennium", day: "2026-11-09", first: "2026-10-04" },
      { account: "chk", bank: "millennium", day: "2026-11-10", first: "2026-11-10" },
      // Connected later in its own fetch: its own group.
      { account: "new", bank: "millennium", day: "2026-11-20", first: "2026-11-15" },
      { account: "mb", bank: "mbank", day: "2026-11-09", first: null },
    ]);
    expect([...starts]).toEqual([
      ["chk", "2026-08-11"],
      ["sav", "2026-08-11"],
      ["new", "2026-11-15"],
    ]);
  });
});
