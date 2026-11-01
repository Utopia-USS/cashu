// The category commands (S24c, S24 5) on the in-memory store, with the effective categories
// derived in the view. Translates Python tests/test_cash.py (marking, cash expense, unmarking; the
// net-worth and spending parts are S10 / S11 read models), tests/test_ingestion.py
// test_transaction_category_override_survives_recategorize, tests/test_reclassify.py
// test_merchant_pin_leaves_rows_with_their_own_decision and tests/test_loans.py
// test_a_manual_merchant_rule_still_wins_over_the_loans_payment_account; plus the batch shapes,
// value-free refusals, idempotence and the cloud gate of the classifier query (PRIVACY(D-09.5)).
// Synthetic data only.
import { D } from "@cashu/domain";
import type { RawTransaction } from "@cashu/domain/budget";
import { describe, expect, it } from "vitest";
import { createProfile, openAccount } from "../core/commands.js";
import type { Store } from "../materialize.js";
import { run, type TestEnv, testEnv } from "../testing/commands.js";
import { EventFactory, openTestStore } from "../testing/store.js";
import {
  addCashExpense,
  cacheLlmRules,
  deleteCashTransaction,
  importStatement,
  setLlmCategories,
  setMerchantCategory,
  setTransactionCategory,
} from "./commands.js";
import { classifierMerchants } from "./queries.js";

const IBAN = "PL10114000000000000000001234";
const OWN = "PL10124000000000000000003334";

function raw(
  amount: string,
  opts: { d?: string; cp?: string | null; ref?: string | null; iban?: string | null } = {},
): RawTransaction {
  return {
    bookingDate: opts.d ?? "2024-01-05",
    valueDate: null,
    amount: D(amount),
    currency: "PLN",
    counterpartyName: opts.cp ?? null,
    counterpartyIban: opts.iban ?? null,
    description: opts.ref ?? null,
    reference: opts.ref ?? null,
    bankTransactionId: null,
    source: "csv",
    raw: {},
  };
}

function vault(): { store: Store; env: TestEnv } {
  const store = openTestStore();
  const env = testEnv();
  run(store, env, createProfile, { slug: "d", name: "D", modules: ["budget", "loans"] });
  return { store, env };
}

function ingest(store: Store, env: TestEnv, rows: RawTransaction[], iban = IBAN): void {
  const out = run(store, env, importStatement, {
    statement: {
      bank: "mbank",
      accountNumber: iban,
      accountName: "mBank",
      currency: "PLN",
      transactions: rows,
      balances: [],
      closingBalances: [],
    },
  });
  expect(out.ok).toBe(true);
}

const gidOf = (store: Store, amount: string) =>
  store.read<{ gid: string }>(
    "SELECT gid FROM transactions WHERE amount = ? AND dedup_hash NOT LIKE 'cashleg:%'",
    amount,
  )[0]?.gid as string;

const catOf = (store: Store, gid: string) =>
  store.read<{ category: string | null; category_source: string | null }>(
    "SELECT category, category_source FROM transactions WHERE gid = ?",
    gid,
  )[0];

const poolRows = (store: Store) =>
  store.read<{ amount: string; category: string; category_source: string }>(
    `SELECT t.amount, t.category, t.category_source FROM transactions t
     JOIN accounts a ON a.id = t.account_id WHERE a.type = 'cash' ORDER BY t.id`,
  );

const WYPLATA = { ref: "WYPLATA W BANKOMACIE" };

