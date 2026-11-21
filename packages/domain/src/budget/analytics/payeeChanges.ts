/**
 * Recurring payees that changed: a price rise (with its yearly effect), and a recurring payment that
 * appeared recently. One currency at a time (payees in another currency are left out, never converted).
 * Whether a rise is worth a look against a usual month is the attention list's call
 * (`ATTENTION_THRESHOLDS.payeeChangeYearlyOfUsual`), not this module's.
 */

import { daysBetween, type IsoDate } from "../../dates.js";
import { D, type Decimal, ONE, ZERO } from "../../decimal.js";
import { isMonthlyGap, nextChargeDate, type RecurringCharge } from "./upcoming.js";

/** The last charge at least 10 % above the typical amount. */
export const PRICE_UP_MIN_SHARE = 0.1;
/** A new recurring payee needs this many charges ... */
export const NEW_RECURRING_MIN_OCCURRENCES = 3;
/** ... the first of them at most this many days ago. */
export const NEW_RECURRING_WINDOW_DAYS = 90;
/** Older charges a price rise is measured against (their median). */
export const PRICE_UP_MIN_OLDER_CHARGES = 2;
/** Charges per year of a monthly cadence (`isMonthlyGap`); other cadences: `DAYS_PER_YEAR / gap`. */
const MONTHLY_CHARGES_PER_YEAR = 12;
const DAYS_PER_YEAR = 365;

export interface PayeeCharge {
  readonly date: IsoDate;
  /** Positive. */
  readonly amount: Decimal;
}

export interface PayeeChargeHistory extends RecurringCharge {
  /** The recurring series' own charges (`recurringSeries`), newest first, positive amounts. */
  readonly charges: readonly PayeeCharge[];
  readonly firstSeen: IsoDate;
}

export type PayeeChange =
  | {
      readonly kind: "price_up";
      readonly key: string;
      readonly payee: string;
      readonly currency: string;
      /** The median of the older charges. */
      readonly from: Decimal;
      /** The newest charge. */
      readonly to: Decimal;
      /** `to - from`. */
      readonly perCharge: Decimal;
      /** `perCharge` times the charges per year. */
      readonly yearlyEffect: Decimal;
      readonly cadenceDays: number;
      /** The newest charge's date (the first at the new price). */
      readonly since: IsoDate;
      readonly nextDate: IsoDate;
    }
  | {
      readonly kind: "new_recurring";
      readonly key: string;
      readonly payee: string;
      readonly currency: string;
      readonly amount: Decimal;
      readonly cadenceDays: number;
      readonly occurrences: number;
      readonly firstSeen: IsoDate;
      readonly nextDate: IsoDate;
    };

export interface PayeeChangesInput {
  readonly today: IsoDate;
  readonly currency: string;
  readonly payees: readonly PayeeChargeHistory[];
}

const TWO = D("2");

function median(values: readonly Decimal[]): Decimal {
  const sorted = [...values].sort((a, b) => a.compare(b));
  const mid = Math.floor(sorted.length / 2);
  const hi = sorted[mid] as Decimal;
  return sorted.length % 2 === 1 ? hi : (sorted[mid - 1] as Decimal).add(hi).div(TWO);
}

/** How many charges a year a cadence makes: 12 for a monthly one, else 365 / gap. */
function chargesPerYear(cadenceDays: number): Decimal {
  return isMonthlyGap(cadenceDays)
    ? D(String(MONTHLY_CHARGES_PER_YEAR))
    : D(String(DAYS_PER_YEAR)).div(D(String(cadenceDays)));
}

function priceUp(p: PayeeChargeHistory): PayeeChange | null {
  const [newest, ...older] = p.charges;
  if (newest === undefined || older.length < PRICE_UP_MIN_OLDER_CHARGES || p.medianGapDays <= 0) {
    return null;
  }
  const from = median(older.map((c) => c.amount.copyAbs()));
  const to = newest.amount.copyAbs();
  if (!from.gt(ZERO) || to.lt(from.mul(ONE.add(D(String(PRICE_UP_MIN_SHARE)))))) {
    return null;
  }
  const perCharge = to.sub(from);
  const yearlyEffect = perCharge.mul(chargesPerYear(p.medianGapDays));
  return {
    kind: "price_up",
    key: p.key,
    payee: p.payee,
    currency: p.currency,
    from,
    to,
    perCharge,
    yearlyEffect,
    cadenceDays: p.medianGapDays,
    since: newest.date,
    nextDate: nextChargeDate(p.lastDate, p.medianGapDays),
  };
}

function newRecurring(p: PayeeChargeHistory, today: IsoDate): PayeeChange | null {
  const age = daysBetween(p.firstSeen, today);
  if (age < 0 || age > NEW_RECURRING_WINDOW_DAYS) return null;
  if (p.charges.length < NEW_RECURRING_MIN_OCCURRENCES) return null;
  return {
    kind: "new_recurring",
    key: p.key,
    payee: p.payee,
    currency: p.currency,
    amount: p.typicalAmount.copyAbs(),
    cadenceDays: p.medianGapDays,
    occurrences: p.charges.length,
    firstSeen: p.firstSeen,
    nextDate: nextChargeDate(p.lastDate, p.medianGapDays),
  };
}

/**
 * The payee changes in `currency`, in the payees' order: per payee a price rise (when it qualifies) and
 * then a new recurring payment (when it qualifies); each is judged on its own.
 */
export function payeeChanges(input: PayeeChangesInput): readonly PayeeChange[] {
  const out: PayeeChange[] = [];
  for (const p of input.payees) {
    if (p.currency !== input.currency) continue;
    const up = priceUp(p);
    if (up !== null) out.push(up);
    const fresh = newRecurring(p, input.today);
    if (fresh !== null) out.push(fresh);
  }
  return out;
}
