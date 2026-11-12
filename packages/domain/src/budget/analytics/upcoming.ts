/**
 * The charges of the coming days: recurring payments at their expected next date, loan installments and
 * planned outflows within `[today - UPCOMING_GRACE_DAYS, today + horizon]`, each checked against its
 * account's balance in date order. Per currency, never summed across currencies.
 */

import { addDays, addMonths, daysBetween, type IsoDate } from "../../dates.js";
import { type Decimal, ZERO } from "../../decimal.js";

/** How many days ahead the list reaches (like the desktop widget). */
export const UPCOMING_HORIZON_DAYS = 7;
/** How many days back a charge still shows (expected yesterday, not booked yet). */
export const UPCOMING_GRACE_DAYS = 1;
/** A median gap in this range (days) reads as a monthly cadence. */
export const MONTHLY_GAP_MIN_DAYS = 28;
export const MONTHLY_GAP_MAX_DAYS = 32;

export interface UpcomingAccount {
  readonly id: string;
  readonly name: string;
}

export interface RecurringCharge {
  readonly key: string;
  readonly payee: string;
  readonly typicalAmount: Decimal;
  readonly currency: string;
  readonly lastDate: IsoDate;
  readonly medianGapDays: number;
  readonly account: UpcomingAccount | null;
}

export interface InstallmentDue {
  readonly key: string;
  readonly loan: string;
  readonly name: string;
  readonly date: IsoDate;
  readonly amount: Decimal;
  readonly currency: string;
  readonly account: UpcomingAccount | null;
}

export interface PlannedOutflow {
  readonly key: string;
  readonly name: string;
  readonly date: IsoDate;
  readonly amount: Decimal;
  readonly currency: string;
  readonly account: UpcomingAccount | null;
}

export interface AccountBalance {
  readonly id: string;
  readonly name: string;
  readonly currency: string;
  readonly balance: Decimal;
}

export interface UpcomingInput {
  readonly today: IsoDate;
  readonly horizonDays?: number;
  readonly recurring: readonly RecurringCharge[];
  readonly installments: readonly InstallmentDue[];
  readonly planned: readonly PlannedOutflow[];
  readonly balances: readonly AccountBalance[];
}

export interface UpcomingRow {
  readonly kind: "subscription" | "installment" | "planned";
  readonly key: string;
  readonly when: IsoDate;
  /** Negative when the charge was expected before today. */
  readonly daysUntil: number;
  readonly payee: string;
  /** Negative (an outflow). */
  readonly amount: Decimal;
  readonly currency: string;
  readonly account: UpcomingAccount | null;
  /** Null without an account or without its balance in the row's currency. */
  readonly covered: boolean | null;
  /** How much the account's balance falls short by this row (uncovered rows only). */
  readonly shortfall: Decimal | null;
}

export interface Upcoming {
  /** By date, then amount (the larger outflow first), then key. */
  readonly rows: readonly UpcomingRow[];
  /** The sum of the rows' (negative) amounts per currency, currencies in code order. */
  readonly totals: Readonly<Record<string, Decimal>>;
  /** The rows with `covered: false`, in `rows` order. */
  readonly uncovered: readonly UpcomingRow[];
}

/** True for a median gap that reads as monthly. */
export function isMonthlyGap(gapDays: number): boolean {
  return gapDays >= MONTHLY_GAP_MIN_DAYS && gapDays <= MONTHLY_GAP_MAX_DAYS;
}

/**
 * The expected next charge: a monthly cadence lands on the same day next month (clamped to the month's
 * length), any other cadence `medianGapDays` after the last charge.
 */
export function nextChargeDate(lastDate: IsoDate, medianGapDays: number): IsoDate {
  return isMonthlyGap(medianGapDays) ? addMonths(lastDate, 1) : addDays(lastDate, medianGapDays);
}

const codeOrder = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

type Pending = Omit<UpcomingRow, "covered" | "shortfall">;

/** The upcoming charges of the window and whether each account's balance covers them. */
export function upcomingCharges(input: UpcomingInput): Upcoming {
  const { today } = input;
  const from = addDays(today, -UPCOMING_GRACE_DAYS);
  const to = addDays(today, input.horizonDays ?? UPCOMING_HORIZON_DAYS);
  const pending: Pending[] = [];
  const add = (
    kind: UpcomingRow["kind"],
    key: string,
    when: IsoDate,
    payee: string,
    amount: Decimal,
    currency: string,
    account: UpcomingAccount | null,
  ) => {
    if (when < from || when > to) return;
    const outflow = amount.copyAbs().copyNegate();
    pending.push({
      kind,
      key,
      when,
      daysUntil: daysBetween(today, when),
      payee,
      amount: outflow,
      currency,
      account,
    });
  };
  for (const r of input.recurring) {
    const when = nextChargeDate(r.lastDate, r.medianGapDays);
    add("subscription", r.key, when, r.payee, r.typicalAmount, r.currency, r.account);
  }
  for (const i of input.installments) {
    add("installment", i.key, i.date, i.name, i.amount, i.currency, i.account);
  }
  for (const p of input.planned) {
    add("planned", p.key, p.date, p.name, p.amount, p.currency, p.account);
  }
  pending.sort(
    (a, b) => codeOrder(a.when, b.when) || a.amount.compare(b.amount) || codeOrder(a.key, b.key),
  );

  const balances = new Map(input.balances.map((b) => [b.id, b]));
  const spent = new Map<string, Decimal>();
  const short = new Set<string>();
  const rows: UpcomingRow[] = pending.map((p) => {
    const balance = p.account === null ? undefined : balances.get(p.account.id);
    if (p.account === null || balance === undefined || balance.currency !== p.currency) {
      return { ...p, covered: null, shortfall: null };
    }
    const id = p.account.id;
    const cumulative = (spent.get(id) ?? ZERO).add(p.amount.copyAbs());
    spent.set(id, cumulative);
    if (!short.has(id) && cumulative.lte(balance.balance)) {
      return { ...p, covered: true, shortfall: null };
    }
    short.add(id);
    return { ...p, covered: false, shortfall: cumulative.sub(balance.balance) };
  });

  const sums = new Map<string, Decimal>();
  for (const r of rows) {
    const seen = sums.get(r.currency);
    sums.set(r.currency, seen === undefined ? r.amount : seen.add(r.amount));
  }
  const totals: Record<string, Decimal> = {};
  for (const c of [...sums.keys()].sort(codeOrder)) totals[c] = sums.get(c) as Decimal;
  return { rows, totals, uncovered: rows.filter((r) => r.covered === false) };
}
