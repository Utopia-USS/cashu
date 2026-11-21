// Budget views for any base currency (analytics.py, monthclose.py): translates tests/test_budget_currency.py
// test-for-test: a EUR-only household and the mixed PLN + EUR seed. Every view defaults to the profile's
// base currency, lists each currency on its own and never sums currencies. Not here: the uncategorized
// list (S38b), the overview KPI (S06b), the cash pool endpoints and the picker's `default` field (the
// API picks the first `budgetCurrencies` entry), all of which read these same functions.

import { describe, expect, it } from "vitest";
import { D, type Decimal } from "../../decimal.js";
import type { BudgetBook } from "./book.js";
import { budgetCurrencies, monthlyCashflow } from "./cashflow.js";
import { monthClose } from "./monthClose.js";
import { monthCloseView } from "./monthCloseView.js";
import { defaultBudgetSettings } from "./settings.js";
import { categoryTransactions, spendingByCategory } from "./spending.js";
import { Household, type Raw } from "./testing/household.js";
import { seedDemo } from "./testing/seedDemo.js";

const s = (d: Decimal) => d.toString();
const IBAN_ANNA = "99114000000000000000000901";
const IBAN_EMPLOYER_EU = "99102000000000000000000902";
const IBAN_LANDLORD = "99105000000000000000000903";

/** `seed_eur_household`: three months of a EUR-only household (invented numbers). */
function eurHousehold(base: string): Household {
  const h = new Household(base);
  const acc = h.account({ name: "Konto EUR Test", iban: IBAN_ANNA, currency: "EUR" });
  const raw = (date: string, amount: string, ref: string, extra: Partial<Raw> = {}): Raw => ({
    date,
    amount,
    ref,
    desc: ref,
    currency: "EUR",
    ...extra,
  });
  const rows: Raw[] = [];
  for (const m of [7, 8, 9]) {
    const mm = String(m).padStart(2, "0");
    rows.push(
      raw(`2026-${mm}-01`, "3200.00", `GEHALT ${mm} TEST`, { iban: IBAN_EMPLOYER_EU }),
      raw(`2026-${mm}-03`, "-950.00", "CZYNSZ", { cp: "LANDLORD TEST", iban: IBAN_LANDLORD }),
      raw(`2026-${mm}-06`, `-${80 + m}.40`, "BIEDRONKA 123 TEST"),
      raw(`2026-${mm}-20`, "-45.00", "ORLEN STACJA TEST"),
    );
  }
  rows.push(raw("2026-09-25", "-12.00", "SKLEP NIEZNANY EU TEST"));
  h.ingest(acc, rows);
  h.categorize();
  return h;
}

function closeOf(book: BudgetBook, h: Household) {
  return monthCloseView(
    monthClose(book, {
      year: 2026,
      month: 9,
      today: "2026-10-15",
      settings: defaultBudgetSettings(),
      env: h.env(),
      investmentsEnabled: false,
      planned: null,
    }),
  );
}

