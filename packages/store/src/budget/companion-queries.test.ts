// The phone companion's budget reads over real in-memory vaults. Every row is invented; commands run
// the same imports, transfer and category derivation and cash pool as the apps.
import { D } from "@cashu/domain";
import type { RawTransaction } from "@cashu/domain/budget";
import { describe, expect, it } from "vitest";
import { createProfile, recordBalance } from "../core/commands.js";
import type { Store } from "../materialize.js";
import { runQuery } from "../query.js";
import { run, type TestEnv, testEnv } from "../testing/commands.js";
import { openTestStore } from "../testing/store.js";
import { removeBankAccount } from "./account-removal.js";
import {
  addCashExpense,
  importStatement,
  setMerchantCategory,
  setTransactionCategory,
} from "./commands.js";
import {
  accountBalances,
  budgetCategoryOptions,
  budgetSearch,
  budgetTransactionDetail,
  budgetTransactions,
  budgetUncategorizedCount,
  budgetUncategorizedRows,
  type CompanionMonthArgs,
  type CompanionTxnRow,
  companionMonth,
  payeeChargeHistories,
  recurringCharges,
} from "./companion-queries.js";

const TODAY = "2026-03-20";
const OWN_A = "PL10114000000000000000001234";
const OWN_B = "PL10124000000000000000003334";
const EURO = "PL10114000000000000000005678";

type Row = {
  readonly date: string;
  readonly amount: string;
  readonly name: string | null;
  readonly ref: string;
  readonly desc?: string;
  readonly iban?: string;
  readonly category?: string;
};

function vault() {
  const store = openTestStore();
  const env = testEnv();
  const created = run(store, env, createProfile, {
    slug: "synthetic-companion",
    name: "Synthetic companion",
    baseCurrency: "PLN",
    modules: ["budget"],
  });
  if (!created.ok) throw new Error("synthetic profile refused");
  return { store, env };
}

const gidOf = (store: Store, ref: string): string => {
  const gid = store.read<{ gid: string }>(
    "SELECT gid FROM transactions WHERE reference = ? AND dedup_hash NOT LIKE 'cashleg:%'",
    ref,
  )[0]?.gid;
  if (!gid) throw new Error(`missing synthetic transaction ${ref}`);
  return gid;
};

