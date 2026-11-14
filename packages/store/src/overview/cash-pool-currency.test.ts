// Data-safety rule 5 on the desktop: a cash pool row in another currency than its pool's (a foreign
// or malformed `txn.cashExpenseAdded`; the app's own commands route by currency) counts in its own
// currency, the way the phone's `accountBalances` reports it, and is never added to the pool's
// currency. The phone test's scenario (`companion-queries.test.ts` "overview inputs"); every row is
// invented. Hand-computed: PLN 1000.00 - 12.00 = 988.00; EUR -3.00 - 5.00 = -8.00 (the old sum
// across currencies gave 980.00 PLN and a -20.00 PLN wallet).
import { budget, core, D } from "@cashu/domain";
import type { RawTransaction } from "@cashu/domain/budget";
import { describe, expect, it } from "vitest";
import { addCashExpense, importStatement } from "../budget/commands.js";
import { accountBalances } from "../budget/companion-queries.js";
import { createProfile, recordBalance } from "../core/commands.js";
import type { Store } from "../materialize.js";
import { run, testEnv } from "../testing/commands.js";
import { EventFactory, openTestStore, testUlid } from "../testing/store.js";
import { cashWallet } from "./cash.js";
import { netWorthSeries, shellSummary, vaultNetWorthBook } from "./networth.js";
import { overviewAccounts } from "./widgets.js";

const TODAY = "2026-03-20";
const NUMBER = "PL10114000000000000000001234";

function syntheticVault(): { store: Store; pool: string } {
  const store = openTestStore();
  const env = testEnv();
  const ok = (r: { ok: boolean }, what: string) => {
    if (!r.ok) throw new Error(`synthetic ${what} refused`);
  };
  ok(
    run(store, env, createProfile, {
      slug: "synthetic-pool",
      name: "Synthetic pool",
      baseCurrency: "PLN",
      modules: ["budget"],
    }),
    "profile",
  );
  const fee: RawTransaction = {
    bookingDate: "2026-03-19",
    valueDate: null,
    amount: D("-1.00"),
    currency: "PLN",
    counterpartyName: "SYNTHETIC FEE",
    counterpartyIban: null,
    description: "fee",
    reference: "fee",
    bankTransactionId: null,
    source: "csv",
    raw: { synthetic: "fee" },
  };
  ok(
    run(store, env, importStatement, {
      statement: {
        bank: "mbank",
        accountNumber: NUMBER,
        accountName: "Synthetic 1234",
        currency: "PLN",
        transactions: [fee],
        balances: [],
        closingBalances: [],
      },
      newestDayRule: false,
    }),
    "import",
  );
  const bank = store.read<{ gid: string }>("SELECT gid FROM accounts WHERE type = 'checking'")[0]
    ?.gid;
  if (bank === undefined) throw new Error("missing the synthetic bank account");
  ok(
    run(store, env, recordBalance, {
      account: bank,
      date: "2026-03-19",
      amount: "1000.00",
      source: "csv",
    }),
    "balance",
  );
  ok(
    run(store, env, addCashExpense, {
      amount: "12.00",
      title: "Synthetic coffee",
      category: "dining",
      onDate: "2026-03-18",
    }),
    "cash expense",
  );
  const pool = store.read<{ gid: string }>(
    "SELECT gid FROM accounts WHERE type = 'cash' AND currency = 'PLN'",
  )[0]?.gid;
  if (pool === undefined) throw new Error("missing the synthetic cash pool");
  return { store, pool };
}

