/**
 * The month figures over monthly aggregates instead of every row: the same results as the book-based
 * `monthlyCashflow`, `cashflowCoverageStart`, `usualToDate`, `usualPayDay`, `usualSalary`,
 * `largestIncomeSoFar`, `categoryNorm`, `spendingByCategory` and `budgetCurrencies`, from per-(currency, month, category) and per-(currency,
 * month, day) sums the store keeps (`budget.months`), so a month read costs a few hundred aggregate
 * rows, not the vault's history. Every sum is an exact `Decimal` summed from 0 in the caller (never a
 * float), so a sum of sums equals the sum of the rows, its exponent included. One currency at a time,
 * never summed across currencies. The book-based functions stay the reference (desktop reads them).
 */

import type { UiLang } from "../../core/index.js";
import { ZERO_00 } from "../../core/index.js";
import { daysInMonth, type IsoDate, parseDate } from "../../dates.js";
import { D, type Decimal, ZERO } from "../../decimal.js";
import { categoryLabel, codePointCompare } from "../categorize/index.js";
import { inPeriod, monthLabel, type Period } from "./book.js";
import type { CurrencyUse, MonthlyCashflow } from "./cashflow.js";
import { NORM_MONTHS, normMonths } from "./overview.js";
import type { CategorySpend } from "./spending.js";

/**
 * One (currency, month, category) group of a book's rows (several accounts may each give one). The
 * flow sums cover the `isFlow` rows only (`monthlyCashflow`'s exclusions); `n` counts every row.
 */
export interface MonthCatRow {
  readonly currency: string;
  /** "YYYY-MM". */
  readonly month: string;
  /** The stored category; null when the rows have none. */
  readonly category: string | null;
  /** Flow inflows (amount >= 0), summed from 0. */
  readonly income: Decimal;
  /** Flow outflows as a positive magnitude, summed from 0 (0 exactly when there is none). */
  readonly expense: Decimal;
  /** Every row of the group. */
  readonly n: number;
  /** The flow rows (a month with one has a `monthlyCashflow` row, even when its sums are 0). */
  readonly flowN: number;
  /** Flow outflows with `category_source = 'default'` (the engine could not place them). */
  readonly uncategorizedN: number;
  /** Their positive magnitude, summed from 0. */
  readonly uncategorizedExpense: Decimal;
}

/** One (currency, month, day) group of a book's rows. */
export interface MonthDayRow {
  readonly currency: string;
  /** "YYYY-MM". */
  readonly month: string;
  /** Day of the month, 1-31. */
  readonly day: number;
  /** Every row of the day. */
  readonly n: number;
  /** Flow inflows (amount >= 0), summed from 0. */
  readonly income: Decimal;
  /** Flow outflows as a positive magnitude, summed from 0. */
  readonly expense: Decimal;
  /** The largest flow inflow above 0 (only its value counts); null without one. */
  readonly maxIncome: Decimal | null;
}

/** The earliest booking date of one account's rows in one currency. */
export interface AccountFirstBooking {
  readonly account: string;
  readonly currency: string;
  readonly first: IsoDate;
}

/** How many rows a currency has and their date range (several rows of one currency merge). */
export interface CurrencyCountRow {
  readonly currency: string;
  readonly transactions: number;
  readonly first: IsoDate;
  readonly last: IsoDate;
}

/**
 * The aggregates a "usual month" figure reads: the month groups and day groups of the months it may
 * need (any superset of the norm months works) and the first bookings of the counted accounts (not
 * removed, not a cash pool: `cashflowCoverageStart`'s accounts).
 */
export interface MonthAggregates {
  readonly cat: readonly MonthCatRow[];
  readonly day: readonly MonthDayRow[];
  readonly firsts: readonly AccountFirstBooking[];
}

function parseLabel(label: string): readonly [number, number] {
  return [Number(label.slice(0, 4)), Number(label.slice(5, 7))];
}

