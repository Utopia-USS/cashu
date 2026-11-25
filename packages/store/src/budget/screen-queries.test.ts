// Money-screen budget queries over real in-memory vaults. Inputs are invented; no screen DTO or SQL mock is
// used. Commands exercise the same imports, transfer/category derivation and cash pool as the apps.
import { D } from "@cashu/domain";
import type { RawTransaction } from "@cashu/domain/budget";
import { describe, expect, it } from "vitest";
import { createProfile } from "../core/commands.js";
import type { Store } from "../materialize.js";
import { runQuery, watchQuery } from "../query.js";
import { run, type TestEnv, testEnv } from "../testing/commands.js";
import { openTestStore } from "../testing/store.js";
import { addCashExpense, importStatement, setTransactionCategory } from "./commands.js";
import {
  type BudgetSpendingScreen,
  budgetScreenCashflow,
  budgetScreenCurrencies,
  budgetScreenSpending,
} from "./mcp-queries.js";

const TODAY = "2026-03-20";
const OWN_A = "PL10114000000000000000001234";
const OWN_B = "PL10124000000000000000003334";
const EURO = "PL10114000000000000000005678";

function vault() {
  const store = openTestStore();
  const env = testEnv();
  const created = run(store, env, createProfile, {
    slug: "synthetic-money",
    name: "Synthetic money",
    baseCurrency: "PLN",
    modules: ["budget"],
  });
  if (!created.ok) throw new Error("synthetic profile refused");
  return { store, env };
}

type Row = {
  date: string;
  amount: string;
  ref: string;
  iban?: string;
  category?: string;
};

function ingest(
  store: Store,
  env: TestEnv,
  currency: string,
  account: string,
  rows: readonly Row[],
): void {
  const transactions: RawTransaction[] = rows.map((r) => ({
    bookingDate: r.date,
    valueDate: null,
    amount: D(r.amount),
    currency,
    counterpartyName: "Synthetic counterparty",
    counterpartyIban: r.iban ?? null,
    description: r.ref,
    reference: r.ref,
    bankTransactionId: null,
    source: "csv",
    raw: { synthetic: r.ref },
  }));
  const imported = run(store, env, importStatement, {
    statement: {
      bank: "mbank",
      accountNumber: account,
      accountName: "Synthetic account",
      currency,
      transactions,
      balances: [],
      closingBalances: [],
    },
    newestDayRule: false,
  });
  if (!imported.ok) throw new Error("synthetic import refused");
  for (const row of rows) {
    if (row.category === undefined) continue;
    const txn = store.read<{ gid: string }>(
      "SELECT gid FROM transactions WHERE reference = ? AND dedup_hash NOT LIKE 'cashleg:%'",
      row.ref,
    )[0]?.gid;
    if (!txn) throw new Error("missing synthetic transaction");
    const claimed = run(store, env, setTransactionCategory, { txn, category: row.category });
    if (!claimed.ok) throw new Error("synthetic category refused");
  }
}

const args = (currency = "PLN") => ({ today: TODAY, currency, period: {} });

