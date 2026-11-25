// Budget analytics (analytics.py): the analytics halves of other Python budget tests, test-for-test.
// tests/test_api.py: test_cashflow, test_recurring, test_spending_all_time, test_spending_periods,
// test_category_transactions (on conftest.seed_demo, testing/seedDemo.ts); tests/test_cash.py:
// test_withdrawal_excluded_from_spending_and_cashflow, test_cash_expense_draws_pool_and_counts_as_spend
// (the spend half); tests/test_ingestion.py: test_internal_transfer_matching (the cashflow half),
// test_cashflow_excludes_own_account_transfer, test_categorization_and_spending and
// test_spending_by_quarter_and_year (the sums); tests/test_profiles.py: test_own_ibans_are_per_profile
// (the cashflow half); tests/test_upstream_bugs.py: test_b2_api_subscription_totals_per_currency (the
// recurring half). The API's `months` limit and response shapes are the API layer's (S38b / S55c).

import { describe, expect, it } from "vitest";
import { builtinRegistry } from "../../core/index.js";
import { D, type Decimal } from "../../decimal.js";
import { monthlyCashflow, referenceDate } from "./cashflow.js";
import { activeRecurring, recurringPayments, subscriptionExclusions } from "./recurring.js";
import { categoryTransactions, spendingByCategory, txnDetails } from "./spending.js";
import { Household } from "./testing/household.js";
import { seedDemo } from "./testing/seedDemo.js";

const s = (d: Decimal) => d.toString();
const NOT_SUBSCRIPTION = subscriptionExclusions(builtinRegistry());

describe("seed household views (test_api.py)", () => {
  it("test_cashflow", () => {
    const book = seedDemo().book();
    expect(
      monthlyCashflow(book).map((r) => [r.label, s(r.income), s(r.expense), s(r.net)]),
    ).toEqual([
      ["2026-06", "9000.00", "4523.75", "4476.25"],
      ["2026-07", "9000.00", "4527.75", "4472.25"],
      ["2026-08", "9000.00", "4586.75", "4413.25"],
      ["2026-09", "9000.00", "4275.75", "4724.25"],
    ]);
    const [eur] = monthlyCashflow(book, "EUR");
    expect(eur && [eur.label, s(eur.income), s(eur.expense), s(eur.net)]).toEqual([
      "2026-06",
      "500.00",
      "9.99",
      "490.01",
    ]);
  });

  it("test_recurring", () => {
    const h = seedDemo();
    const book = h.book();
    const items = recurringPayments(book, h.engineContext(), NOT_SUBSCRIPTION);
    // rent, the mortgage installment, the ATM withdrawal and the card fee are not listed (B2 fix)
    expect(new Set(items.map((c) => c.counterparty))).toEqual(
      new Set(["SPOTIFY TEST", "NETFLIX.COM", "KLUB SPORTOWY TEST"]),
    );
    const netflix = items.find((c) => c.counterparty === "NETFLIX.COM");
    expect(netflix && [s(netflix.typicalAmount), netflix.currency, netflix.occurrences]).toEqual([
      "43.00",
      "PLN",
      4,
    ]);
    expect(netflix && [netflix.medianGapDays, netflix.lastDate]).toEqual([31, "2026-09-07"]);
    expect(activeRecurring(items, book).map((c) => c.counterparty)).toContain("NETFLIX.COM");
    expect(items.find((c) => c.counterparty === "SPOTIFY TEST")?.currency).toBe("EUR");
    const lasts = items.map((c) => c.lastDate);
    expect(lasts).toEqual([...lasts].sort().reverse());
  });

  it("test_b2_api_subscription_totals_per_currency (the recurring half)", () => {
    const h = seedDemo();
    const book = h.book();
    const active = activeRecurring(
      recurringPayments(book, h.engineContext(), NOT_SUBSCRIPTION),
      book,
    );
    expect(
      new Set(active.map((c) => `${c.counterparty}|${c.currency}|${s(c.typicalAmount)}`)),
    ).toEqual(
      new Set(["NETFLIX.COM|PLN|43.00", "KLUB SPORTOWY TEST|PLN|139.00", "SPOTIFY TEST|EUR|9.99"]),
    );
  });

  it("active_recurring keeps what was seen within 45 days of the newest booking", () => {
    const h = seedDemo();
    const book = h.book();
    expect(referenceDate(book)).toBe("2026-09-28");
    const items = recurringPayments(book, h.engineContext(), NOT_SUBSCRIPTION);
    const old = { ...items[0], lastDate: "2026-08-13" } as (typeof items)[number];
    const edge = { ...items[0], lastDate: "2026-08-14" } as (typeof items)[number];
    expect(activeRecurring([old, edge], book)).toEqual([edge]);
    expect(activeRecurring([old], new Household().book())).toEqual([old]); // no rows: all of them
  });

  it("test_spending_all_time", () => {
    const rows = spendingByCategory(seedDemo().book());
    expect(rows.map((r) => [r.category, r.label, s(r.amount)])).toEqual([
      ["loans", "Raty kredytów", "12000.00"], // B2: was Subskrypcje
      ["housing", "Mieszkanie/Czynsz", "2600.00"],
      ["cash", "Gotówka", "900.00"],
      ["fuel", "Paliwo", "830.00"],
      ["groceries", "Spożywcze", "773.00"],
      ["subscriptions", "Subskrypcje", "728.00"],
      ["other", "Inne", "55.00"],
      ["fees", "Opłaty bankowe", "28.00"],
    ]);
  });

  it("test_spending_periods", () => {
    const book = seedDemo().book();
    const sep = spendingByCategory(book, null, { year: 2026, month: 9 });
    expect(Object.fromEntries(sep.map((r) => [r.category, s(r.amount)]))).toEqual({
      loans: "3000.00",
      subscriptions: "182.00",
      housing: "650.00",
      groceries: "227.75",
      fuel: "209.00",
      fees: "7.00",
    });
    const q3 = spendingByCategory(book, null, { year: 2026, quarter: 3 });
    expect(q3.find((r) => r.category === "housing")?.amount.toString()).toBe("1950.00");
    const eur = spendingByCategory(book, "EUR");
    expect(eur.map((r) => [r.category, r.label, s(r.amount)])).toEqual([
      ["subscriptions", "Subskrypcje", "39.96"],
    ]);
  });

  it("test_category_transactions", () => {
    const book = seedDemo().book();
    const sept = { year: 2026, month: 9 } as const;
    const rows = categoryTransactions(book, "groceries", null, { ...sept, sort: "amount" });
    expect(rows.map((r) => [r.date, s(r.amount), r.merchant, r.account])).toEqual([
      ["2026-09-06", "-109.50", "BIEDRONKA 123 TEST", "mKonto Test"],
      ["2026-09-20", "-78.25", "BIEDRONKA 123 TEST", "mKonto Test"],
      ["2026-09-16", "-40.00", "Targ Test", "Gotówka"],
    ]);
    expect(rows[0]?.categorySource).toBe("keyword");
    expect(rows[0]?.details).toBe("ZAKUP PRZY UZYCIU KARTY");
    expect(rows[2]?.categorySource).toBe("manual_txn");
    const byDate = categoryTransactions(book, "groceries", null, { ...sept, order: "asc" });
    expect(byDate.map((r) => r.date)).toEqual(["2026-09-06", "2026-09-16", "2026-09-20"]);
  });

  it("_txn_details skips the primary title and repeats nothing", () => {
    const row = seedDemo().find((t) => t.reference === "CZYNSZ");
    expect(txnDetails(row, "CZYNSZ")).toBe(
      "WSPOLNOTA MIESZKANIOWA TEST · PRZELEW WYCHODZACY · …0333",
    );
    expect(txnDetails({ ...row, bankTransactionId: "B-1" }, "WSPOLNOTA MIESZKANIOWA TEST")).toBe(
      "PRZELEW WYCHODZACY · …0333 · nr B-1",
    );
    const bare = { ...row, counterpartyName: null, description: null, counterpartyIban: null };
    expect(txnDetails(bare, "CZYNSZ")).toBeNull();
  });
});