describe("a EUR-only household", () => {
  it("test_eur_only_profile_sees_its_budget_without_a_currency_parameter", () => {
    const book = eurHousehold("EUR").book();
    const flows = monthlyCashflow(book);
    expect(flows.map((r) => r.label)).toEqual(["2026-07", "2026-08", "2026-09"]);
    const last = flows.at(-1);
    expect(last && [last.label, s(last.income), s(last.expense), s(last.net)]).toEqual([
      "2026-09",
      "3200.00",
      "1096.40",
      "2103.60",
    ]);
    expect(monthlyCashflow(book, "PLN")).toEqual([]);

    const spend = new Map(
      spendingByCategory(book, null, { year: 2026, month: 9 }).map((r) => [r.category, r.amount]),
    );
    expect([spend.get("housing"), spend.get("groceries"), spend.get("fuel")].map(String)).toEqual([
      "950.00",
      "89.40",
      "45.00",
    ]);
    let total = D("0");
    for (const v of spend.values()) total = total.add(v);
    expect(s(total)).toBe("1096.40");

    const drill = categoryTransactions(book, "groceries");
    expect(drill).toHaveLength(3);
    expect(new Set(drill.map((r) => r.currency))).toEqual(new Set(["EUR"]));
  });

  it("test_eur_profile_currency_list_and_cash_pool (the currency list)", () => {
    const cur = budgetCurrencies(eurHousehold("EUR").book());
    expect(cur.map((c) => [c.currency, c.first, c.last])).toEqual([
      ["EUR", "2026-07-01", "2026-09-25"],
    ]);
  });

  it("test_eur_profile_month_close", () => {
    const h = eurHousehold("EUR");
    const close = closeOf(h.book(), h);
    expect([close.month, close.baseCurrency, close.firstMonth, close.lastMonth]).toEqual([
      "2026-09",
      "EUR",
      "2026-07",
      "2026-09",
    ]);
    expect(close.investing).toBeNull();
    expect(close.cushion).toBeNull();
    expect(close.currencies).toHaveLength(1);
    const [eur] = close.currencies;
    expect(eur && [eur.currency, s(eur.income), s(eur.spending), s(eur.surplus)]).toEqual([
      "EUR",
      "3200.00",
      "1096.40",
      "2103.60",
    ]);
    expect(eur && [s(eur.suggestedTransfer), s(eur.cushionTopUp)]).toEqual(["2103.60", "0.00"]);
    expect(eur?.spendingByCategory[0]).toEqual({
      category: "housing",
      label: "Mieszkanie/Czynsz",
      amount: D("950.00"),
    });
  });

  it("test_a_profile_with_only_foreign_data_defaults_to_its_data_currency", () => {
    // base PLN, only EUR transactions: the views still answer in the base currency unless asked
    const book = eurHousehold("PLN").book();
    expect(budgetCurrencies(book).map((c) => c.currency)).toEqual(["EUR"]); // the picker's default
    expect(monthlyCashflow(book)).toEqual([]);
    expect(monthlyCashflow(book, "EUR")).toHaveLength(3);
  });
});

describe("the mixed PLN + EUR household", () => {
  it("test_mixed_profile_lists_each_currency_on_its_own", () => {
    const book = seedDemo().book();
    expect(budgetCurrencies(book).map((c) => c.currency)).toEqual(["PLN", "EUR"]);
    const eur = spendingByCategory(book, "EUR");
    expect(eur.map((r) => s(r.amount))).toEqual(["39.96"]); // 4 x 9.99, nothing from PLN
    const pln = spendingByCategory(book);
    let total = D("0");
    for (const r of pln) total = total.add(r.amount);
    expect(total.gt(D("10000"))).toBe(true);
    expect(pln.every((r) => !r.amount.eq(D("9.99")))).toBe(true);
    expect(monthlyCashflow(book)).toEqual(monthlyCashflow(book, "PLN"));
  });

  it("test_mixed_profile_month_close_matches_the_cashflow_and_spending_views", () => {
    const h = seedDemo();
    const book = h.book();
    const close = closeOf(book, h);
    expect(close.currencies.map((c) => c.currency)).toEqual(["PLN", "EUR"]);
    for (const c of close.currencies) {
      const flow = monthlyCashflow(book, c.currency).find((r) => r.label === "2026-09");
      expect([s(c.income), s(c.spending), s(c.surplus)]).toEqual(
        flow ? [s(flow.income), s(flow.expense), s(flow.net)] : [],
      );
      const spend = spendingByCategory(book, c.currency, { year: 2026, month: 9 });
      expect(c.spendingByCategory.map((r) => [r.category, s(r.amount)])).toEqual(
        spend.map((r) => [r.category, s(r.amount)]),
      );
    }
    const [pln, eur] = close.currencies;
    // September, PLN: salary 9000; rent 650, installment 3000, groceries 109.50 + 78.25 + 40 (cash),
    // sports club 139, Netflix 43, fuel 209, card fee 7; the savings transfer and the ATM withdrawal
    // moved into the cash pool are not spending
    expect(pln && [s(pln.income), s(pln.spending), s(pln.surplus)]).toEqual([
      "9000.00",
      "4275.75",
      "4724.25",
    ]);
    expect(eur && [s(eur.income), s(eur.spending), s(eur.surplus)]).toEqual([
      "0.00",
      "9.99",
      "-9.99",
    ]);
    expect(eur && s(eur.suggestedTransfer)).toBe("0.00"); // never below zero
  });
});
