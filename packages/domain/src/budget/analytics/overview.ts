/**
 * The budget half of the overview: the month and subscriptions of the shell summary (`GET /summary`
 * of `api/app.py`) and the spending norm of complete months the SPA's ratios divide by
 * (`frontend/src/core/util.ts` `closedMonthNorm`, F7 FE10). Per currency, never summed across
 * currencies.
 */

import type { IsoDate } from "../../dates.js";
import { D, type Decimal, ZERO } from "../../decimal.js";
import type { RecurringCandidate } from "../categorize/index.js";
import { type MonthlyCashflow, wholeMonths } from "./cashflow.js";

export interface MonthSummary {
  readonly label: string;
  readonly income: Decimal;
  readonly expense: Decimal;
  readonly net: Decimal;
}

/** `summary.month`: the newest month of the base-currency cashflow, null without any. */
export function monthSummary(cashflow: readonly MonthlyCashflow[]): MonthSummary | null {
  const m = cashflow[cashflow.length - 1];
  return m === undefined
    ? null
    : { label: m.label, income: m.income, expense: m.expense, net: m.net };
}

export interface SubscriptionsSummary {
  readonly count: number;
  /** The PLN total only (the legacy dashboard's field); 0 without PLN subscriptions. */
  readonly monthlyTotal: Decimal;
  /** Typical monthly amount per currency, currencies in code order, never summed across them. */
  readonly monthlyTotals: Readonly<Record<string, Decimal>>;
}

/** `summary.subscriptions` over the active recurring payments. */
export function subscriptionsSummary(active: readonly RecurringCandidate[]): SubscriptionsSummary {
  const totals = new Map<string, Decimal>();
  for (const c of active)
    totals.set(c.currency, (totals.get(c.currency) ?? ZERO).add(c.typicalAmount));
  const monthlyTotals: Record<string, Decimal> = {};
  for (const k of [...totals.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
    monthlyTotals[k] = totals.get(k) as Decimal;
  }
  return { count: active.length, monthlyTotal: totals.get("PLN") ?? ZERO, monthlyTotals };
}

/** How many complete months the norm averages by default. */
export const NORM_MONTHS = 6;

export interface MonthNorm {
  /** Average monthly income of the months taken. */
  readonly income: Decimal;
  /** Average monthly spending (positive magnitude) of the months taken. */
  readonly expense: Decimal;
  /** How many months the averages cover (1 to `n`). */
  readonly months: number;
}

/**
 * The months a norm averages: up to `n` whole, complete months before `today`'s month that have income
 * or spending, oldest first. Whole: a month starting before `coverageStart` (`cashflowCoverageStart`)
 * misses some account's rows (the first month of an Open Banking import begins mid-month) and never
 * counts; null = every month is whole. The running month never counts either (early in a month its
 * spending is a few days' worth and the salary may not be in). The one rule every "usual month" figure
 * shares: `closedMonthNorm`, `usualToDate`, `usualPayDay`, `categoryNorm`.
 */
export function normMonths(
  rows: readonly MonthlyCashflow[],
  coverageStart: IsoDate | null,
  today: IsoDate,
  n = NORM_MONTHS,
): MonthlyCashflow[] {
  const current = today.slice(0, 7);
  return wholeMonths(rows, coverageStart)
    .filter((r) => r.label < current && !(r.income.isZero() && r.expense.isZero()))
    .slice(-n);
}

/**
 * The monthly income / spending norm: the average of the norm months (`normMonths`). `coverageStart`
 * drops the months an import only partly covers; a caller that passes rows already cut to whole months
 * (`wholeMonths`) leaves it null. Null when no norm month has data.
 */
export function closedMonthNorm(
  rows: readonly MonthlyCashflow[] | null | undefined,
  today: IsoDate,
  n = NORM_MONTHS,
  coverageStart: IsoDate | null = null,
): MonthNorm | null {
  const closed = normMonths(rows ?? [], coverageStart, today, n);
  if (closed.length === 0) return null;
  const count = D(String(closed.length));
  let income = ZERO;
  let expense = ZERO;
  for (const r of closed) {
    income = income.add(r.income);
    expense = expense.add(r.expense.abs());
  }
  return { income: income.div(count), expense: expense.div(count), months: closed.length };
}
