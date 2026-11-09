/**
 * The recurring-payments view (`analytics.detect_recurring`, `active_recurring`,
 * `not_subscription_categories`) over the stored rows. The grouping itself is the categorization
 * port's (`categorize/recurring.ts`, S09); this file only feeds it the book.
 */

import { type CoreRegistry, notSubscriptionCategories } from "../../core/index.js";
import { addDays, type IsoDate } from "../../dates.js";
import {
  detectRecurringPayments,
  type EngineContext,
  NOT_SUBSCRIPTION_CATEGORIES,
  type RecurringCandidate,
  type RecurringListOptions,
  type RecurringRow,
} from "../categorize/index.js";
import type { BudgetBook } from "./book.js";
import { referenceDate } from "./cashflow.js";

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