/** `monthlyCashflow(book, currency)` over the month groups. */
export function monthlyCashflowFromRows(
  rows: readonly MonthCatRow[],
  currency: string,
): MonthlyCashflow[] {
  const buckets = new Map<string, { income: Decimal; expense: Decimal }>();
  for (const r of rows) {
    if (r.currency !== currency || r.flowN === 0) continue;
    const b = buckets.get(r.month);
    if (b === undefined) {
      buckets.set(r.month, { income: ZERO_00.add(r.income), expense: ZERO_00.add(r.expense) });
    } else {
      b.income = b.income.add(r.income);
      b.expense = b.expense.add(r.expense);
    }
  }
  return [...buckets]
    .map(([label, b]) => {
      const [year, month] = parseLabel(label);
      return { year, month, b };
    })
    .sort((x, y) => x.year * 12 + x.month - (y.year * 12 + y.month))
    .map(({ year, month, b }) => ({
      year,
      month,
      label: monthLabel(year, month),
      income: b.income,
      expense: b.expense,
      net: b.income.sub(b.expense),
    }));
}

/**
 * `cashflowCoverageStart(book, currency)`: the latest first booking date among the counted accounts
 * with rows in `currency`; null without any.
 */
export function coverageStartFromRows(
  firsts: readonly AccountFirstBooking[],
  currency: string,
): IsoDate | null {
  const first = new Map<string, IsoDate>();
  for (const f of firsts) {
    if (f.currency !== currency) continue;
    const seen = first.get(f.account);
    if (seen === undefined || f.first < seen) first.set(f.account, f.first);
  }
  let start: IsoDate | null = null;
  for (const d of first.values()) if (start === null || d > start) start = d;
  return start;
}

/** The norm month labels of `currency` (`normMonths` over the aggregates). */
function normLabels(agg: MonthAggregates, currency: string, today: IsoDate, n: number): string[] {
  return normMonths(
    monthlyCashflowFromRows(agg.cat, currency),
    coverageStartFromRows(agg.firsts, currency),
    today,
    n,
  ).map((r) => r.label);
}

/** `usualToDate(book, currency, today, n)` over the aggregates. */
export function usualToDateFromRows(
  agg: MonthAggregates,
  currency: string,
  today: IsoDate,
  n = NORM_MONTHS,
): Decimal | null {
  const labels = new Set(normLabels(agg, currency, today, n));
  if (labels.size === 0) return null;
  const { year: thisYear, month: thisMonth, day } = parseDate(today);
  const lastDay = day === daysInMonth(thisYear, thisMonth);
  let total = ZERO;
  for (const r of agg.day) {
    if (r.currency !== currency || !labels.has(r.month) || r.expense.isZero()) continue;
    const [year, month] = parseLabel(r.month);
    if (!lastDay && r.day > Math.min(day, daysInMonth(year, month))) continue;
    total = total.add(r.expense);
  }
  return total.div(D(String(labels.size)));
}

/**
 * Each norm month's largest income (the day groups' `maxIncome`; equal amounts: the earlier day), as
 * `usualPayDay` and `usualSalary` take it from the rows.
 */
function largestIncomesFromRows(
  agg: MonthAggregates,
  currency: string,
  today: IsoDate,
  n: number,
): { amount: Decimal; day: number }[] {
  const labels = new Set(normLabels(agg, currency, today, n));
  const largest = new Map<string, { amount: Decimal; day: number }>();
  for (const r of agg.day) {
    if (r.currency !== currency || !labels.has(r.month) || r.maxIncome === null) continue;
    const seen = largest.get(r.month);
    const c = seen === undefined ? 1 : r.maxIncome.compare(seen.amount);
    if (c > 0 || (c === 0 && seen !== undefined && r.day < seen.day)) {
      largest.set(r.month, { amount: r.maxIncome, day: r.day });
    }
  }
  return [...largest.values()];
}

/** `usualPayDay(book, currency, today, n)` over the aggregates. */
export function usualPayDayFromRows(
  agg: MonthAggregates,
  currency: string,
  today: IsoDate,
  n = NORM_MONTHS,
): number | null {
  const largest = largestIncomesFromRows(agg, currency, today, n);
  if (largest.length < 2) return null;
  const days = largest.map((v) => v.day).sort((a, b) => a - b);
  return days[Math.floor((days.length - 1) / 2)] as number;
}

