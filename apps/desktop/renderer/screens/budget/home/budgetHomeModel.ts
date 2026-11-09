// Pure parts of the merged budget screen (design/desktop/budget/one-screen.html): the one period state (mode + an
// anchor month), the period groups the chart and the hero read, the chart window and its ticks, the average a
// month is compared with, and the subscription figures (monthly cost, next charge). No React, no store.
import { D, type Decimal, type IsoDate } from "@cashu/domain";

export type PeriodMode = "month" | "quarter" | "year" | "all";

/** A month as one number: year * 12 + (month - 1). */
export type MonthIndex = number;

/** "2026-10" -> its index; NaN for anything else. */
export function monthIndex(ym: string): MonthIndex {
  const m = /^(\d{4})-(\d{2})/u.exec(ym);
  if (!m) return Number.NaN;
  return Number(m[1]) * 12 + Number(m[2]) - 1;
}

/** Index -> "2026-10". */
export function monthKey(i: MonthIndex): string {
  return `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, "0")}`;
}

export const yearOf = (i: MonthIndex): number => Math.floor(i / 12);
export const monthOf = (i: MonthIndex): number => (i % 12) + 1;
export const quarterOf = (i: MonthIndex): number => Math.floor((i % 12) / 3) + 1;

/** The month a budget opens on (domain `defaultMonth`, the month close's rule): the month before today's,
 * unless the newest booking is older, then that booking's month. */
export function defaultMonth(referenceDate: IsoDate | null, today: IsoDate): MonthIndex {
  const before = monthIndex(today) - 1;
  if (referenceDate === null) return before;
  const ref = monthIndex(referenceDate);
  return ref >= before + 1 ? before : ref;
}

/** The month a screen shows: the asked one (or the default) kept inside the shown currency's data, so a
 * currency whose data ends earlier (or starts later) never opens on an empty month. Without data: as asked. */
export function clampMonth(
  i: MonthIndex,
  range: { first: MonthIndex; last: MonthIndex } | null,
): MonthIndex {
  if (range === null) return i;
  return Math.max(range.first, Math.min(range.last, i));
}

/** The first and last month with data (null without any). */
export function dataRange(
  rows: readonly FlowMonth[],
): { first: MonthIndex; last: MonthIndex } | null {
  if (rows.length === 0) return null;
  return { first: Math.min(...rows.map((r) => r.i)), last: Math.max(...rows.map((r) => r.i)) };
}

/** Months in one group of a mode: 1 / 3 / 12 (all = years, the chart's granularity there). */
export const groupSize = (mode: PeriodMode): number =>
  mode === "month" ? 1 : mode === "quarter" ? 3 : 12;

/** First and last month of the group that holds `i`. */
export function groupBounds(mode: PeriodMode, i: MonthIndex): readonly [MonthIndex, MonthIndex] {
  const size = groupSize(mode);
  const first = Math.floor(i / size) * size;
  return [first, first + size - 1];
}

/** The period args of the store queries (`budget.inPeriod`): {} = every period. */
export function queryPeriod(
  mode: PeriodMode,
  i: MonthIndex,
): { year?: number; month?: number; quarter?: number } {
  if (mode === "all") return {};
  if (mode === "month") return { year: yearOf(i), month: monthOf(i) };
  if (mode === "quarter") return { year: yearOf(i), quarter: quarterOf(i) };
  return { year: yearOf(i) };
}

/** One calendar month of the cash flow in the shown currency (store `budgetScreenCashflow` rows). */
export interface FlowMonth {
  i: MonthIndex;
  income: Decimal;
  /** Positive magnitude. */
  expense: Decimal;
}

/** One bar group of the chart and the period it stands for. */
export interface PeriodGroup {
  /** Its first month (unique per mode). */
  first: MonthIndex;
  last: MonthIndex;
  income: Decimal;
  expense: Decimal;
  /** Months of the group inside the data range (the "n miesięcy" of a quarter / year / all). */
  months: number;
  /** The group holds today's month: its figures are so far. */
  partial: boolean;
  /** Its complete months (before today's) and their surplus: what a monthly average reads. */
  doneMonths: number;
  doneNet: Decimal;
}

const ZERO = D("0.00");

/** The cash flow's months from the first to the last one with data (gaps as zero months), grouped by the
 * mode's granularity (all = years). */
export function periodGroups(
  rows: readonly FlowMonth[],
  mode: PeriodMode,
  todayMonth: MonthIndex,
): PeriodGroup[] {
  if (rows.length === 0) return [];
  const byMonth = new Map(rows.map((r) => [r.i, r]));
  const firstData = Math.min(...rows.map((r) => r.i));
  const lastData = Math.max(...rows.map((r) => r.i));
  const groups: PeriodGroup[] = [];
  for (let i = firstData; i <= lastData; i++) {
    const [first, last] = groupBounds(mode, i);
    let g = groups.at(-1);
    if (!g || g.first !== first) {
      g = {
        first,
        last,
        income: ZERO,
        expense: ZERO,
        months: 0,
        partial: last >= todayMonth,
        doneMonths: 0,
        doneNet: ZERO,
      };
      groups.push(g);
    }
    const row = byMonth.get(i);
    if (row) {
      g.income = g.income.add(row.income);
      g.expense = g.expense.add(row.expense);
    }
    g.months += 1;
    if (i < todayMonth) {
      g.doneMonths += 1;
      if (row) g.doneNet = g.doneNet.add(row.income.sub(row.expense));
    }
  }
  return groups;
}

