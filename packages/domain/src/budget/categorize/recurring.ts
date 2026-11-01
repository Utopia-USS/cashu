/**
 * The recurring-payee grouping that feeds the subscription signal (`analytics.detect_recurring`,
 * analytics.py:283-359; D-24.6). S10 reuses it for the recurring list.
 */

import { type IsoDate, toOrdinal } from "../../dates.js";
import { D, type Decimal, format2, ZERO } from "../../decimal.js";
import type { Categorization, EngineContext, EngineTxn } from "./engine.js";
import { categorize, txnMerchantKey } from "./engine.js";

/**
 * `NOT_SUBSCRIPTION_CATEGORIES`: monthly same-amount outflows that are not subscriptions. The caller
 * adds the modules' own (`core.notSubscriptionCategories(builtinRegistry())`, loans: `loans`).
 */
export const NOT_SUBSCRIPTION_CATEGORIES: ReadonlySet<string> = new Set([
  "housing",
  "fees",
  "cash",
  "taxes",
  "transfer",
  "cash_withdrawal",
]);

/** `_TXN_DECIDED_SOURCES`: per-transaction decisions the engine cannot reproduce. */
export const TXN_DECIDED_SOURCES: ReadonlySet<string> = new Set([
  "manual_txn",
  "llm_full",
  "llm_fallback",
  "cash_leg",
]);

export interface RecurringRow extends EngineTxn {
  readonly bookingDate: IsoDate;
  readonly currency: string;
  /** The row's decided category (its claim, never a derived value, Q6), or null. */
  readonly decided: { readonly category: string | null; readonly source: string } | null;
}

export interface RecurringCandidate {
  readonly counterparty: string;
  readonly typicalAmount: Decimal;
  readonly occurrences: number;
  readonly monthsCovered: number;
  readonly medianGapDays: number;
  readonly lastDate: IsoDate;
  readonly currency: string;
}

export interface RecurringOptions {
  readonly minOccurrences?: number;
  readonly minGap?: number;
  readonly maxGap?: number;
}

type Categorize = (t: EngineTxn, subscriptionKeys: ReadonlySet<string>) => Categorization;
const NO_KEYS: ReadonlySet<string> = new Set();

/** A row's recurring group: payee, currency and the `.2f` outflow amount (analytics.py:318-330). */
export interface RecurringMember {
  readonly payee: string;
  readonly currency: string;
  readonly amountKey: string;
}

/**
 * @package The group a row counts in for `detect_recurring`, or null: inflows, rows without a payee
 * and rows whose decided category (else the engine's without the recurring signal) is in
 * `notSubscription` count in none.
 */
export function recurringMemberWith(
  t: RecurringRow,
  notSubscription: ReadonlySet<string>,
  categorizeRow: Categorize,
): RecurringMember | null {
  if (t.amount.gte(ZERO)) return null; // subscriptions are outflows
  const payee = txnMerchantKey(t);
  if (!payee) return null;
  const d = t.decided;
  const cat =
    d && TXN_DECIDED_SOURCES.has(d.source) && d.category
      ? d.category
      : categorizeRow(t, NO_KEYS).category;
  if (notSubscription.has(cat)) return null;
  // Python `f"{-t.amount:.2f}"`: the negation rounds to the context (28 digits) first.
  return { payee, currency: t.currency, amountKey: format2(t.amount.neg()) };
}

/** What a qualifying group's dates give (`RecurringCandidate` without payee, amount, currency). */
export interface RecurringDates {
  readonly occurrences: number;
  readonly monthsCovered: number;
  readonly medianGapDays: number;
  readonly lastDate: IsoDate;
}

/**
 * Whether one group's booking dates (any order) qualify: `minOccurrences` rows and an upper median of
 * the positive gaps in [`minGap`, `maxGap`] days; null when they do not.
 */
export function recurringDates(
  groupDates: readonly IsoDate[],
  opts: RecurringOptions = {},
): RecurringDates | null {
  const minOccurrences = opts.minOccurrences ?? 3;
  const minGap = opts.minGap ?? 24;
  const maxGap = opts.maxGap ?? 37;
  if (groupDates.length < minOccurrences) return null;
  const dates = [...groupDates].sort();
  const gaps: number[] = [];
  for (let i = 0; i + 1 < dates.length; i++) {
    const gap = toOrdinal(dates[i + 1] as string) - toOrdinal(dates[i] as string);
    if (gap > 0) gaps.push(gap);
  }
  if (gaps.length === 0) return null;
  // PARITY(Q20): the upper median of the positive gaps.
  const median = [...gaps].sort((a, b) => a - b)[Math.floor(gaps.length / 2)] as number;
  if (!(minGap <= median && median <= maxGap)) return null;
  return {
    occurrences: dates.length,
    monthsCovered: new Set(dates.map((d) => d.slice(0, 7))).size,
    medianGapDays: median,
    lastDate: dates.at(-1) as string,
  };
}

/** @package `detectRecurring` with the categorizer to use for undecided rows (plain or memoized). */
export function detectRecurringWith(
  rows: readonly RecurringRow[],
  notSubscription: ReadonlySet<string>,
  opts: RecurringOptions,
  categorizeRow: Categorize,
): RecurringCandidate[] {
  const groups = new Map<string, { member: RecurringMember; dates: IsoDate[] }>();
  for (const t of rows) {
    const member = recurringMemberWith(t, notSubscription, categorizeRow);
    if (member === null) continue;
    const key = JSON.stringify([member.payee, member.currency, member.amountKey]);
    let g = groups.get(key);
    if (g === undefined) {
      g = { member, dates: [] };
      groups.set(key, g);
    }
    g.dates.push(t.bookingDate);
  }
  const out: RecurringCandidate[] = [];
  for (const g of groups.values()) {
    const q = recurringDates(g.dates, opts);
    if (q === null) continue;
    out.push({
      counterparty: g.member.payee,
      typicalAmount: D(g.member.amountKey),
      occurrences: q.occurrences,
      monthsCovered: q.monthsCovered,
      medianGapDays: q.medianGapDays,
      lastDate: q.lastDate,
      currency: g.member.currency,
    });
  }
  // Stable: equal last dates keep first-seen order (Q21, the caller's row order).
  return out.sort((a, b) => (a.lastDate < b.lastDate ? 1 : a.lastDate > b.lastDate ? -1 : 0));
}

/**
 * `detect_recurring` over the rows given: non-internal rows of the vault in the caller's order
 * (Q21). Groups outflows by (merchant key, currency, amount); a group qualifies with
 * `minOccurrences` rows and a median positive gap in [`minGap`, `maxGap`] days. Rows whose decided
 * category (else the engine's without the recurring signal) is in `notSubscription` are skipped.
 */
export function detectRecurring(
  rows: readonly RecurringRow[],
  ctx: EngineContext,
  notSubscription: ReadonlySet<string>,
  opts: RecurringOptions = {},
): RecurringCandidate[] {
  return detectRecurringWith(rows, notSubscription, opts, (t, keys) => categorize(t, ctx, keys));
}

/** The payees (merchant keys) the recurring signal flags: payee-wide, every currency (Q8). */
export function subscriptionPayees(candidates: readonly RecurringCandidate[]): Set<string> {
  return new Set(candidates.map((c) => c.counterparty));
}
