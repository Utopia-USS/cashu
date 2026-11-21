// Budget commands on the in-memory store: importStatement (cross-source dedup, btid idempotency,
// identical same-day rows, end-of-day balances with closing balances winning, the import batch,
// the leader gate, the ISO currency check), deleteCashTransaction and the cushion settings.
// Synthetic data only.
import { D } from "@cashu/domain";
import type { RawTransaction, TxnSource } from "@cashu/domain/budget";
import { describe, expect, it } from "vitest";
import { createProfile, openAccount } from "../core/commands.js";
import type { Store } from "../materialize.js";
import { run, testEnv } from "../testing/commands.js";
import { EventFactory, openTestStore } from "../testing/store.js";
import { deleteCashTransaction, importStatement, setCushion } from "./commands.js";

const IBAN = "PL10000000000000000000000005";

function raw(
  amount: string,
  opts: { d?: string; cp?: string; source?: TxnSource; btid?: string } = {},
): RawTransaction {
  return {
    bookingDate: opts.d ?? "2024-01-05",
    valueDate: null,
    amount: D(amount),
    currency: "pln",
    counterpartyName: opts.cp ?? "Sklep ABC",
    counterpartyIban: null,
    description: "test",
    reference: null,
    bankTransactionId: opts.btid ?? null,
    source: opts.source ?? "csv",
    raw: { row: 1 },
  };
}

function statement(rows: RawTransaction[], extra: Record<string, unknown> = {}) {
  return {
    bank: "mbank",
    accountNumber: IBAN,
    accountName: "mBank",
    currency: "PLN",
    transactions: rows,
    balances: [],
    closingBalances: [],
    ...extra,
  };
}

const value = <T>(out: { ok: boolean; value?: T }) => (out.ok ? (out.value as T) : undefined);
type Imported = { account: string; numInserted: number; numDuplicates: number };

describe("importStatement", () => {
  it("dedups across sources and by bank transaction id; keeps identical same-day rows", () => {
    const store = openTestStore();
    const env = testEnv();
    const first = value<Imported>(
      run(store, env, importStatement, { statement: statement([raw("-49.99")]) }),
    );
    expect(first?.numInserted).toBe(1);
    // Open Banking sees the same real transaction (other source, a btid): a duplicate
    const ob = run(store, env, importStatement, {
      account: first?.account,
      statement: statement([raw("-49.99", { source: "open_banking", btid: "X1" })]),
      source: "open_banking",
    });
    expect(value<Imported>(ob)).toMatchObject({ numInserted: 0, numDuplicates: 1 });
    expect(ob.ok && ob.events.map((e) => e.type)).toEqual(["importBatch.recorded"]);
    // two identical coffees on one day: both kept (occurrence 0 and 1)
    const two = value<Imported>(
      run(store, env, importStatement, {
        account: first?.account,
        statement: statement([raw("-12.50"), raw("-12.50")]),
      }),
    );
    expect(two?.numInserted).toBe(2);
    expect(
      store.read(
        "SELECT amount, currency, occurrence FROM transactions WHERE amount = '-12.50' ORDER BY occurrence",
      ),
    ).toEqual([
      { amount: "-12.50", currency: "PLN", occurrence: 0 },
      { amount: "-12.50", currency: "PLN", occurrence: 1 },
    ]);
    expect(store.read("SELECT COUNT(*) AS n FROM accounts")).toEqual([{ n: 1 }]);
    expect(
      store.read(
        "SELECT source, num_seen, num_inserted, num_duplicates FROM import_batches ORDER BY id",
      ),
    ).toEqual([
      { source: "csv", num_seen: 1, num_inserted: 1, num_duplicates: 0 },
      { source: "open_banking", num_seen: 1, num_inserted: 0, num_duplicates: 1 },
      { source: "csv", num_seen: 2, num_inserted: 2, num_duplicates: 0 },
    ]);
  });

  it("re-syncing a btid is idempotent", () => {
    const store = openTestStore();
    const env = testEnv();
    const ob = (btid: string) =>
      statement([raw("-20.00", { source: "open_banking", btid })], { bank: "erste" });
    expect(
      value<Imported>(run(store, env, importStatement, { statement: ob("ABC123") }))?.numInserted,
    ).toBe(1);
    expect(
      value<Imported>(run(store, env, importStatement, { statement: ob("ABC123") }))?.numInserted,
    ).toBe(0);
  });

  it("records end-of-day balances, newest-first statements reversed, closing balances win", () => {
    const store = openTestStore();
    const env = testEnv();
    run(store, env, importStatement, {
      statement: statement([raw("-1.00", { d: "2024-01-06" }), raw("-2.00", { d: "2024-01-05" })], {
        balances: [
          { date: "2024-01-06", amount: D("97.00") },
          { date: "2024-01-05", amount: D("98.00") },
          { date: "2024-01-05", amount: D("100.00") },
        ],
        closingBalances: [{ date: "2024-01-06", amount: D("96.50") }],
      }),
    });
    expect(store.read("SELECT date, amount, source, currency FROM balances ORDER BY date")).toEqual(
      [
        { date: "2024-01-05", amount: "98.00", source: "csv", currency: "PLN" },
        { date: "2024-01-06", amount: "96.50", source: "csv", currency: "PLN" },
      ],
    );
  });

  it("refuses the newest-day rule off the lease and a non-ISO currency", () => {
    const store = openTestStore();
    const env = testEnv({ holder: false });
    expect(
      run(store, env, importStatement, { statement: statement([raw("-1")]), newestDayRule: true }),
    ).toEqual({ ok: false, reason: "not_leader" });
    const bad = { ...raw("-1"), currency: "zł" };
    expect(run(store, env, importStatement, { statement: statement([bad]) })).toEqual({
      ok: false,
      reason: "bad_currency",
    });
    expect(store.read("SELECT COUNT(*) AS n FROM event_log")).toEqual([{ n: 0 }]);
  });
});

