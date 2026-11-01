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

/** @package `detectRecurring` with the categorizer to use for undecided rows (plain or memoized). */
export function detectRecurringWith(
  rows: readonly RecurringRow[],
  notSubscription: ReadonlySet<string>,
  opts: RecurringOptions,
  categorizeRow: Categorize,
): RecurringCandidate[] {
  const minOccurrences = opts.minOccurrences ?? 3;
  const minGap = opts.minGap ?? 24;
  const maxGap = opts.maxGap ?? 37;
  const groups = new Map<
    string,
    { payee: string; currency: string; amountKey: string; dates: IsoDate[] }
  >();
  for (const t of rows) {
    if (t.amount.gte(ZERO)) continue; // subscriptions are outflows
    const payee = txnMerchantKey(t);
    if (!payee) continue;
    const d = t.decided;
    const cat =
      d && TXN_DECIDED_SOURCES.has(d.source) && d.category
        ? d.category
        : categorizeRow(t, NO_KEYS).category;
    if (notSubscription.has(cat)) continue;
    // Python `f"{-t.amount:.2f}"`: the negation rounds to the context (28 digits) first.
    const amountKey = format2(t.amount.neg());
    const key = JSON.stringify([payee, t.currency, amountKey]);
    let g = groups.get(key);
    if (g === undefined) {
      g = { payee, currency: t.currency, amountKey, dates: [] };
      groups.set(key, g);
    }
    g.dates.push(t.bookingDate);
  }
  const out: RecurringCandidate[] = [];
  for (const g of groups.values()) {
    if (g.dates.length < minOccurrences) continue;
    const dates = [...g.dates].sort();
    const gaps: number[] = [];
    for (let i = 0; i + 1 < dates.length; i++) {
      const gap = toOrdinal(dates[i + 1] as string) - toOrdinal(dates[i] as string);
      if (gap > 0) gaps.push(gap);
    }
    if (gaps.length === 0) continue;
    // PARITY(Q20): the upper median of the positive gaps.
    const median = [...gaps].sort((a, b) => a - b)[Math.floor(gaps.length / 2)] as number;
    if (!(minGap <= median && median <= maxGap)) continue;
    out.push({
      counterparty: g.payee,
      typicalAmount: D(g.amountKey),
      occurrences: dates.length,
      monthsCovered: new Set(dates.map((d) => d.slice(0, 7))).size,
      medianGapDays: median,
      lastDate: dates.at(-1) as string,
      currency: g.currency,
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
