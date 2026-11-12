/**
 * The running month projected to its end: what the month is on track to keep, from income so far, the
 * salary still expected, spending so far and the larger of the known charges still due and the usual
 * rest of a month. Plus the book-based inputs of that projection: the usual cumulative spending through
 * today's day of the month, the usual pay day and the usual spending per category, all over the same
 * whole, complete months `closedMonthNorm` averages (`normMonths`: an import's partial first month never
 * counts). One currency at a time, never summed across currencies.
 */

import { daysBetween, daysInMonth, type IsoDate, monthEnd, parseDate } from "../../dates.js";
import { D, type Decimal, ZERO } from "../../decimal.js";
import { type BudgetBook, bookOwnIbans, isFlow, yearMonth } from "./book.js";
import { cashflowCoverageStart, monthlyCashflow } from "./cashflow.js";
import { type MonthNorm, NORM_MONTHS, normMonths } from "./overview.js";

export interface MonthProjectionInput {
  readonly today: IsoDate;
  readonly currency: string;
  readonly incomeSoFar: Decimal;
  /** Positive magnitude. */
  readonly spentSoFar: Decimal;
  /** Known charges still to come this month (positive). */
  readonly billsDue: Decimal;
  /** `closedMonthNorm`: a usual month's income and spending. */
  readonly norm: MonthNorm | null;
  /** The usual cumulative spending through today's day of the month (`usualToDate`). */
  readonly normToDate: Decimal | null;
  /** Day of month of the usual salary (`usualPayDay`); null = unknown. */
  readonly usualPayDay: number | null;
}

export interface MonthProjection {
  /** On track to keep by the month's end. */
  readonly keep: Decimal;
  /** `incomeSoFar + incomeStillExpected`. */
  readonly expectedIncome: Decimal;
  /** The usual income not in yet while the usual pay day is still ahead; 0 otherwise. */
  readonly incomeStillExpected: Decimal;
  /** `max(0, norm.expense - normToDate)`, 0 without a norm. */
  readonly usualRest: Decimal;
  /** `max(billsDue, usualRest)`. */
  readonly remainingSpend: Decimal;
  /** Days from today to the month's end: the month's end counts, today does not. */
  readonly daysLeft: number;
  readonly monthEnd: IsoDate;
  /** Spending so far and the usual spending to date as shares of a usual month; null without a norm. */
  readonly pace: { readonly spentShare: number; readonly usualShare: number } | null;
  /** `spentSoFar - normToDate` (positive = over the usual), null without `normToDate`. */
  readonly vsUsual: Decimal | null;
}

const maxDecimal = (a: Decimal, b: Decimal): Decimal => (a.gte(b) ? a : b);

/** The running month projected to its end (see the file comment). */
export function monthProjection(input: MonthProjectionInput): MonthProjection {
  const { today, norm, normToDate, usualPayDay } = input;
  const day = parseDate(today).day;
  const incomeStillExpected =
    usualPayDay !== null && norm !== null && day < usualPayDay
      ? maxDecimal(ZERO, norm.income.sub(input.incomeSoFar))
      : ZERO;
  const expectedIncome = input.incomeSoFar.add(incomeStillExpected);
  const usualRest =
    norm !== null && normToDate !== null ? maxDecimal(ZERO, norm.expense.sub(normToDate)) : ZERO;
  const remainingSpend = maxDecimal(input.billsDue, usualRest);
  const end = monthEnd(today);
  const pace =
    norm !== null && normToDate !== null && !norm.expense.isZero()
      ? {
          spentShare: input.spentSoFar.div(norm.expense).toFloat(),
          usualShare: normToDate.div(norm.expense).toFloat(),
        }
      : null;
  return {
    keep: expectedIncome.sub(input.spentSoFar).sub(remainingSpend),
    expectedIncome,
    incomeStillExpected,
    usualRest,
    remainingSpend,
    daysLeft: daysBetween(today, end),
    monthEnd: end,
    pace,
    vsUsual: normToDate === null ? null : input.spentSoFar.sub(normToDate),
  };
}