/** A bank account, the cash pool and a withdrawal marked `cash_withdrawal` (until S24c's command). */
function withdrawal(store: Store) {
  const env = testEnv();
  const bank = value<{ account: string }>(
    run(store, env, openAccount, { bank: "mbank", type: "checking", currency: "PLN", iban: IBAN }),
  )?.account as string;
  run(store, env, openAccount, {
    bank: "manual",
    name: "Gotówka",
    type: "cash",
    currency: "PLN",
    externalId: "cash:PLN",
  });
  const imp = run(store, env, importStatement, {
    account: bank,
    statement: statement([raw("-200.00")]),
  });
  const txn = imp.ok ? (imp.events.find((e) => e.type === "txn.imported")?.gid as string) : "";
  const f = new EventFactory("dddddddddddddddddddddddddddddddd");
  store.applyEnvelopes([
    f.make(
      "txn.categorySet",
      txn,
      { category: "cash_withdrawal", source: "manual_txn" },
      { wall: 60_000 },
    ),
  ]);
  return { env, txn };
}

describe("deleteCashTransaction", () => {
  it("deletes a cash expense; refuses a bank transaction", () => {
    const store = openTestStore();
    const { env, txn } = withdrawal(store);
    const pool = store.read<{ gid: string }>("SELECT gid FROM accounts WHERE type = 'cash'")[0]
      ?.gid;
    const f = new EventFactory("dddddddddddddddddddddddddddddddd", "01JE");
    const expense = "01JE0000000000000000000099";
    store.applyEnvelopes([
      f.make(
        "txn.cashExpenseAdded",
        expense,
        {
          account: pool,
          bookingDate: "2024-01-06",
          amount: "-50",
          currency: "PLN",
          title: "Obiad",
          category: "dining",
        },
        { wall: 70_000 },
      ),
    ]);
    expect(
      store.read("SELECT category, category_source FROM transactions WHERE gid = ?", expense),
    ).toEqual([{ category: "dining", category_source: "manual_txn" }]);
    expect(run(store, env, deleteCashTransaction, { txn })).toEqual({
      ok: false,
      reason: "not_cash",
    });
    const out = run(store, env, deleteCashTransaction, { txn: expense });
    expect(out.ok && out.events.map((e) => e.type)).toEqual(["txn.deleted"]);
    expect(store.read("SELECT COUNT(*) AS n FROM transactions WHERE gid = ?", expense)).toEqual([
      { n: 0 },
    ]);
  });
});