describe("money-screen budget queries", () => {
  it("isolates currencies, excludes own transfers and withdrawals, and includes cash expenses", () => {
    const { store, env } = vault();
    try {
      ingest(store, env, "PLN", OWN_A, [
        { date: "2026-02-04", amount: "-4.00", ref: "feb", category: "groceries" },
        { date: "2026-03-02", amount: "1000.00", ref: "income" },
        { date: "2026-03-03", amount: "-12.10", ref: "food", category: "groceries" },
        { date: "2026-03-04", amount: "-300.00", ref: "own-out", iban: OWN_B },
        { date: "2026-03-05", amount: "-50.00", ref: "atm", category: "cash_withdrawal" },
        { date: "2026-04-02", amount: "-3.00", ref: "future", category: "groceries" },
      ]);
      ingest(store, env, "PLN", OWN_B, [
        { date: "2026-03-04", amount: "300.00", ref: "own-in", iban: OWN_A },
      ]);
      ingest(store, env, "EUR", EURO, [
        { date: "2026-03-03", amount: "-9007199254740993.01", ref: "eur-large" },
        { date: "2026-03-04", amount: "-0.10", ref: "eur-small" },
      ]);
      expect(
        run(store, env, addCashExpense, {
          amount: "7.90",
          title: "Synthetic cash food",
          category: "groceries",
          currency: "PLN",
          onDate: "2026-03-07",
        }).ok,
      ).toBe(true);
      const march = { ...args(), period: { year: 2026, month: 3 } };
      const flow = runQuery(store, budgetScreenCashflow, march);
      expect(
        flow.value.rows.map((r) => [
          r.label,
          r.income.toString(),
          r.expense.toString(),
          r.net.toString(),
        ]),
      ).toEqual([["2026-03", "1000.00", "20.00", "980.00"]]);
      for (const table of ["accounts", "transactions", "profiles"]) {
        expect(flow.tables.has(table)).toBe(true);
      }
      const spending = runQuery(store, budgetScreenSpending, { ...march, lang: "en" }).value;
      expect(spending.rows.map((r) => [r.category, r.label, r.amount.toString()])).toEqual([
        ["groceries", "Groceries", "20.00"],
      ]);
      expect(spending.total.toString()).toBe("20.00");
      const euros = runQuery(store, budgetScreenSpending, { ...args("EUR"), lang: "en" }).value;
      expect(euros.total.toString()).toBe("9007199254740993.11");
      expect(euros.currency).toBe("EUR");
      const currencies = runQuery(store, budgetScreenCurrencies, { today: TODAY }).value;
      expect(currencies.currencies.map((r) => r.currency)).toEqual(["PLN", "EUR"]);
      expect(currencies.referenceDate).toBe("2026-04-02");
      expect(currencies.today).toBe(TODAY);
    } finally {
      store.close();
    }
  });

  it("preserves period conjunction and all-history semantics, including future imported rows", () => {
    const { store, env } = vault();
    try {
      ingest(store, env, "PLN", OWN_A, [
        { date: "2025-03-01", amount: "-1.00", ref: "old" },
        { date: "2026-02-01", amount: "-2.00", ref: "q1" },
        { date: "2026-03-01", amount: "-3.00", ref: "march" },
        { date: "2026-04-01", amount: "-4.00", ref: "q2" },
      ]);
      const periods = [
        [{}, ["2025-03", "2026-02", "2026-03", "2026-04"], "10.00"],
        [{ year: 2026, quarter: 1 }, ["2026-02", "2026-03"], "5.00"],
        [{ year: 2026, month: 3, quarter: 1 }, ["2026-03"], "3.00"],
        [{ year: 2026, month: 3, quarter: 2 }, [], "0.00"],
        [{ year: null, month: 3, quarter: null }, ["2025-03", "2026-03"], "4.00"],
      ] as const;
      for (const [period, labels, total] of periods) {
        const queryArgs = { ...args(), period };
        expect(
          runQuery(store, budgetScreenCashflow, queryArgs).value.rows.map((r) => r.label),
        ).toEqual(labels);
        expect(
          runQuery(store, budgetScreenSpending, {
            ...queryArgs,
            lang: "pl",
          }).value.total.toString(),
        ).toBe(total);
      }
    } finally {
      store.close();
    }
  });

  it("invalidates the live spending reader after imports and category claims", () => {
    const { store, env } = vault();
    let stop: (() => void) | undefined;
    try {
      const snapshots: BudgetSpendingScreen[] = [];
      stop = watchQuery(
        store,
        budgetScreenSpending,
        { ...args(), lang: "pl" },
        {
          onValue: (value) => snapshots.push(value),
          onError: (error) => {
            throw error;
          },
        },
      );
      expect(snapshots.at(-1)?.total.toString()).toBe("0.00");
      ingest(store, env, "PLN", OWN_A, [
        { date: "2026-03-01", amount: "-0.10", ref: "one", category: "groceries" },
        { date: "2026-03-02", amount: "-0.70", ref: "two", category: "groceries" },
      ]);
      expect(snapshots.at(-1)?.rows[0]?.category).toBe("groceries");
      expect(snapshots.at(-1)?.total.toString()).toBe("0.80");
    } finally {
      stop?.();
      store.close();
    }
  });
});