/**
 * The labels ("YYYY-MM") of the norm months of `currency`: those `closedMonthNorm` averages over the
 * book's whole months (`cashflowCoverageStart`).
 */
function normLabels(book: BudgetBook, currency: string, today: IsoDate, n: number): string[] {
  return normMonths(
    monthlyCashflow(book, currency),
    cashflowCoverageStart(book, currency),
    today,
    n,
  ).map((r) => r.label);
}

/** The flow rows (`isFlow`: `monthlyCashflow`'s exclusions) of `currency` in the `labels` months. */
function flowRows(book: BudgetBook, currency: string, labels: ReadonlySet<string>) {
  const own = bookOwnIbans(book);
  return book.transactions.filter(
    (t) => t.currency === currency && labels.has(t.bookingDate.slice(0, 7)) && isFlow(t, own),
  );
}

/**
 * The usual cumulative spending (positive magnitude) through today's day of the month: the average over
 * the norm months of each month's spending through day `min(dayOf(today), daysIn(thatMonth))`. On the
 * last day of today's month every norm month counts in full (on 28 February the 29th to 31st of a longer
 * month are spent too: the usual rest of a month that ends today is 0). Null without norm months.
 */
export function usualToDate(
  book: BudgetBook,
  currency: string,
  today: IsoDate,
  n = NORM_MONTHS,
): Decimal | null {
  const labels = normLabels(book, currency, today, n);
  if (labels.length === 0) return null;
  const { year: thisYear, month: thisMonth, day } = parseDate(today);
  const lastDay = day === daysInMonth(thisYear, thisMonth);
  let total = ZERO;
  for (const t of flowRows(book, currency, new Set(labels))) {
    if (t.amount.gte(ZERO)) continue;
    const [year, month] = yearMonth(t.bookingDate);
    if (!lastDay && parseDate(t.bookingDate).day > Math.min(day, daysInMonth(year, month)))
      continue;
    total = total.add(t.amount.neg());
  }
  return total.div(D(String(labels.length)));
}

/**
 * The usual pay day: the median booking day of each norm month's largest income row (positive, not a
 * transfer; equal amounts: the earlier row). With an even number of months, the lower of the two middle
 * days. Null with fewer than 2 months that have income.
 */
export function usualPayDay(
  book: BudgetBook,
  currency: string,
  today: IsoDate,
  n = NORM_MONTHS,
): number | null {
  const labels = normLabels(book, currency, today, n);
  const largest = new Map<string, { amount: Decimal; date: IsoDate }>();
  for (const t of flowRows(book, currency, new Set(labels))) {
    if (!t.amount.gt(ZERO)) continue;
    const label = t.bookingDate.slice(0, 7);
    const seen = largest.get(label);
    const c = seen === undefined ? 1 : t.amount.compare(seen.amount);
    if (c > 0 || (c === 0 && seen !== undefined && t.bookingDate < seen.date)) {
      largest.set(label, { amount: t.amount, date: t.bookingDate });
    }
  }
  if (largest.size < 2) return null;
  const days = [...largest.values()].map((v) => parseDate(v.date).day).sort((a, b) => a - b);
  return days[Math.floor((days.length - 1) / 2)] as number;
}

/**
 * The usual monthly spending per category (positive magnitude; uncategorized = `other`, as in
 * `spendingByCategory`): each category's spending over the norm months divided by the number of norm
 * months (a month without spending in it counts 0). Largest first, equal amounts by category code.
 * Empty without norm months.
 */
export function categoryNorm(
  book: BudgetBook,
  currency: string,
  today: IsoDate,
  n = NORM_MONTHS,
): ReadonlyMap<string, Decimal> {
  const labels = normLabels(book, currency, today, n);
  const totals = new Map<string, Decimal>();
  for (const t of flowRows(book, currency, new Set(labels))) {
    if (t.amount.gte(ZERO)) continue;
    const cat = t.category || "other";
    totals.set(cat, (totals.get(cat) ?? ZERO).add(t.amount.neg()));
  }
  const count = D(String(labels.length));
  return new Map(
    [...totals]
      .map(([category, total]) => [category, total.div(count)] as const)
      .sort((a, b) => b[1].compare(a[1]) || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)),
  );
}
