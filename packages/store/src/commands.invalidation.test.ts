// Touched-table invalidation (testing.md: "a test that each command's touched tables re-run the
// queries that read them"): every S24 command's batch reports the public tables it changed, derived
// writes included, and a subscriber to the tables a screen query reads is notified. Synthetic data.
import { D } from "@cashu/domain";
import { describe, expect, it } from "vitest";
import { addManualPosition } from "./assets/commands.js";
import {
  addCashExpense,
  cacheLlmRules,
  importStatement,
  setCushion,
  setLlmCategories,
  setMerchantCategory,
  setTransactionCategory,
} from "./budget/commands.js";
import { type Command, type CommandEnv, runCommand } from "./command.js";
import { createProfile, openAccount, recordBalance, setModules } from "./core/commands.js";
import { addLoan } from "./loans/commands.js";
import type { Store } from "./materialize.js";
import { testEnv } from "./testing/commands.js";
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
  it("profile, modules, accounts, balances", () => {
    const store = openTestStore();
    const env = testEnv();
    expect(
      touched(
        store,
        env,
        createProfile,
        { slug: "d", name: "D", modules: ["budget"] },
        "SELECT * FROM profiles",
      ),
    ).toEqual({
      tables: ["profile_modules", "profiles"],
      notified: 1,
    });
    expect(
      touched(
        store,
        env,
        setModules,
        { moduleIds: ["loans"] },
        "SELECT module_id FROM profile_modules WHERE enabled = 1",
      ).notified,
    ).toBe(1);
    const open = touched(
      store,
      env,
      openAccount,
      { bank: "manual", name: "S", type: "savings", currency: "PLN", externalId: "manual:S" },
      "SELECT * FROM accounts",
    );
    expect(open).toEqual({ tables: ["accounts"], notified: 1 });
    const account = store.read<{ gid: string }>("SELECT gid FROM accounts")[0]?.gid;
    expect(
      touched(
        store,
        env,
        recordBalance,
        { account, date: "2026-10-01", amount: "1" },
        "SELECT SUM(amount) FROM balances",
      ),
    ).toEqual({
      tables: ["balances"],
      notified: 1,
    });
  });

  it("an import touches accounts, batches, transactions and balances", () => {
    const store = openTestStore();
    const env = testEnv();
    const t = touched(
      store,
      env,
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
              counterpartyName: "Sklep",
              counterpartyIban: null,
              description: null,
              reference: null,
              bankTransactionId: null,
              source: "csv",
              raw: {},
            },
          ],
          balances: [{ date: "2026-10-01", amount: D("95.00") }],
          closingBalances: [],
        },
      },
      "SELECT t.amount FROM transactions t JOIN accounts a ON a.id = t.account_id",
    );
    expect(t).toEqual({
      tables: ["accounts", "balances", "import_batches", "transactions"],
      notified: 1,
    });
  });

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
          ],
          balances: [],
          closingBalances: [],
        },
      },
      env,
    );
    expect(imp.ok).toBe(true);
    const txn = store.read<{ gid: string }>("SELECT gid FROM transactions")[0]?.gid;
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
        { items: [{ merchantKey: "ZXQ INNY", category: "dining" }] },
        "SELECT * FROM category_rules",
      ),
    ).toEqual({ tables: ["category_rules"], notified: 1 });
    expect(
      touched(store, env, setLlmCategories, { items: [{ txn, category: "health" }] }, spending),
    ).toEqual({ tables: [], notified: 0 }); // the locked rule beats an llm claim: nothing visible changed
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

  it("cushion, loans, manual positions", () => {
    const store = openTestStore();
    const env = testEnv();
    expect(
      touched(store, env, setCushion, { enabled: false }, "SELECT * FROM budget_settings").tables,
    ).toEqual(["budget_settings"]);
    expect(
      touched(
        store,
        env,
        addLoan,
        {
          name: "Kredyt",
          principal: "1000",
          annualRate: "5",
          termMonths: 12,
          startDate: "2026-11-01",
        },
        "SELECT * FROM loans",
      ).tables,
    ).toEqual(["accounts", "loans"]);
    expect(
      touched(
        store,
        env,
        addManualPosition,
        { name: "Dom", type: "property", value: "1", note: "n" },
        "SELECT * FROM asset_details",
      ).tables,
    ).toEqual(["accounts", "asset_details", "balances"]);
  });
});