describe("setTransactionCategory (test_cash.py, test_ingestion.py)", () => {
  it("test_marking_withdrawal_feeds_pool: the pool opens in the batch once; the leg cancels the withdrawal", () => {
    const { store, env } = vault();
    ingest(store, env, [raw("-200.00", WYPLATA), raw("-100.00", WYPLATA)]);
    const w = gidOf(store, "-200.00");
    expect(catOf(store, w)).toEqual({ category: "cash", category_source: "keyword" });
    const out = run(store, env, setTransactionCategory, { txn: w, category: "cash_withdrawal" });
    expect(out.ok && out.events.map((e) => e.type)).toEqual(["account.opened", "txn.categorySet"]);
    expect(store.read("SELECT name, type, external_id FROM accounts WHERE type = 'cash'")).toEqual([
      { name: "Gotówka", type: "cash", external_id: "cash:PLN" },
    ]);
    expect(poolRows(store)).toEqual([
      { amount: "200.00", category: "cash_withdrawal", category_source: "cash_leg" },
    ]);
    expect(catOf(store, w)).toEqual({ category: "cash_withdrawal", category_source: "manual_txn" });
    const second = run(store, env, setTransactionCategory, {
      txn: gidOf(store, "-100.00"),
      category: "cash_withdrawal",
    });
    expect(second.ok && second.events.map((e) => e.type)).toEqual(["txn.categorySet"]);
  });

  it("test_unmark_removes_mirror_and_reverts_source: the source falls back to its keyword", () => {
    const { store, env } = vault();
    ingest(store, env, [raw("-200.00", WYPLATA)]);
    const w = gidOf(store, "-200.00");
    run(store, env, setTransactionCategory, { txn: w, category: "cash_withdrawal" });
    const leg = store.read<{ gid: string }>(
      "SELECT gid FROM transactions WHERE dedup_hash LIKE 'cashleg:%'",
    )[0]?.gid;
    expect(run(store, env, deleteCashTransaction, { txn: leg }).ok).toBe(true);
    expect(poolRows(store)).toEqual([]);
    expect(catOf(store, w)).toEqual({ category: "cash", category_source: "keyword" });
  });

  it("test_transaction_category_override_survives_recategorize", () => {
    const { store, env } = vault();
    ingest(store, env, [raw("-24.47", { ref: "CARREFOUR EXPRESS", d: "2026-05-02" })]);
    const t = gidOf(store, "-24.47");
    expect(catOf(store, t)).toEqual({ category: "groceries", category_source: "keyword" });
    run(store, env, setTransactionCategory, { txn: t, category: "dining" });
    expect(store.rederive().touchedTables.size).toBe(0);
    expect(catOf(store, t)).toEqual({ category: "dining", category_source: "manual_txn" });
  });

  it("refuses an unknown row or category without emitting", () => {
    const { store, env } = vault();
    ingest(store, env, [raw("-1.00", { cp: "SKLEP" })]);
    expect(
      run(store, env, setTransactionCategory, {
        txn: "0b7c2348-a233-87ef-9f1b-4b5bd5161ee0",
        category: "dining",
      }),
    ).toEqual({ ok: false, reason: "no_transaction" });
    expect(
      run(store, env, setTransactionCategory, { txn: gidOf(store, "-1.00"), category: "nope" }),
    ).toEqual({ ok: false, reason: "invalid_input" });
  });
});

describe("addCashExpense (test_cash.py)", () => {
  it("test_cash_expense_draws_pool_and_counts_as_spend", () => {
    const { store, env } = vault();
    ingest(store, env, [raw("-200.00", WYPLATA)]);
    run(store, env, setTransactionCategory, {
      txn: gidOf(store, "-200.00"),
      category: "cash_withdrawal",
    });
    const out = run(store, env, addCashExpense, {
      amount: 50,
      title: " Obiad ",
      category: "dining",
    });
    expect(out.ok && out.events.map((e) => [e.type, e.data])).toEqual([
      [
        "txn.cashExpenseAdded",
        {
          account: store.read<{ gid: string }>("SELECT gid FROM accounts WHERE type = 'cash'")[0]
            ?.gid,
          bookingDate: "2026-10-31",
          amount: "-50.0", // Python Decimal(str(float(50)))
          currency: "PLN",
          title: "Obiad",
          category: "dining",
        },
      ],
    ]);
    const rows = poolRows(store);
    expect(rows.map((r) => r.amount)).toEqual(["200.00", "-50.0"]);
    expect(rows.reduce((s, r) => s.add(D(r.amount)), D("0")).toString()).toBe("150.00");
    expect(rows[1]).toMatchObject({ category: "dining", category_source: "manual_txn" });
  });

  it("opens the pool of another currency named with it; value-free refusals", () => {
    const { store, env } = vault();
    const eur = run(store, env, addCashExpense, {
      amount: "-12.5",
      title: "Kawa",
      category: "dining",
      currency: "eur",
      onDate: "2026-10-01",
    });
    expect(eur.ok && eur.events.map((e) => e.type)).toEqual([
      "account.opened",
      "txn.cashExpenseAdded",
    ]);
    expect(store.read("SELECT name, currency FROM accounts")).toEqual([
      { name: "Gotówka (EUR)", currency: "EUR" },
    ]);
    const bad = (input: Record<string, unknown>) =>
      run(store, env, addCashExpense, { amount: "1", title: "T", category: "dining", ...input });
    expect(bad({ category: "nope" })).toEqual({ ok: false, reason: "unknown_category" });
    expect(bad({ title: "  " })).toEqual({ ok: false, reason: "empty_title" });
    expect(bad({ amount: "abc" })).toEqual({ ok: false, reason: "invalid_amount" });
    expect(bad({ amount: "NaN" })).toEqual({ ok: false, reason: "invalid_amount" });
    // a non-finite number never reaches the command (zod refuses it)
    expect(bad({ amount: Number.NEGATIVE_INFINITY })).toEqual({
      ok: false,
      reason: "invalid_input",
    });
    expect(bad({ amount: "-0.00" })).toEqual({ ok: false, reason: "zero_amount" });
    expect(bad({ currency: "PLNX" })).toEqual({ ok: false, reason: "bad_currency" });
  });
});