/** The figures of one period: the group's sums, or (all) every group's. */
export function periodTotals(
  groups: readonly PeriodGroup[],
  mode: PeriodMode,
  i: MonthIndex,
): {
  income: Decimal;
  expense: Decimal;
  months: number;
  partial: boolean;
  /** The average surplus of the period's complete months (null without one) and how many there are. */
  doneMonths: number;
  doneAverage: Decimal | null;
} {
  const picked = mode === "all" ? groups : groups.filter((g) => g.first <= i && i <= g.last);
  const doneMonths = picked.reduce((a, g) => a + g.doneMonths, 0);
  const doneNet = picked.reduce((a, g) => a.add(g.doneNet), ZERO);
  return {
    income: picked.reduce((a, g) => a.add(g.income), ZERO),
    expense: picked.reduce((a, g) => a.add(g.expense), ZERO),
    months: picked.reduce((a, g) => a + g.months, 0),
    partial: picked.some((g) => g.partial),
    doneMonths,
    doneAverage: doneMonths > 0 ? doneNet.div(D(String(doneMonths))) : null,
  };
}

/** One currency's surplus over the period (the "Też w EUR" links). */
export function periodSurplus(
  rows: readonly FlowMonth[],
  mode: PeriodMode,
  i: MonthIndex,
  todayMonth: MonthIndex,
): Decimal {
  const t = periodTotals(periodGroups(rows, mode === "all" ? "year" : mode, todayMonth), mode, i);
  return t.income.sub(t.expense);
}

/** The chart's window: at most `span` groups that keep the selected one in view, one group right of it when
 * there is one (the next, often in progress); without a selection (all) the last `span`. */
export function chartWindow(count: number, selected: number | null, span = 13): [number, number] {
  if (count <= span) return [0, count];
  const start =
    selected === null || selected < 0
      ? count - span
      : Math.min(Math.max(0, selected - span + 2), count - span);
  return [start, start + span];
}

/** Round y-axis ticks over [0, max]: a step of 1 / 2 / 2.5 / 5 x 10^n giving 2 to 4 intervals. */
export function niceTicks(max: number): { step: number; top: number; values: number[] } {
  if (!(max > 0)) return { step: 1, top: 1, values: [0, 1] };
  const raw = max * 1.02;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step =
    [0.25, 0.5, 1, 2, 2.5, 5, 10].map((f) => f * mag).find((s) => Math.ceil(raw / s) <= 4) ??
    10 * mag;
  const n = Math.max(2, Math.ceil(raw / step));
  return { step, top: step * n, values: Array.from({ length: n + 1 }, (_, k) => k * step) };
}

/** The average surplus of the complete months in the 12 before `i` (months with data only); null with fewer
 * than three such months. */
export function averageSurplusBefore(
  rows: readonly FlowMonth[],
  i: MonthIndex,
  todayMonth: MonthIndex,
): { average: Decimal; months: number } | null {
  const before = rows.filter((r) => r.i < i && r.i >= i - 12 && r.i < todayMonth);
  if (before.length < 3) return null;
  const sum = before.reduce((a, r) => a.add(r.income.sub(r.expense)), ZERO);
  return { average: sum.div(D(String(before.length))), months: before.length };
}

/** The average monthly spending of the complete months in the 12 before today's (subscriptions' share). */
export function averageSpending(
  rows: readonly FlowMonth[],
  todayMonth: MonthIndex,
): Decimal | null {
  const done = rows.filter((r) => r.i < todayMonth && r.i >= todayMonth - 12);
  if (done.length === 0) return null;
  return done.reduce((a, r) => a.add(r.expense), ZERO).div(D(String(done.length)));
}

/** The share of the income that stays, in percent (0 without income; negative when spending exceeds it). */
export function savingsRate(income: number, expense: number): number {
  return income > 0 ? Math.round(((income - expense) / income) * 100) : 0;
}

// ---- subscriptions ------------------------------------------------------------------------------------

const DAY_MS = 86_400_000;
const utc = (d: IsoDate) =>
  Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10)));

/** The expected next charge: the last one plus the median gap. */
export function nextCharge(lastDate: IsoDate, gapDays: number): IsoDate {
  return new Date(utc(lastDate) + gapDays * DAY_MS).toISOString().slice(0, 10) as IsoDate;
}

/** Whole days from `from` to `to` (negative when `to` is earlier). */
export function daysBetween(from: IsoDate, to: IsoDate): number {
  return Math.round((utc(to) - utc(from)) / DAY_MS);
}

/** A gap of 28 to 32 days reads as monthly. */
export const isMonthly = (gapDays: number): boolean => gapDays >= 28 && gapDays <= 32;
