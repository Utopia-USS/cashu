/**
 * The recurring-payments view (`analytics.detect_recurring`, `active_recurring`,
 * `not_subscription_categories`) over the stored rows. The grouping itself is the categorization
 * port's (`categorize/recurring.ts`, S09); this file only feeds it the book.
 */

import { type CoreRegistry, notSubscriptionCategories } from "../../core/index.js";
import { addDays, daysBetween, type IsoDate } from "../../dates.js";
import { type Decimal, ONE, ZERO } from "../../decimal.js";
import {
  detectRecurringPayments,
  type EngineContext,
  NOT_SUBSCRIPTION_CATEGORIES,
  RECURRING_AMOUNT_TOLERANCE,
  type RecurringCandidate,
  type RecurringListOptions,
  type RecurringRow,
  txnMerchantKey,
} from "../categorize/index.js";
import type { BudgetBook, BudgetTxn } from "./book.js";
import { referenceDate } from "./cashflow.js";
import { nextChargeDate } from "./upcoming.js";

/** `analytics.not_subscription_categories`: budget's own plus every module's (loans: `loans`). */
export function subscriptionExclusions(registry: CoreRegistry): Set<string> {
  return new Set([...NOT_SUBSCRIPTION_CATEGORIES, ...notSubscriptionCategories(registry)]);
}

/**
 * The recurring-payments list over the book (`detectRecurringPayments`: the exact-amount
 * `detect_recurring` plus amount drift, an extra charge in a month and two-month `subscriptions`
 * merchants): the non-internal rows in storage order, each row's stored
 * category decision (`category_source` + `category`) as its decided claim; an undecided row is
 * categorized by the engine without the recurring signal (`ctx`: own IBANs of every account, the
 * profile's merchant rules and module payment patterns).
 */
export function recurringPayments(
  book: BudgetBook,
  ctx: EngineContext,
  notSubscription: ReadonlySet<string>,
  opts: RecurringListOptions = {},
): RecurringCandidate[] {
  const rows: RecurringRow[] = [];
  for (const t of book.transactions) {
    if (t.isInternalTransfer) continue;
    rows.push({
      bookingDate: t.bookingDate,
      currency: t.currency,
      amount: t.amount,
      counterpartyName: t.counterpartyName,
      counterpartyIban: t.counterpartyIban,
      description: t.description,
      reference: t.reference,
      isInternalTransfer: false,
      decided:
        t.categorySource === null ? null : { category: t.category, source: t.categorySource },
    });
  }
  return detectRecurringPayments(rows, ctx, notSubscription, opts);
}

/**
 * `active_recurring` filter: the candidates last seen within `withinDays` of the profile's newest
 * booking date (all of them when the profile has no rows).
 */
export function activeRecurring(
  candidates: readonly RecurringCandidate[],
  book: BudgetBook,
  withinDays = 45,
): RecurringCandidate[] {
  const ref: IsoDate | null = referenceDate(book);
  if (ref === null) return [...candidates];
  const cutoff = addDays(ref, -withinDays);
  return candidates.filter((c) => c.lastDate >= cutoff);
}

/** How many days off its expected date a charge at a new price may land and still continue a series. */
export const SERIES_DATE_SLACK_DAYS = 3;

/** One recurring candidate with its own charges. */
export interface RecurringSeries {
  readonly candidate: RecurringCandidate;
  /** `<merchant key>:<currency>:<typical amount>`: one per candidate, opaque to callers. */
  readonly key: string;
  /** The series' charges, oldest first (book order on equal dates). */
  readonly rows: readonly BudgetTxn[];
}

const groupKey = (payee: string, currency: string): string => JSON.stringify([payee, currency]);

/** True when `amount` (positive) is within `tolerance` of `typical` either way, as one amount cluster. */
function inBand(amount: Decimal, typical: Decimal, tolerance: Decimal): boolean {
  const factor = ONE.add(tolerance);
  return amount.mul(factor).gte(typical) && amount.lte(typical.mul(factor));
}