describe("setMerchantCategory (test_reclassify.py, test_loans.py)", () => {
  it("test_merchant_pin_leaves_rows_with_their_own_decision", () => {
    const { store, env } = vault();
    ingest(store, env, [], OWN);
    ingest(store, env, [
      raw("-10.00", { cp: "SKLEP PIN TEST", d: "2024-01-01" }),
      raw("-20.00", { cp: "SKLEP PIN TEST", d: "2024-01-02" }),
      raw("-40.00", { cp: "SKLEP PIN TEST", d: "2024-01-03", iban: OWN }),
    ]);
    const chosen = gidOf(store, "-20.00");
    run(store, env, setTransactionCategory, { txn: chosen, category: "gifts" });
    const out = run(store, env, setMerchantCategory, {
      merchantKey: "SKLEP PIN TEST",
      category: "shopping",
    });
    expect(out.ok && out.events.map((e) => [e.type, e.data])).toEqual([
      [
        "categoryRule.set",
        { merchantKey: "SKLEP PIN TEST", category: "shopping", source: "manual", locked: true },
      ],
    ]);
    expect(catOf(store, gidOf(store, "-10.00"))).toEqual({
      category: "shopping",
      category_source: "manual",
    });
    expect(catOf(store, chosen)).toEqual({ category: "gifts", category_source: "manual_txn" });
    expect(catOf(store, gidOf(store, "-40.00"))).toEqual({
      category: "transfer",
      category_source: "transfer",
    });
    // idempotent: the rule already says so
    const again = run(store, env, setMerchantCategory, {
      merchantKey: "SKLEP PIN TEST",
      category: "shopping",
    });
    expect(again.ok && again.events).toEqual([]);
    expect(run(store, env, setMerchantCategory, { merchantKey: "", category: "shopping" })).toEqual(
      { ok: false, reason: "invalid_input" },
    );
  });

  it("test_a_manual_merchant_rule_still_wins_over_the_loans_payment_account", () => {
    const { store, env } = vault();
    // a loan whose installments go to the lender's account (loan.* events: budget never imports loans)
    const opened = run(store, env, openAccount, {
      bank: "manual",
      name: "Auto",
      type: "loan",
      currency: "PLN",
      externalId: "manual:Auto",
    });
    const loan = opened.ok ? (opened.value as { account: string }).account : "";
    const f = new EventFactory("dddddddddddddddddddddddddddddddd");
    const loanGid = store.deps.det("loans", [loan]);
    store.applyEnvelopes([
      f.make(
        "loan.termsSet",
        loanGid,
        {
          account: loan,
          principal: "30000",
          annualRate: "8",
          termMonths: 48,
          startDate: "2025-01-01",
          originationDate: null,
        },
        { wall: 120_000 },
      ),
      f.make(
        "loan.paymentMatchingSet",
        loanGid,
        {
          account: loan,
          paymentIban: OWN,
          paymentText: null,
        },
        { wall: 121_000 },
      ),
    ]);
    ingest(store, env, [raw("-700.00", { cp: "BANK AUTO TEST", iban: OWN })]);
    const t = gidOf(store, "-700.00");
    expect(catOf(store, t)).toEqual({ category: "loans", category_source: "keyword" });
    run(store, env, setMerchantCategory, { merchantKey: "BANK AUTO TEST", category: "housing" });
    expect(catOf(store, t)).toEqual({ category: "housing", category_source: "manual" });
  });
});