describe("setCushion", () => {
  it("normalizes like settings.parse and refuses invalid values", () => {
    const store = openTestStore();
    const env = testEnv();
    const acc = value<{ account: string }>(
      run(store, env, openAccount, { bank: "mbank", type: "savings", currency: "PLN", iban: IBAN }),
    )?.account as string;
    const out = run(store, env, setCushion, {
      enabled: true,
      currency: " pln ",
      targetAmount: 10000.005,
      targetMonths: 6,
      accounts: [acc, acc],
      monthlyMax: "",
    });
    expect(out.ok && out.events[0]?.data).toEqual({
      enabled: true,
      currency: "PLN",
      targetAmount: "10000.00",
      targetMonths: 6,
      accounts: [acc],
      monthlyMax: null,
    });
    expect(
      store.read("SELECT enabled, currency, target_amount, accounts FROM budget_settings"),
    ).toEqual([
      { enabled: 1, currency: "PLN", target_amount: "10000.00", accounts: JSON.stringify([acc]) },
    ]);
    expect(run(store, env, setCushion, { enabled: true })).toMatchObject({
      reason: "needs_target",
    });
    expect(run(store, env, setCushion, { targetMonths: 37 })).toMatchObject({
      reason: "invalid_target_months",
    });
    expect(run(store, env, setCushion, { targetAmount: "-5" })).toMatchObject({
      reason: "invalid_target_amount",
    });
    expect(run(store, env, setCushion, { accounts: ["01JD0000000000000000000099"] })).toMatchObject(
      {
        reason: "unknown_account",
      },
    );
  });
});

describe("setCushion account rules", () => {
  const IBAN_EUR = "PL10000000000000000000000007";
  function setup(baseCurrency?: string) {
    const store = openTestStore();
    const env = testEnv();
    if (baseCurrency !== undefined) {
      run(store, env, createProfile, { slug: "dom", name: "Dom", baseCurrency });
    }
    const open = (currency: string, iban: string) =>
      value<{ account: string }>(
        run(store, env, openAccount, { bank: "mbank", type: "savings", currency, iban }),
      )?.account as string;
    return { store, env, pln: open("PLN", IBAN), eur: open("EUR", IBAN_EUR) };
  }
  const cushionRows = (s: Store) => s.read("SELECT gid FROM budget_settings");

  it("refuses an account outside the cushion currency, emitting nothing", () => {
    const { store, env, pln } = setup();
    const out = run(store, env, setCushion, {
      enabled: true,
      currency: "eur",
      targetAmount: 1,
      accounts: [pln],
    });
    expect(out).toEqual({ ok: false, reason: "cushion_currency_mismatch" });
    expect(cushionRows(store)).toEqual([]);
  });

  it("takes the profile base currency when the cushion has none", () => {
    const eurBase = setup("EUR");
    expect(
      run(eurBase.store, eurBase.env, setCushion, {
        enabled: true,
        targetAmount: 1,
        accounts: [eurBase.pln],
      }),
    ).toMatchObject({ reason: "cushion_currency_mismatch" });
    expect(
      run(eurBase.store, eurBase.env, setCushion, {
        enabled: true,
        targetAmount: 1,
        accounts: [eurBase.eur],
      }).ok,
    ).toBe(true);
    // no profile yet: PLN
    const none = setup();
    expect(
      run(none.store, none.env, setCushion, {
        enabled: true,
        targetAmount: 1,
        accounts: [none.eur],
      }),
    ).toMatchObject({ reason: "cushion_currency_mismatch" });
  });

  it("refuses one wrong account among right ones, and a mix with an unknown id as unknown", () => {
    const { store, env, pln, eur } = setup();
    const base = { enabled: true, currency: "EUR", targetAmount: 1 };
    expect(run(store, env, setCushion, { ...base, accounts: [eur, pln] })).toMatchObject({
      reason: "cushion_currency_mismatch",
    });
    // unknown ids are reported before the currency of the known ones
    const ghost = "01JD0000000000000000000099";
    expect(run(store, env, setCushion, { ...base, accounts: [pln, ghost] })).toMatchObject({
      reason: "unknown_account",
    });
  });
});