describe("cash pool in the views (test_cash.py)", () => {
  function withdrawal(): { h: Household; key: string } {
    const h = new Household();
    const acc = h.account({ name: "mBank", iban: "PL10000000000000000000000001" });
    const [key] = h.ingest(acc, [
      {
        date: "2024-01-05",
        amount: "-200.00",
        ref: "WYPLATA W BANKOMACIE",
        desc: "WYPLATA W BANKOMACIE",
      },
    ]);
    h.categorize();
    return { h, key: key as string };
  }

  it("test_withdrawal_excluded_from_spending_and_cashflow", () => {
    const { h, key } = withdrawal();
    // before marking, it counts as a "cash" expense
    expect(spendingByCategory(h.book()).some((c) => c.category === "cash")).toBe(true);
    h.setCategory(key, "cash_withdrawal");
    const cats = new Set(spendingByCategory(h.book()).map((c) => c.category));
    expect(cats.has("cash") || cats.has("cash_withdrawal")).toBe(false);
    for (const mc of monthlyCashflow(h.book())) expect(s(mc.income)).toBe("0.00"); // the +200 leg
  });

  it("test_cash_expense_draws_pool_and_counts_as_spend (the spend half)", () => {
    const { h, key } = withdrawal();
    h.setCategory(key, "cash_withdrawal");
    h.cashExpense("2024-01-06", "50", "Obiad", "dining");
    const dining = spendingByCategory(h.book()).filter((c) => c.category === "dining");
    expect(dining.map((c) => s(c.amount))).toEqual(["50.00"]);
  });
});