describe("LLM result commands (D-09.5)", () => {
  it("cacheLlmRules: refused answers, locked rules and unchanged rules emit nothing", () => {
    const { store, env } = vault();
    ingest(store, env, [raw("-5.00", { cp: "ZXQ KAWIARNIA" }), raw("-6.00", { cp: "ZXQ PIN" })]);
    run(store, env, setMerchantCategory, { merchantKey: "ZXQ PIN", category: "gifts" });
    const out = run(store, env, cacheLlmRules, {
      items: [
        { merchantKey: "ZXQ KAWIARNIA", category: "dining" },
        { merchantKey: "ZXQ PIN", category: "dining" },
        { merchantKey: "ZXQ A", category: "other" },
        { merchantKey: "ZXQ B", category: "transfer" },
        { merchantKey: "ZXQ C", category: "cash_withdrawal" },
        { merchantKey: "ZXQ D", category: "nope" },
      ],
    });
    expect(out.ok && out.value).toEqual({ cached: 1 });
    expect(catOf(store, gidOf(store, "-5.00"))).toEqual({
      category: "dining",
      category_source: "llm",
    });
    expect(catOf(store, gidOf(store, "-6.00"))).toEqual({
      category: "gifts",
      category_source: "manual",
    });
    const again = run(store, env, cacheLlmRules, {
      items: [{ merchantKey: "ZXQ KAWIARNIA", category: "dining" }],
    });
    expect(again.ok && again.events).toEqual([]);
  });

  it("setLlmCategories: llm_full claims, never over a manual claim or on a cash account", () => {
    const { store, env } = vault();
    ingest(store, env, [raw("-5.00", { cp: "ZXQ A" }), raw("-6.00", { cp: "ZXQ B" })]);
    run(store, env, setTransactionCategory, { txn: gidOf(store, "-6.00"), category: "gifts" });
    const cash = run(store, env, addCashExpense, {
      amount: "3",
      title: "Kawa",
      category: "dining",
    });
    const expense = cash.ok ? (cash.value as { txn: string }).txn : "";
    const out = run(store, env, setLlmCategories, {
      items: [
        { txn: gidOf(store, "-5.00"), category: "health" },
        { txn: gidOf(store, "-6.00"), category: "health" },
        { txn: expense, category: "health" },
        { txn: "0b7c2348-a233-87ef-9f1b-4b5bd5161ee0", category: "health" },
      ],
    });
    expect(out.ok && out.value).toEqual({ set: 1 });
    expect(catOf(store, gidOf(store, "-5.00"))).toEqual({
      category: "health",
      category_source: "llm_full",
    });
    expect(catOf(store, gidOf(store, "-6.00"))).toEqual({
      category: "gifts",
      category_source: "manual_txn",
    });
  });

  it("classifierMerchants: PRIVACY(D-09.5) the cloud list never holds a merchant seen with an IBAN or a P2P marker", () => {
    const { store, env } = vault();
    ingest(store, env, [
      raw("-5.00", { cp: "QWERTYMART", d: "2024-01-01" }),
      raw("-6.00", { cp: "KOWALSKI", d: "2024-01-02" }),
      raw("-7.00", { cp: "KOWALSKI", d: "2024-01-03", iban: "PL10114000000000000000009999" }),
      raw("-8.00", { cp: "ZXQ STUDIO", ref: "PRZELEW DLA ZXQ STUDIO", d: "2024-01-04" }),
    ]);
    const m = classifierMerchants(store.read.bind(store));
    expect([...m.local].sort()).toEqual(["KOWALSKI", "QWERTYMART", "ZXQ STUDIO"]);
    expect([...m.cloud]).toEqual(["QWERTYMART"]);
  });
});