/** Two EUR cash expenses addressed to the PLN pool (an earlier month and this one). */
function addForeignRows(store: Store, pool: string): void {
  const f = new EventFactory("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "01KE");
  const foreign = (n: number, bookingDate: string, amount: string) =>
    f.make("txn.cashExpenseAdded", testUlid("01KF", n), {
      account: pool,
      bookingDate,
      amount,
      currency: "EUR",
      title: "Synthetic euro coffee",
      category: "dining",
    });
  const applied = store.applyEnvelopes([
    foreign(1, "2026-02-10", "-3.00"),
    foreign(2, "2026-03-17", "-5.00"),
  ]).applied;
  if (applied !== 2) throw new Error("synthetic foreign rows not applied");
}

const env = { today: TODAY, prices: null } as const;
const money = (r: Readonly<Record<string, { toString(): string }>>) =>
  Object.entries(r).map(([c, v]) => [c, v.toString()]);

describe("a cash pool's rows in another currency on the desktop", () => {
  it("leave every number unchanged while every row is in its pool's currency", () => {
    const { store } = syntheticVault();
    try {
      const read = store.read.bind(store);
      expect(money(shellSummary(read, env).networth)).toEqual([["PLN", "988.00"]]);
      const wallet = cashWallet(read);
      expect([wallet.currency, wallet.balance.toString(), wallet.expenses.toString()]).toEqual([
        "PLN",
        "-12.00",
        "12.00",
      ]);
    } finally {
      store.close();
    }
  });

  it("count in their own currency, as the phone reports them, never in the pool's", () => {
    const { store, pool } = syntheticVault();
    try {
      addForeignRows(store, pool);
      const read = store.read.bind(store);

      // net worth now (shell summary, overview hero, MCP and CLI read the same book)
      expect(money(shellSummary(read, env).networth)).toEqual([
        ["EUR", "-8.00"],
        ["PLN", "988.00"],
      ]);
      const lines = core.netWorth(vaultNetWorthBook(read, env)).lines;
      expect(
        lines
          .filter((l) => l.account.type === budget.CASH_ACCOUNT_TYPE)
          .map((l) => [l.account.id, l.account.currency, l.amount?.toString()]),
      ).toEqual([
        [pool, "PLN", "-12.00"],
        [budget.cashPoolPartId(pool, "EUR"), "EUR", "-8.00"],
      ]);

      // the account lists (desktop and phone) name the part after its pool plus the currency code
      const poolRow = store.read<{ name: string; bank: string }>(
        "SELECT name, bank FROM accounts WHERE gid = ?",
        pool,
      )[0];
      if (poolRow === undefined) throw new Error("missing the synthetic pool row");
      expect(
        overviewAccounts(read, vaultNetWorthBook(read, env))
          .filter((a) => a.type === budget.CASH_ACCOUNT_TYPE)
          .map((a) => [a.gid, a.name, a.bank, a.currency, a.amount?.toString()]),
      ).toEqual([
        [pool, poolRow.name, poolRow.bank, "PLN", "-12.00"],
        [budget.cashPoolPartId(pool, "EUR"), `${poolRow.name} (EUR)`, poolRow.bank, "EUR", "-8.00"],
      ]);

      // the phone's balances of the same vault agree, currency by currency
      expect(
        accountBalances(read, TODAY)
          .filter((b) => b.id === pool)
          .map((b) => [b.currency, b.balance.toString()]),
      ).toEqual([
        ["PLN", "-12.00"],
        ["EUR", "-8.00"],
      ]);

      // the history of each currency (the EUR line: -3.00 from Feb 10, -8.00 from Mar 17)
      const series = (currency: string) =>
        netWorthSeries(read, { today: TODAY, lang: "en", currency }, { prices: null }).points.map(
          (p) => [p.date, p.value.toString()],
        );
      const eur = series("EUR");
      expect(eur[0]).toEqual(["2026-02-10", "-3.00"]);
      expect(eur.at(-1)).toEqual(["2026-03-17", "-8.00"]);
      expect(series("PLN").at(-1)?.[1]).toBe("988.00");
      expect(series("PLN").some(([d]) => d === "2026-02-10" || d === "2026-03-17")).toBe(false);

      // the PLN cash drawer holds the PLN rows only
      const wallet = cashWallet(read);
      expect([wallet.balance.toString(), wallet.expenses.toString()]).toEqual(["-12.00", "12.00"]);
      expect(wallet.transactions.map((t) => [t.date, t.amount.toString()])).toEqual([
        ["2026-03-18", "-12.00"],
      ]);
    } finally {
      store.close();
    }
  });
});