describe("transfers and categories in the sums (test_ingestion.py, test_profiles.py)", () => {
  it("test_internal_transfer_matching (the cashflow half)", () => {
    const h = new Household();
    const mbankIban = "PL10000000000000000000000005";
    const ersteIban = "PL10000000000000000000000006";
    const mbank = h.account({ name: "mBank", iban: mbankIban });
    const erste = h.account({ name: "Erste", iban: ersteIban });
    h.ingest(mbank, [{ date: "2024-02-01", amount: "-1000.00", cp: "Erste", iban: ersteIban }]);
    h.ingest(erste, [{ date: "2024-02-02", amount: "1000.00", cp: "mBank", iban: mbankIban }]);
    h.categorize();
    const cashflow = monthlyCashflow(h.book());
    expect(cashflow.every((mc) => mc.income.isZero() && mc.expense.isZero())).toBe(true);
  });

  it("test_cashflow_excludes_own_account_transfer", () => {
    const h = new Household();
    const a = h.account({ name: "mBank", iban: "PL10000000000000000000000001" });
    h.account({ name: "Erste", iban: "PL10000000000000000000000004" });
    // a transfer to our OWN Erste account (unmatched as a pair, but the counterparty is own)
    h.ingest(a, [
      { date: "2026-03-05", amount: "-1000.00", iban: "10000000000000000000000004" },
      { date: "2026-03-06", amount: "-200.00", iban: "PL88888888888888888888888888" },
    ]);
    const mar = monthlyCashflow(h.book()).find((m) => m.label === "2026-03");
    expect(mar && s(mar.expense)).toBe("200.00"); // own-account transfer excluded, external kept
    // spending_by_category applies the same own-account filter (the rows are uncategorized: "other")
    expect(spendingByCategory(h.book()).map((c) => [c.category, s(c.amount)])).toEqual([
      ["other", "200.00"],
    ]);
    const all = monthlyCashflow(h.book(), null, true).find((m) => m.label === "2026-03");
    expect(all && s(all.expense)).toBe("1200.00"); // include_internal keeps it
  });

  it("test_categorization_and_spending (the sums)", () => {
    const h = new Household();
    const acc = h.account({ name: "mBank", iban: "PL10000000000000000000000001" });
    h.ingest(acc, [
      {
        date: "2026-05-02",
        amount: "-24.47",
        ref: "CARREFOUR EXPRESS K/KRAKOW  DATA TRANSAKCJI: 2026-05-02",
      },
      { date: "2026-05-03", amount: "-19.99", ref: "NETFLIX.COM" },
      { date: "2026-05-04", amount: "-50.00", ref: "JAKISTAM SKLEP XYZ" }, // unknown -> other
    ]);
    h.categorize();
    const may = () =>
      new Map(
        spendingByCategory(h.book(), null, { year: 2026, month: 5 }).map((c) => [
          c.category,
          s(c.amount),
        ]),
      );
    expect([may().get("groceries"), may().get("subscriptions"), may().get("other")]).toEqual([
      "24.47",
      "19.99",
      "50.00",
    ]);
    // the owner's merchant rule re-applies
    h.setRules([
      { merchantKey: "JAKISTAM SKLEP XYZ", category: "shopping", source: "manual", locked: true },
    ]);
    h.categorize();
    expect(may().get("shopping")).toBe("50.00");
    expect(may().has("other")).toBe(false);
  });

  it("test_spending_by_quarter_and_year (the sums)", () => {
    const h = new Household();
    const acc = h.account({ name: "mBank", iban: "PL10000000000000000000000001" });
    h.ingest(acc, [
      { date: "2026-05-02", amount: "-100", ref: "NETFLIX.COM" }, // Q2
      { date: "2026-08-02", amount: "-50", ref: "NETFLIX.COM" }, // Q3
    ]);
    h.categorize();
    const sub = (period: object) =>
      spendingByCategory(h.book(), null, period).find((c) => c.category === "subscriptions")
        ?.amount;
    expect(sub({ year: 2026, quarter: 2 })?.eq(D("100"))).toBe(true);
    expect(sub({ year: 2026, quarter: 3 })?.eq(D("50"))).toBe(true);
    expect(sub({ year: 2026 })?.eq(D("150"))).toBe(true);
  });

  it("test_own_ibans_are_per_profile (the cashflow half)", () => {
    // a transfer to an account of ANOTHER profile is a real outflow here: each book holds one profile
    const jan = new Household();
    const janAcc = jan.account({ name: "Jan", iban: "99114000000000000000000101" });
    jan.ingest(janAcc, [
      {
        date: "2026-09-01",
        amount: "-500.00",
        ref: "DLA OLI TEST",
        iban: "99109000000000000000000202",
      },
    ]);
    jan.categorize();
    const ola = new Household();
    const olaAcc = ola.account({ name: "Ola", iban: "99109000000000000000000202" });
    ola.ingest(olaAcc, [
      {
        date: "2026-09-01",
        amount: "500.00",
        ref: "OD JANA TEST",
        iban: "99114000000000000000000101",
      },
    ]);
    ola.categorize();
    const janTxn = jan.book().transactions[0];
    expect(janTxn?.category).not.toBe("transfer");
    expect(janTxn?.isInternalTransfer).toBe(false);
    expect(monthlyCashflow(jan.book())[0]?.expense.toString()).toBe("500.00");
    expect(monthlyCashflow(ola.book())[0]?.income.toString()).toBe("500.00");
  });
});
