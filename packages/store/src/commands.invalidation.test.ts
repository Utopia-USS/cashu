// Touched-table invalidation through derived writes (testing.md: "a test that each command's touched
// tables re-run the queries that read them"): a command whose batch only writes an input table still
// reports and notifies the derived tables its derivers rewrote (categories, cash legs). Plain writes
// are recorded by the engine itself (store.test.ts "touched tables and subscriptions"). Synthetic data.
import { D } from "@cashu/domain";
import { describe, expect, it } from "vitest";
import {
  addCashExpense,
  cacheLlmRules,
  importStatement,
  setLlmCategories,
  setMerchantCategory,
  setTransactionCategory,
} from "./budget/commands.js";
import { type Command, type CommandEnv, runCommand } from "./command.js";
import { openAccount } from "./core/commands.js";
import type { Store } from "./materialize.js";
import { run, testEnv } from "./testing/commands.js";
import { EventFactory, openTestStore } from "./testing/store.js";

/** Run `cmd`, returning the touched tables of its apply and whether a query's subscriber fired. */
function touched<I, R>(
  store: Store,
  env: CommandEnv,
  cmd: Command<I, R>,
  input: unknown,
  query: string,
) {
  let applied: ReadonlySet<string> = new Set();
  let notified = 0;
  const off = store.subscribe(store.tablesRead(query), () => {
    notified += 1;
  });
  const out = runCommand(
    store,
    {
      append: (b) => {
        applied = store.applyEnvelopes(b).touchedTables;
      },
    },
    cmd,
    input,
    env,
  );
  off();
  expect(out.ok).toBe(true);
  return { tables: [...applied].sort(), notified };
}

describe("command batches invalidate the queries that read their tables", () => {
  it("derived writes count: a claim re-derives the category, a pool open makes the leg", () => {
    const store = openTestStore();
    const env = testEnv();
    const bank = runCommand(
      store,
      { append: (b) => void store.applyEnvelopes(b) },
      openAccount,
      { bank: "mbank", type: "checking", currency: "PLN", iban: "61109010140000071219812874" },
      env,
    );
    const account = bank.ok ? bank.value.account : "";
    const f = new EventFactory("dddddddddddddddddddddddddddddddd");
    const hash = "a".repeat(40);
    const txn = store.deps.det("transactions", [account, hash, "0"]);
    store.applyEnvelopes([
      f.make(
        "txn.imported",
        txn,
        {
          account,
          batch: null,
          bookingDate: "2026-10-01",
          valueDate: null,
          amount: "-200.00",
          currency: "PLN",
          counterpartyName: null,
          counterpartyIban: null,
          description: null,
          reference: null,
          bankTransactionId: null,
          source: "csv",
          dedupHash: hash,
          occurrence: 0,
          raw: {},
        },
        { wall: 60_000 },
      ),
    ]);
    const claim = store.applyEnvelopes([
      f.make(
        "txn.categorySet",
        txn,
        { category: "cash_withdrawal", source: "manual_txn" },
        { wall: 61_000 },
      ),
    ]);
    expect([...claim.touchedTables]).toEqual(["transactions"]); // the category column
    const pool = touched(
      store,
      env,
      openAccount,
      { bank: "manual", name: "Gotówka", type: "cash", currency: "PLN", externalId: "cash:PLN" },
      "SELECT * FROM transactions WHERE account_id IN (SELECT id FROM accounts WHERE type = 'cash')",
    );
    expect(pool).toEqual({ tables: ["accounts", "transactions"], notified: 1 }); // the leg row
  });

  it("category commands: a merchant rule re-derives its rows; claims and cash expenses too", () => {
    const store = openTestStore();
    const env = testEnv();
    const imp = runCommand(
      store,
      { append: (b) => void store.applyEnvelopes(b) },
      importStatement,
      {
        statement: {
          bank: "mbank",
          accountNumber: "61109010140000071219812874",
          accountName: null,
          currency: "PLN",
          transactions: [
            {
              bookingDate: "2026-10-01",
              valueDate: null,
              amount: D("-5.00"),
              currency: "PLN",
              counterpartyName: "ZXQ SKLEP",
              counterpartyIban: null,
              description: null,
              reference: null,
              bankTransactionId: null,
              source: "csv",
              raw: {},
            },
            {
              bookingDate: "2026-10-02",
              valueDate: null,
              amount: D("-7.00"),
              currency: "PLN",
              counterpartyName: "ZXQ INNY",
              counterpartyIban: null,
              description: null,
              reference: null,
              bankTransactionId: null,
              source: "csv",
              raw: {},
            },
          ],
          balances: [],
          closingBalances: [],
        },
      },
      env,
    );
    expect(imp.ok).toBe(true);
    const gidOf = (amount: string) =>
      store.read<{ gid: string }>("SELECT gid FROM transactions WHERE amount = ?", amount)[0]?.gid;
    const txn = gidOf("-5.00");
    const spending = "SELECT category, SUM(amount) FROM transactions GROUP BY category";
    expect(
      touched(
        store,
        env,
        setMerchantCategory,
        { merchantKey: "ZXQ SKLEP", category: "gifts" },
        spending,
      ),
    ).toEqual({ tables: ["category_rules", "transactions"], notified: 1 });
    expect(
      touched(
        store,
        env,
        cacheLlmRules,
        { items: [{ merchantKey: "ZXQ BRAK", category: "dining" }] },
        "SELECT * FROM category_rules",
      ),
    ).toEqual({ tables: ["category_rules"], notified: 1 });
    // the row a locked rule decides gets no claim at all (Python: configured, never reclassified)
    const decided = run(store, env, setLlmCategories, { items: [{ txn, category: "health" }] });
    expect(decided.ok && decided.events).toEqual([]);
    expect(
      touched(
        store,
        env,
        setLlmCategories,
        { items: [{ txn: gidOf("-7.00"), category: "health" }] },
        spending,
      ),
    ).toEqual({ tables: ["transactions"], notified: 1 });
    expect(
      touched(store, env, setTransactionCategory, { txn, category: "cash_withdrawal" }, spending),
    ).toEqual({ tables: ["accounts", "transactions"], notified: 1 });
    expect(
      touched(
        store,
        env,
        addCashExpense,
        { amount: "2", title: "Kawa", category: "dining" },
        spending,
      ),
    ).toEqual({ tables: ["transactions"], notified: 1 });
  });
});