/**
 * `usualSalary(book, currency, today, n)` over the aggregates, equal by value (the day groups keep
 * only the largest income's value, not its exponent; the projection only compares it).
 */
export function usualSalaryFromRows(
  agg: MonthAggregates,
  currency: string,
  today: IsoDate,
  n = NORM_MONTHS,
): Decimal | null {
  const largest = largestIncomesFromRows(agg, currency, today, n);
  if (largest.length < 2) return null;
  const amounts = largest.map((v) => v.amount).sort((a, b) => a.compare(b));
  return amounts[Math.floor((amounts.length - 1) / 2)] as Decimal;
}

/**
 * `largestIncomeSoFar(book, currency, today)` over the day groups, equal by value: the largest
 * `maxIncome` of today's month through today's day; 0 without one. `day` MUST hold today's month's
 * day groups (the norm months' alone give 0).
 */
export function largestIncomeSoFarFromRows(
  day: readonly MonthDayRow[],
  currency: string,
  today: IsoDate,
): Decimal {
  const label = today.slice(0, 7);
  const through = parseDate(today).day;
  let max = ZERO;
  for (const r of day) {
    if (r.currency !== currency || r.month !== label || r.day > through) continue;
    if (r.maxIncome?.gt(max)) max = r.maxIncome;
  }
  return max;
}

/** `categoryNorm(book, currency, today, n)` over the aggregates. */
export function categoryNormFromRows(
  agg: MonthAggregates,
  currency: string,
  today: IsoDate,
  n = NORM_MONTHS,
): ReadonlyMap<string, Decimal> {
  const labels = new Set(normLabels(agg, currency, today, n));
  const totals = new Map<string, Decimal>();
  for (const r of agg.cat) {
    if (r.currency !== currency || !labels.has(r.month) || r.expense.isZero()) continue;
    const cat = r.category || "other";
    totals.set(cat, (totals.get(cat) ?? ZERO).add(r.expense));
  }
  const count = D(String(labels.size));
  return new Map(
    [...totals]
      .map(([category, total]) => [category, total.div(count)] as const)
      .sort((a, b) => b[1].compare(a[1]) || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)),
  );
}

/**
 * `spendingByCategory(book, currency, period, lang)` over the month groups. Equal totals keep the
 * book's first-seen order, so `rows` MUST come in the book order of each group's first flow outflow
 * (the store: by account, then by its first outflow row).
 */
export function spendingByCategoryFromRows(
  rows: readonly MonthCatRow[],
  currency: string,
  period: Period = {},
  lang: UiLang = "pl",
): CategorySpend[] {
  const buckets = new Map<string, Decimal>();
  for (const r of rows) {
    if (r.currency !== currency || r.expense.isZero() || !inPeriod(`${r.month}-01`, period)) {
      continue;
    }
    const cat = r.category || "other";
    buckets.set(cat, (buckets.get(cat) ?? ZERO_00).add(r.expense));
  }
  const out = [...buckets].map(([category, amount]) => ({
    category,
    label: categoryLabel(category, lang),
    amount,
  }));
  return out.sort((a, b) => b.amount.compare(a.amount));
}

/** `budgetCurrencies(book)` over per-currency counts (rows of one currency merge). */
export function currenciesFromRows(
  rows: readonly CurrencyCountRow[],
  baseCurrency: string,
): CurrencyUse[] {
  const uses = new Map<string, { n: number; first: IsoDate; last: IsoDate }>();
  for (const r of rows) {
    const u = uses.get(r.currency);
    if (u === undefined) {
      uses.set(r.currency, { n: r.transactions, first: r.first, last: r.last });
    } else {
      u.n += r.transactions;
      if (r.first < u.first) u.first = r.first;
      if (r.last > u.last) u.last = r.last;
    }
  }
  const out: CurrencyUse[] = [];
  for (const [currency, u] of uses) {
    if (currency) out.push({ currency, transactions: u.n, first: u.first, last: u.last });
  }
  return out.sort(
    (a, b) =>
      Number(a.currency !== baseCurrency) - Number(b.currency !== baseCurrency) ||
      b.transactions - a.transactions ||
      codePointCompare(a.currency, b.currency),
  );
}