/** Imports `rows` into the account `number` and returns its gid. */
function ingest(
  store: Store,
  env: TestEnv,
  currency: string,
  number: string,
  rows: readonly Row[],
): string {
  const transactions: RawTransaction[] = rows.map((r) => ({
    bookingDate: r.date,
    valueDate: null,
    amount: D(r.amount),
    currency,
    counterpartyName: r.name,
    counterpartyIban: r.iban ?? null,
    description: r.desc ?? r.ref,
    reference: r.ref,
    bankTransactionId: null,
    source: "csv",
    raw: { synthetic: r.ref },
  }));
  const imported = run(store, env, importStatement, {
    statement: {
      bank: "mbank",
      accountNumber: number,
      accountName: `Synthetic ${number.slice(-4)}`,
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
    const claimed = run(store, env, setTransactionCategory, {
      txn: gidOf(store, row.ref),
      category: row.category,
    });
    if (!claimed.ok) throw new Error("synthetic category refused");
  }
  const account = store.read<{ gid: string }>(
    "SELECT gid FROM accounts WHERE iban = ? OR name = ?",
    number,
    `Synthetic ${number.slice(-4)}`,
  )[0]?.gid;
  if (!account) throw new Error("missing synthetic account");
  return account;
}

const payees = (rows: readonly CompanionTxnRow[]) => rows.map((r) => `${r.date} ${r.payee}`);

/** Three complete months (Dec-Feb) and a running March, two PLN accounts and one EUR account. */
function monthVault() {
  const { store, env } = vault();
  const history: Row[] = [];
  for (const [i, month] of ["2025-12", "2026-01", "2026-02"].entries()) {
    history.push(
      { date: `${month}-05`, amount: "-200.00", name: "BIEDRONKA", ref: `bied-${i}` },
      { date: `${month}-10`, amount: "5000.00", name: "ACME SP Z O O", ref: `pay-${i}` },
      { date: `${month}-15`, amount: "-150.00", name: "ORLEN", ref: `orlen-${i}` },
    );
  }
  const a = ingest(store, env, "PLN", OWN_A, [
    ...history,
    { date: "2026-03-03", amount: "-120.00", name: "BIEDRONKA", ref: "bied-mar" },
    { date: "2026-03-04", amount: "-500.00", name: "Own", ref: "own-out", iban: OWN_B },
    { date: "2026-03-10", amount: "5000.00", name: "ACME SP Z O O", ref: "pay-mar" },
    { date: "2026-03-12", amount: "-1284.00", name: "ORLEN", ref: "orlen-mar" },
    { date: "2026-03-14", amount: "-80.00", name: "FOOBAR SHOP", ref: "foobar" },
    { date: "2026-03-16", amount: "-300.00", name: "QUUX STUDIO", ref: "quux" },
  ]);
  const b = ingest(store, env, "PLN", OWN_B, [
    { date: "2026-03-04", amount: "500.00", name: "Own", ref: "own-in", iban: OWN_A },
  ]);
  const eur = ingest(store, env, "EUR", EURO, [
    { date: "2026-03-05", amount: "-10.00", name: "ZYX LISBOA", ref: "cafe" },
  ]);
  return { store, env, a, b, eur };
}

describe("companionMonth", () => {
  it("never averages a month an account's rows only partly cover", () => {
    const { store } = monthVault();
    try {
      // Account 3334's rows start on 03-04: December to February miss its rows (as the desktop norm).
      const m = companionMonth(store.read.bind(store), {
        today: TODAY,
        currency: "PLN",
        lang: "en",
      });
      expect([m.norm, m.normToDate, m.usualPayDay]).toEqual([null, null, null]);
      expect(m.spent).toEqual(D("1784.00"));
    } finally {
      store.close();
    }
  });

  it("figures the running month against the usual one, per currency", () => {
    const { store, env } = monthVault();
    try {
      // Both PLN accounts covered from 12-01 (an own transfer: no income, no spending).
      ingest(store, env, "PLN", OWN_A, [
        { date: "2025-12-01", amount: "-100.00", name: "Own", ref: "own-dec-out", iban: OWN_B },
      ]);
      ingest(store, env, "PLN", OWN_B, [
        { date: "2025-12-01", amount: "100.00", name: "Own", ref: "own-dec-in", iban: OWN_A },
      ]);
      const month = (args: Omit<CompanionMonthArgs, "today">) =>
        companionMonth(store.read.bind(store), { today: TODAY, ...args });
      const m = month({ currency: "PLN", lang: "en" });
      expect(m.month).toBe("2026-03");
      expect(m.complete).toBe(false);
      expect(m.monthEnd).toBe("2026-03-31");
      expect(m.daysLeft).toBe(11);
      expect(m.income).toEqual(D("5000.00"));
      expect(m.spent).toEqual(D("1784.00"));
      expect(m.billsDue).toEqual(D("0.00"));
      expect([m.norm?.income.toString(), m.norm?.expense.toString(), m.norm?.months]).toEqual([
        "5000.00",
        "350.00",
        3,
      ]);
      expect(m.normToDate?.toString()).toBe("350.00");
      expect(m.usualPayDay).toBe(10);
      expect(m.projection.keep).toEqual(D("3216.00"));
      expect(m.projection.incomeStillExpected.isZero()).toBe(true);
      expect(m.uncategorized.count).toBe(2);
      expect(m.uncategorized.sum).toEqual(D("380.00"));
      expect(m.uncategorized.largest).toMatchObject({
        payee: "QUUX STUDIO",
        date: "2026-03-16",
        amount: D("-300.00"),
      });
      expect(
        m.categories.map((c) => [c.category, c.label, c.amount.toString(), c.usual?.toString()]),
      ).toEqual([
        ["fuel", "Fuel", "1284.00", "150.00"],
        ["other", "Other", "380.00", undefined],
        ["groceries", "Groceries", "120.00", "200.00"],
      ]);
      expect(m.categories[0]?.share).toBeCloseTo(1284 / 1784, 10);
      expect(m.otherCurrencies).toEqual([{ currency: "EUR", spent: D("10.00") }]);

      const feb = month({ currency: "PLN", month: "2026-02", lang: "pl" });
      expect(feb.complete).toBe(true);
      expect(feb.daysLeft).toBe(0);
      expect(feb.spent).toEqual(D("350.00"));
      expect(feb.norm?.months).toBe(2);
      expect(feb.categories.map((c) => c.label)).toEqual(["Spożywcze", "Paliwo"]);
      expect(() => month({ currency: "PLN", month: "2026-13", lang: "pl" })).toThrow(RangeError);
    } finally {
      store.close();
    }
  });
});

describe("budgetTransactions", () => {
  it("lists newest first with filters, category narrowing and keyset pages", () => {
    const { store, env, b, eur } = monthVault();
    try {
      expect(
        run(store, env, addCashExpense, {
          amount: "12.00",
          title: "Synthetic coffee",
          category: "dining",
          onDate: "2026-03-18",
        }).ok,
      ).toBe(true);
      const list = (args: Parameters<typeof budgetTransactions.run>[1]) =>
        runQuery(store, budgetTransactions, args).value;
      const all = list({ filter: "all" });
      expect(all.rows).toHaveLength(18);
      expect(all.next).toBeNull();
      expect(runQuery(store, budgetUncategorizedCount, {}).value).toBe(3);
      expect(runQuery(store, budgetUncategorizedCount, { currency: "EUR" }).value).toBe(1);
      expect(
        runQuery(store, budgetUncategorizedCount, { month: "2026-03", currency: "PLN" }).value,
      ).toBe(2);
      expect(runQuery(store, budgetUncategorizedCount, { month: "2026-02" }).value).toBe(0);
      expect(payees(all.rows.slice(0, 4))).toEqual([
        "2026-03-18 Synthetic coffee",
        "2026-03-16 QUUX STUDIO",
        "2026-03-14 FOOBAR SHOP",
        "2026-03-12 ORLEN",
      ]);
      const coffee = all.rows[0];
      expect(coffee).toMatchObject({
        cash: true,
        category: "dining",
        categorySource: "manual_txn",
        title: null,
        uncategorized: false,
        account: { type: "cash" },
        merchantKey: "SYNTHETIC COFFEE",
      });
      const quux = all.rows[1];
      expect(quux).toMatchObject({
        category: null,
        categorySource: "default",
        uncategorized: true,
        suggested: false,
        title: "quux",
        merchantKey: "QUUX STUDIO",
      });
      expect(payees(list({ filter: "uncategorized" }).rows)).toEqual([
        "2026-03-16 QUUX STUDIO",
        "2026-03-14 FOOBAR SHOP",
        "2026-03-05 ZYX LISBOA",
      ]);
      const income = list({ filter: "income" }).rows;
      expect(income.map((r) => r.date)).toEqual([
        "2026-03-10",
        "2026-02-10",
        "2026-01-10",
        "2025-12-10",
      ]);
      expect(payees(list({ filter: "cash" }).rows)).toEqual(["2026-03-18 Synthetic coffee"]);
      const own = list({ filter: "account", account: b }).rows;
      expect(own).toHaveLength(1);
      expect(own[0]).toMatchObject({ internal: true, amount: D("500.00") });
      expect(list({ filter: "account" }).rows).toEqual([]);
      expect(list({ filter: "all", category: "fuel" }).rows.map((r) => r.amount)).toEqual([
        D("-1284.00"),
        D("-150.00"),
        D("-150.00"),
        D("-150.00"),
      ]);
      expect(list({ filter: "uncategorized", category: "other" }).rows).toEqual([]);

      const paged: CompanionTxnRow[] = [];
      let before = null as { date: string; gid: string } | null;
      for (let page = 0; page < 20; page++) {
        const got = list({ filter: "all", limit: 2, before });
        paged.push(...got.rows);
        if (got.next === null) break;
        before = got.next;
      }
      expect(paged.map((r) => r.gid)).toEqual(all.rows.map((r) => r.gid));

      expect(run(store, env, removeBankAccount, { account: eur }).ok).toBe(true);
      const after = list({ filter: "all" });
      expect(after.rows.some((r) => r.payee === "ZYX LISBOA")).toBe(false);
      expect(runQuery(store, budgetUncategorizedCount, {}).value).toBe(2);
    } finally {
      store.close();
    }
  });
});

/** Rows for search, detail and the uncategorized triage. */
function searchVault() {
  const { store, env } = vault();
  ingest(store, env, "PLN", OWN_A, [
    { date: "2025-05-10", amount: "-100.00", name: "ORLEN", ref: "orlen-1" },
    { date: "2026-01-05", amount: "-40.00", name: "FOOBAR SHOP", ref: "foobar-1" },
    { date: "2026-01-15", amount: "-1284.00", name: "ORLEN", ref: "orlen-2" },
    { date: "2026-02-01", amount: "-90.50", name: "ORLEN", ref: "orlen-3" },
    { date: "2026-02-02", amount: "-15.00", name: "Żabka Polska", ref: "zabka" },
    { date: "2026-02-03", amount: "-1284.50", name: "BIEDRONKA", ref: "bied" },
    { date: "2026-02-04", amount: "-5.00", name: null, ref: "fee", desc: "Opłata 50% rabatu" },
    { date: "2026-02-05", amount: "-45.00", name: "FOOBAR SHOP", ref: "foobar-2" },
    { date: "2026-02-06", amount: "-10.00", name: "QUUX STUDIO", ref: "quux" },
    { date: "2026-02-07", amount: "-300.00", name: "Own", ref: "own-out", iban: OWN_B },
  ]);
  const b = ingest(store, env, "PLN", OWN_B, [
    { date: "2026-02-07", amount: "300.00", name: "Own", ref: "own-in", iban: OWN_A },
  ]);
  return { store, env, b };
}

describe("budgetSearch", () => {
  it("matches every token in texts, merchant keys, category labels and amounts", () => {
    const { store } = searchVault();
    try {
      const search = (q: string) => runQuery(store, budgetSearch, { q, lang: "pl" }).value;
      const orlen = search("orlen");
      expect(orlen.total).toBe(3);
      expect(orlen.rows.map((r) => r.date)).toEqual(["2026-02-01", "2026-01-15", "2025-05-10"]);
      expect(orlen.summary).toMatchObject({ merchantKey: "ORLEN", count: 3, since: 2025 });
      expect(orlen.summary?.rows.map((r) => r.year)).toEqual([2026, 2026, 2025]);
      expect(search("1284").rows.map((r) => r.amount)).toEqual([D("-1284.50"), D("-1284.00")]);
      expect(search("1284").summary).toBeNull();
      expect(search("orlen 1284").rows.map((r) => r.amount)).toEqual([D("-1284.00")]);
      expect(search("1284,5").rows.map((r) => r.amount)).toEqual([D("-1284.50")]);
      expect(search("żabka").rows.map((r) => r.payee)).toEqual(["Żabka Polska"]);
      expect(search("ZABKA").total).toBe(1);
      expect(search("paliwo").total).toBe(3);
      expect(search("fuel").total).toBe(3);
      expect(search("50%").rows.map((r) => r.payee)).toEqual(["Opłata 50% rabatu"]);
      expect(search("5%").total).toBe(0);
      expect(search("   ")).toEqual({ rows: [], total: 0, summary: null });
      // the total and the shared merchant come from every hit, not only the page
      const page = runQuery(store, budgetSearch, { q: "orlen", lang: "en", limit: 1 }).value;
      expect(page).toMatchObject({ total: 3, rows: [{ date: "2026-02-01" }] });
      expect(page.summary?.count).toBe(3);
      // a single hit has no year-by-year summary
      expect(search("quux").summary).toBeNull();
    } finally {
      store.close();
    }
  });

  // M3 (FTS5 with a normalized text column): SQLite LOWER / LIKE fold ASCII only, so a diacritic word
  // found only in an upper-case statement text ("OPŁATA ZA ŚMIECI") is not found by "śmieci" unless
  // the merchant key carries it.
  it.todo("matches a diacritic word that is only in an upper-case description (OPŁATA ZA ŚMIECI)");
});

describe("budgetTransactionDetail", () => {
  it("shows the transfer counterpart, the batch and the merchant's earlier rows", () => {
    const { store, env, b } = searchVault();
    try {
      const detail = (ref: string) =>
        runQuery(store, budgetTransactionDetail, { txn: gidOf(store, ref), lang: "pl" }).value;
      const out = detail("own-out");
      expect(out?.row.internal).toBe(true);
      expect(out?.ibanTail).toBe("3334");
      expect(out?.transferCounterpart?.account.name).toBe("Synthetic 3334");
      expect(out?.batch?.source).toBe("csv");
      expect(out?.batch?.finishedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      const newest = detail("orlen-3");
      expect(newest?.sameMerchantCount).toBe(3);
      expect(newest?.earlier.map((r) => r.date)).toEqual(["2026-01-15", "2025-05-10"]);
      expect(newest?.transferCounterpart).toBeNull();
      expect(detail("orlen-1")?.earlier).toEqual([]);
      expect(detail("orlen-1")?.sameMerchantCount).toBe(3);
      expect(detail("fee")).toMatchObject({ row: { payee: "Opłata 50% rabatu", title: "fee" } });
      expect(
        runQuery(store, budgetTransactionDetail, { txn: "0".repeat(32), lang: "pl" }).value,
      ).toBeNull();
      // a removed account is out of the budget: never named as the other side
      expect(run(store, env, removeBankAccount, { account: b }).ok).toBe(true);
      expect(detail("own-out")?.transferCounterpart ?? null).toBeNull();
    } finally {
      store.close();
    }
  });

  it("names the merchant's rule, locked once the owner pins the merchant", () => {
    const { store, env } = searchVault();
    try {
      const detail = (ref: string) =>
        runQuery(store, budgetTransactionDetail, { txn: gidOf(store, ref), lang: "pl" }).value;
      expect(detail("quux")?.merchantRule).toBeNull();
      expect(detail("fee")?.merchantRule).toBeNull();
      const merchantKey = detail("quux")?.row.merchantKey;
      if (!merchantKey) throw new Error("synthetic row without a merchant key");
      expect(run(store, env, setMerchantCategory, { merchantKey, category: "gifts" }).ok).toBe(
        true,
      );
      expect(detail("quux")?.merchantRule).toEqual({ category: "gifts", locked: true });
    } finally {
      store.close();
    }
  });
});

describe("budgetUncategorizedRows", () => {
  it("suggests the merchant's newest decision, never one for a new merchant", () => {
    const { store, env } = searchVault();
    try {
      expect(
        run(store, env, setTransactionCategory, {
          txn: gidOf(store, "foobar-1"),
          category: "gifts",
        }).ok,
      ).toBe(true);
      const triage = runQuery(store, budgetUncategorizedRows, {}).value;
      expect(triage.total).toBe(3);
      expect(triage.rows.map((r) => [r.payee, r.suggestion])).toEqual([
        ["QUUX STUDIO", null],
        ["FOOBAR SHOP", "gifts"],
        ["Opłata 50% rabatu", null],
      ]);
      const one = runQuery(store, budgetUncategorizedRows, { limit: 1 }).value;
      expect([one.rows.length, one.total]).toEqual([1, 3]);
      // Today's month and currency: the rows and the total of that scope only
      const february = runQuery(store, budgetUncategorizedRows, {
        month: "2026-02",
        currency: "PLN",
      }).value;
      expect([february.rows.map((r) => r.payee), february.total]).toEqual([
        ["QUUX STUDIO", "FOOBAR SHOP", "Opłata 50% rabatu"],
        3,
      ]);
      expect(runQuery(store, budgetUncategorizedRows, { month: "2026-01" }).value.total).toBe(0);
      expect(runQuery(store, budgetUncategorizedRows, { currency: "EUR" }).value).toEqual({
        rows: [],
        total: 0,
      });
      expect(() => runQuery(store, budgetUncategorizedRows, { month: "2026-13" })).toThrow(
        RangeError,
      );
    } finally {
      store.close();
    }
  });
});

describe("budgetCategoryOptions", () => {
  it("orders expense keys by the last 12 months' use, then cash withdrawal, then income", () => {
    const { store, env } = vault();
    try {
      ingest(store, env, "PLN", OWN_A, [
        { date: "2024-01-05", amount: "-9.00", name: "ZOO", ref: "old", category: "gifts" },
        { date: "2025-06-05", amount: "-50.00", name: "ORLEN", ref: "o1" },
        { date: "2025-09-05", amount: "-50.00", name: "ORLEN", ref: "o2" },
        { date: "2026-02-05", amount: "-50.00", name: "ORLEN", ref: "o3" },
        { date: "2026-02-06", amount: "-20.00", name: "BIEDRONKA", ref: "b1" },
        { date: "2026-03-06", amount: "-20.00", name: "BIEDRONKA", ref: "b2" },
        { date: "2026-03-07", amount: "-30.00", name: "BAR", ref: "d1", category: "dining" },
      ]);
      const options = runQuery(store, budgetCategoryOptions, { today: TODAY, lang: "en" }).value;
      expect(options.slice(0, 4).map((o) => [o.key, o.uses, o.rank])).toEqual([
        ["fuel", 3, 0],
        ["groceries", 2, 1],
        ["dining", 1, 2],
        ["transport", 0, 3],
      ]);
      expect(options.find((o) => o.key === "gifts")?.uses).toBe(0);
      expect(options.slice(-4).map((o) => [o.key, o.kind])).toEqual([
        ["cash_withdrawal", "transfer"],
        ["income_salary", "income"],
        ["income_refund", "income"],
        ["income_other", "income"],
      ]);
      expect(options.some((o) => o.key === "transfer")).toBe(false);
      expect(options.map((o) => o.rank)).toEqual(options.map((_, i) => i));
      expect(options[0]?.label).toBe("Fuel");
    } finally {
      store.close();
    }
  });
});

describe("overview inputs", () => {
  it("recurring charges with their paying account, payee histories and account balances", () => {
    const { store, env } = vault();
    try {
      const a = ingest(
        store,
        env,
        "PLN",
        OWN_A,
        ["2025-11-03", "2025-12-03", "2026-01-03", "2026-02-03", "2026-03-03", "2026-04-03"].map(
          (date, i) => ({ date, amount: "-43.00", name: "NETFLIX.COM", ref: `nf-${i}` }),
        ),
      );
      ingest(store, env, "PLN", OWN_B, [
        { date: "2026-03-01", amount: "-1.00", name: "FEE", ref: "fee" },
      ]);
      const read = store.read.bind(store);
      const charges = recurringCharges(read, TODAY);
      expect(charges).toEqual([
        {
          key: "NETFLIX.COM:PLN:43.00",
          payee: "NETFLIX.COM",
          typicalAmount: D("43.00"),
          currency: "PLN",
          lastDate: "2026-03-03",
          medianGapDays: expect.any(Number),
          account: { id: a, name: "Synthetic 1234" },
        },
      ]);
      const [history] = payeeChargeHistories(read, TODAY);
      expect(history?.firstSeen).toBe("2025-11-03");
      expect(history?.charges.map((c) => [c.date, c.amount.toString()])).toEqual([
        ["2026-03-03", "43.00"],
        ["2026-02-03", "43.00"],
        ["2026-01-03", "43.00"],
        ["2025-12-03", "43.00"],
        ["2025-11-03", "43.00"],
      ]);

      expect(
        run(store, env, recordBalance, {
          account: a,
          date: "2026-03-19",
          amount: "1000.00",
          source: "csv",
        }).ok,
      ).toBe(true);
      expect(
        run(store, env, addCashExpense, {
          amount: "12.00",
          title: "Synthetic coffee",
          category: "dining",
          onDate: "2026-03-18",
        }).ok,
      ).toBe(true);
      expect(
        accountBalances(read, TODAY).map((b) => [b.name, b.currency, b.balance.toString()]),
      ).toEqual([
        ["Synthetic 1234", "PLN", "1000.00"],
        ["Gotówka", "PLN", "-12.00"],
      ]);
    } finally {
      store.close();
    }
  });
});