/**
 * The charges of one (payee, currency) group's candidates (`own`, in their order) among the group's
 * outflows (`rows`: non-internal, negative, in book order), each list oldest first (book order on
 * equal dates). A charge belongs to the candidate whose typical amount is nearest within the
 * detector's amount tolerance (`RECURRING_AMOUNT_TOLERANCE`, one amount cluster). A charge outside
 * every band still continues a series when it lands on the series' expected next date
 * (`nextChargeDate`, within `SERIES_DATE_SLACK_DAYS`) after its last charge: a price rise. Anything
 * else (a one-off purchase at a merchant that also bills a subscription) belongs to no series.
 */
export function groupSeries<T extends { readonly bookingDate: IsoDate; readonly amount: Decimal }>(
  own: readonly RecurringCandidate[],
  rows: readonly T[],
  tolerance: Decimal = RECURRING_AMOUNT_TOLERANCE,
): T[][] {
  const members = own.map((): T[] => []);
  const byDate = [...rows].sort((a, b) =>
    a.bookingDate < b.bookingDate ? -1 : a.bookingDate > b.bookingDate ? 1 : 0,
  );
  const loose: T[] = [];
  for (const t of byDate) {
    const amount = t.amount.copyAbs();
    let best = -1;
    for (const [i, c] of own.entries()) {
      if (!inBand(amount, c.typicalAmount, tolerance)) continue;
      if (
        best === -1 ||
        amount
          .sub(c.typicalAmount)
          .copyAbs()
          .lt(amount.sub((own[best] as RecurringCandidate).typicalAmount).copyAbs())
      )
        best = i;
    }
    if (best === -1) loose.push(t);
    else members[best]?.push(t);
  }
  for (const [ci, c] of own.entries()) {
    const series = members[ci] as T[];
    let last = series.at(-1)?.bookingDate ?? c.lastDate;
    for (let i = 0; i < loose.length; i++) {
      const t = loose[i] as T;
      if (t.bookingDate <= last) continue;
      const off = Math.abs(daysBetween(nextChargeDate(last, c.medianGapDays), t.bookingDate));
      if (off > SERIES_DATE_SLACK_DAYS) continue;
      series.push(t);
      last = t.bookingDate;
      loose.splice(i, 1);
      i--;
    }
  }
  return members;
}

/** The series key of a candidate: `<merchant key>:<currency>:<typical amount>`. */
const seriesKey = (c: RecurringCandidate): string =>
  `${c.counterparty}:${c.currency}:${c.typicalAmount.toString()}`;

/**
 * Each candidate's own charges among the book's outflows (non-internal, same merchant key and
 * currency; `groupSeries` per group). Candidates keep their order.
 */
export function recurringSeries(
  candidates: readonly RecurringCandidate[],
  book: BudgetBook,
  tolerance: Decimal = RECURRING_AMOUNT_TOLERANCE,
): RecurringSeries[] {
  const wanted = new Set(candidates.map((c) => groupKey(c.counterparty, c.currency)));
  const byPayee = new Map<string, BudgetTxn[]>();
  for (const t of book.transactions) {
    if (!t.amount.lt(ZERO) || t.isInternalTransfer) continue;
    const key = groupKey(txnMerchantKey(t), t.currency);
    if (!wanted.has(key)) continue;
    const seen = byPayee.get(key);
    if (seen === undefined) byPayee.set(key, [t]);
    else seen.push(t);
  }
  const members = new Map<RecurringCandidate, BudgetTxn[]>(candidates.map((c) => [c, []]));
  for (const [key, rows] of byPayee) {
    const own = candidates.filter((c) => groupKey(c.counterparty, c.currency) === key);
    const series = groupSeries(own, rows, tolerance);
    for (const [i, c] of own.entries()) members.set(c, series[i] as BudgetTxn[]);
  }
  return candidates.map((c) => ({
    candidate: c,
    key: seriesKey(c),
    rows: members.get(c) as BudgetTxn[],
  }));
}
