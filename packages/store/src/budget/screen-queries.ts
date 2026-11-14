// Read models shared by the read-only money screens. The S10 analytics run in the store, over this
// vault's real BudgetBook; display hooks receive exact Decimals, never pre-rounded chart numbers.
import { budget, D, type Decimal, type IsoDate } from "@cashu/domain";
import { defineQuery } from "../query.js";
import { budgetBook } from "./read-models.js";

/** Explicit calendar context. It does not invent a booking-date cutoff for the S10 analytics. */
export type BudgetScreenDay = { readonly today: IsoDate };

/** Each supplied part must match, as in S10. An empty object means every period. */
export type BudgetScreenPeriod = {
  readonly year?: number | null;
  readonly month?: number | null;
  readonly quarter?: number | null;
};

export type BudgetScreenArgs = BudgetScreenDay & {
  readonly currency: string;
  readonly period: BudgetScreenPeriod;
};

export type BudgetSpendingScreenArgs = BudgetScreenArgs & { readonly lang: "pl" | "en" };

export interface BudgetCurrenciesScreen {
  readonly today: IsoDate;
  readonly baseCurrency: string;
  readonly currencies: readonly budget.CurrencyUse[];
  /** Newest booking date, not a replacement for the caller's actual calendar day. */
  readonly referenceDate: IsoDate | null;
}

export interface BudgetCashflowScreen {
  readonly today: IsoDate;
  readonly currency: string;
  readonly period: BudgetScreenPeriod;
  readonly rows: readonly budget.MonthlyCashflow[];
}

export interface BudgetSpendingScreen {
  readonly today: IsoDate;
  readonly currency: string;
  readonly period: BudgetScreenPeriod;
  readonly rows: readonly budget.CategorySpend[];
  /** Exact sum in this one currency only. */
  readonly total: Decimal;
}

export const budgetScreenCurrencies = defineQuery({
  id: "budget.screenCurrencies",
  run(read, args: BudgetScreenDay): BudgetCurrenciesScreen {
    const book = budgetBook(read);
    return {
      today: args.today,
      baseCurrency: book.baseCurrency,
      currencies: budget.budgetCurrencies(book),
      referenceDate: budget.referenceDate(book),
    };
  },
});

export const budgetScreenCashflow = defineQuery({
  id: "budget.screenCashflow",
  run(read, args: BudgetScreenArgs): BudgetCashflowScreen {
    const book = budgetBook(read);
    // Match the domain's empty-currency fallback and report the actual selected unit.
    const currency = args.currency || book.baseCurrency;
    const rows = budget
      .monthlyCashflow(book, currency)
      .filter((row) => budget.inPeriod(`${row.label}-01`, args.period));
    return { today: args.today, currency, period: args.period, rows };
  },
});

export const budgetScreenSpending = defineQuery({
  id: "budget.screenSpending",
  run(read, args: BudgetSpendingScreenArgs): BudgetSpendingScreen {
    const book = budgetBook(read);
    const currency = args.currency || book.baseCurrency;
    const rows = budget.spendingByCategory(book, currency, args.period, args.lang);
    return {
      today: args.today,
      currency,
      period: args.period,
      rows,
      total: rows.reduce((total, row) => total.add(row.amount), D("0.00")),
    };
  },
});
