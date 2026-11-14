/**
 * Monthly cashflow and the budget currencies (`modules/budget/analytics.py`). Internal transfers
 * (money moved between the profile's own accounts) are never income or expense; each currency stays
 * on its own, never summed or converted.
 */

import { ZERO_00 } from "../../core/index.js";
import type { IsoDate } from "../../dates.js";
import { type Decimal, ZERO } from "../../decimal.js";
import { codePointCompare } from "../categorize/index.js";
import {
  type BudgetBook,
  bookOwnIbans,
  isOwnCounterparty,
  monthLabel,
  NON_SPENDING_CATEGORIES,
  yearMonth,
} from "./book.js";

export interface MonthlyCashflow {
  readonly year: number;
  readonly month: number;
  /** `f"{year}-{month:02d}"`. */
  readonly label: string;
  readonly income: Decimal;
  /** Positive magnitude. */
  readonly expense: Decimal;
  /** `income - expense`. */
  readonly net: Decimal;
}

/**
 * `monthly_cashflow`: income and expense per calendar month in one currency (the base currency when
 * none is given), months ascending. Structural categories are always skipped; internal transfers and
 * own-account counterparties too unless `includeInternal`.
 */
export function monthlyCashflow(
  book: BudgetBook,
  currency: string | null = null,
  includeInternal = false,
): MonthlyCashflow[] {
  const cur = currency || book.baseCurrency;
  const own = bookOwnIbans(book);
  const buckets = new Map<
    number,
    { year: number; month: number; income: Decimal; expense: Decimal }
  >();
  for (const t of book.transactions) {
    if (t.currency !== cur) continue;
    if (t.category !== null && NON_SPENDING_CATEGORIES.has(t.category)) continue;
    if (!includeInternal && (t.isInternalTransfer || isOwnCounterparty(t, own))) continue;
    const [year, month] = yearMonth(t.bookingDate);
    const key = year * 12 + month;
    let b = buckets.get(key);
    if (b === undefined) {
      b = { year, month, income: ZERO_00, expense: ZERO_00 };
      buckets.set(key, b);
    }
    if (t.amount.gte(ZERO)) b.income = b.income.add(t.amount);
    else b.expense = b.expense.add(t.amount.neg());
  }
  return [...buckets.keys()]
    .sort((a, b) => a - b)
    .map((k) => {
      const b = buckets.get(k) as {
        year: number;
        month: number;
        income: Decimal;
        expense: Decimal;
      };
      return {
        year: b.year,
        month: b.month,
        label: monthLabel(b.year, b.month),
        income: b.income,
        expense: b.expense,
        net: b.income.sub(b.expense),
      };
    });
}

/**
 * The first day from which every bank account with transactions in `currency` (the base currency when
 * none is given) has them: the latest first booking date among those accounts. The cash pool is derived
 * from bank rows and removed accounts are gone, so neither counts. A month that starts before this day
 * misses some account's rows: the first month of an import (Open Banking reaches ~90 days back, so the
 * first month begins mid-month, often after the salary) or the months before an account's history
 * starts. null without transactions.
 */
export function cashflowCoverageStart(
  book: BudgetBook,
  currency: string | null = null,
): IsoDate | null {
  const cur = currency || book.baseCurrency;
  const counted = new Set(
    book.accounts.filter((a) => a.removedAt === null && a.type !== "cash").map((a) => a.id),
  );
  const first = new Map<string, IsoDate>();
  for (const t of book.transactions) {
    if (t.currency !== cur || !counted.has(t.account)) continue;
    const seen = first.get(t.account);
    if (seen === undefined || t.bookingDate < seen) first.set(t.account, t.bookingDate);
  }
  let start: IsoDate | null = null;
  for (const d of first.values()) if (start === null || d > start) start = d;
  return start;
}

/** The rows of whole months: those starting on or after `start` (`cashflowCoverageStart`). */
export function wholeMonths(
  rows: readonly MonthlyCashflow[],
  start: IsoDate | null,
): MonthlyCashflow[] {
  return start === null ? [...rows] : rows.filter((r) => `${r.label}-01` >= start);
}

/**
 * The savings rate of whole, closed months (before `today`'s month), the last `n` of them: their
 * surplus over their income, both summed (a mean of monthly ratios lets one month with almost no
 * income swing it by thousands of percent). null below 2 such months or without income.
 */
export function averageSavingsRate(
  rows: readonly MonthlyCashflow[],
  start: IsoDate | null,
  today: IsoDate,
  n = 6,
): Decimal | null {
  const closed = wholeMonths(rows, start)
    .filter((r) => r.label < today.slice(0, 7))
    .slice(-n);
  if (closed.length < 2) return null;
  let income = ZERO_00;
  let net = ZERO_00;
  for (const r of closed) {
    income = income.add(r.income);
    net = net.add(r.net);
  }
  return income.gt(ZERO) ? net.div(income) : null;
}

export interface CurrencyUse {
  readonly currency: string;
  readonly transactions: number;
  readonly first: IsoDate;
  readonly last: IsoDate;
}

/**
 * `budget_currencies`: the currencies the profile has transactions in: the base currency first (when it
 * has data), then by number of transactions, then by code. A row with an empty currency is skipped.
 */
export function budgetCurrencies(book: BudgetBook): CurrencyUse[] {
  const uses = new Map<string, { n: number; first: IsoDate; last: IsoDate }>();
  for (const t of book.transactions) {
    const u = uses.get(t.currency);
    if (u === undefined) {
      uses.set(t.currency, { n: 1, first: t.bookingDate, last: t.bookingDate });
    } else {
      u.n++;
      if (t.bookingDate < u.first) u.first = t.bookingDate;
      if (t.bookingDate > u.last) u.last = t.bookingDate;
    }
  }
  const base = book.baseCurrency;
  const out: CurrencyUse[] = [];
  for (const [currency, u] of uses) {
    if (currency) out.push({ currency, transactions: u.n, first: u.first, last: u.last });
  }
  return out.sort(
    (a, b) =>
      Number(a.currency !== base) - Number(b.currency !== base) ||
      b.transactions - a.transactions ||
      codePointCompare(a.currency, b.currency),
  );
}

/** `reference_date`: the profile's newest booking date (a proxy for "now"), null without rows. */
export function referenceDate(book: BudgetBook): IsoDate | null {
  let ref: IsoDate | null = null;
  for (const t of book.transactions) if (ref === null || t.bookingDate > ref) ref = t.bookingDate;
  return ref;
}

/** `monthclose._month_bounds`: labels of the oldest and newest months with data. */
export function monthBounds(book: BudgetBook): readonly [string | null, string | null] {
  let first: IsoDate | null = null;
  let last: IsoDate | null = null;
  for (const t of book.transactions) {
    if (first === null || t.bookingDate < first) first = t.bookingDate;
    if (last === null || t.bookingDate > last) last = t.bookingDate;
  }
  const label = (d: IsoDate | null) => (d === null ? null : monthLabel(...yearMonth(d)));
  return [label(first), label(last)];
}
