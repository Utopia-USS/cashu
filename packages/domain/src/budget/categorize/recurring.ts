/**
 * The recurring-payee grouping that feeds the subscription signal (`analytics.detect_recurring`,
 * analytics.py:283-359; D-24.6). S10 reuses it for the recurring list.
 */

import { type IsoDate, toOrdinal } from "../../dates.js";
import { D, type Decimal, format2, ONE, ZERO } from "../../decimal.js";
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
  return categorizedMember(t, notSubscription, categorizeRow)?.member ?? null;
}

/** `recurringMemberWith` plus the category it judged the row by. */
function categorizedMember(
  t: RecurringRow,
  notSubscription: ReadonlySet<string>,
  categorizeRow: Categorize,
): { readonly member: RecurringMember; readonly category: string } | null {
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
  return {
    member: { payee, currency: t.currency, amountKey: format2(t.amount.neg()) },
    category: cat,
  };
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

/** The category of a merchant the owner (a rule, a seed or a decision) files as a subscription. */
const SUBSCRIPTIONS = "subscriptions";
/** The engine's default for a merchant nothing files yet (`categorize`, step 6). */
const UNFILED = "other";
/** The default relative amount drift of one charge (foreign-currency billing). */
export const RECURRING_AMOUNT_TOLERANCE = D("0.15");

export interface RecurringListOptions extends RecurringOptions {
  /** Relative amount drift one charge cluster tolerates (`max <= min * (1 + t)`), default 0.15. */
  readonly amountTolerance?: Decimal;
  /** Billing cycles a merchant filed as `subscriptions` needs (default 2). */
  readonly minCyclesSubscription?: number;
}

interface ListEntry {
  readonly date: IsoDate;
  readonly amount: Decimal;
  readonly amountKey: string;
  readonly category: string;
  /** Position in the caller's row order (first-seen order of the output). */
  readonly seq: number;
}

interface Found {
  readonly candidate: RecurringCandidate;
  readonly seq: number;
  readonly rows: number;
}

/** Splits one payee's charges into amount clusters: each spans at most `tolerance` over its lowest. */
function amountClusters(entries: readonly ListEntry[], tolerance: Decimal): ListEntry[][] {
  const sorted = [...entries].sort((a, b) => a.amount.compare(b.amount) || a.seq - b.seq);
  const out: ListEntry[][] = [];
  let ceiling: Decimal | null = null;
  for (const e of sorted) {
    const current = out.at(-1);
    if (current === undefined || ceiling === null || e.amount.gt(ceiling)) {
      out.push([e]);
      ceiling = e.amount.mul(ONE.add(tolerance));
    } else {
      current.push(e);
    }
  }
  return out;
}

/** The signal's rule over one cluster: one candidate per exact amount whose dates qualify. */
function exactCandidates(
  cluster: readonly ListEntry[],
  payee: string,
  currency: string,
  opts: RecurringOptions,
): Found[] {
  const byKey = new Map<string, ListEntry[]>();
  for (const e of [...cluster].sort((a, b) => a.seq - b.seq)) {
    const list = byKey.get(e.amountKey);
    if (list === undefined) byKey.set(e.amountKey, [e]);
    else list.push(e);
  }
  const out: Found[] = [];
  for (const [amountKey, list] of byKey) {
    const q = recurringDates(
      list.map((e) => e.date),
      opts,
    );
    if (q === null) continue;
    out.push({
      candidate: { counterparty: payee, typicalAmount: D(amountKey), currency, ...q },
      seq: (list[0] as ListEntry).seq,
      rows: list.length,
    });
  }
  return out;
}

const upperMedian = <T>(sorted: readonly T[]): T => sorted[Math.floor(sorted.length / 2)] as T;

/**
 * One amount cluster read as a single drifting charge (a foreign-currency subscription billed to a
 * card in another currency), or null. Only a cluster mostly filed as `subscriptions` or still unfiled
 * (`other`) may drift: a merchant in a spending category (groceries, fuel) shopped on a regular day
 * keeps the exact-amount rule. Charges closer than `minGap` days to the previous kept one are
 * extras (a plan change, a second charge in a month): at most one per four billing cycles (at least
 * one). The billing cycles need an upper median gap in [`minGap`, `maxGap`]. A cluster mostly filed
 * as `subscriptions` needs `minCyclesSubscription` cycles; an unfiled one needs `minOccurrences`
 * cycles and at most one gap above `maxGap` (one skipped month).
 */
function driftCandidate(
  cluster: readonly ListEntry[],
  payee: string,
  currency: string,
  opts: RecurringListOptions,
): Found | null {
  const minOccurrences = opts.minOccurrences ?? 3;
  const minCyclesSubscription = opts.minCyclesSubscription ?? 2;
  const minGap = opts.minGap ?? 24;
  const maxGap = opts.maxGap ?? 37;
  const byDate = [...cluster].sort((a, b) =>
    a.date < b.date ? -1 : a.date > b.date ? 1 : a.seq - b.seq,
  );
  const subs = cluster.filter((e) => e.category === SUBSCRIPTIONS).length;
  const unfiled = cluster.filter((e) => e.category === UNFILED).length;
  if (2 * (subs + unfiled) < cluster.length) return null;
  const subscription = 2 * subs >= cluster.length;
  const cycles: ListEntry[] = [];
  let extras = 0;
  for (const e of byDate) {
    const last = cycles.at(-1);
    if (last === undefined || toOrdinal(e.date) - toOrdinal(last.date) >= minGap) cycles.push(e);
    else extras++;
  }
  if (cycles.length < (subscription ? minCyclesSubscription : minOccurrences)) return null;
  if (cycles.length < 2) return null;
  if (extras > Math.max(1, Math.floor(cycles.length / 4))) return null;
  const gaps: number[] = [];
  for (let i = 0; i + 1 < cycles.length; i++) {
    gaps.push(
      toOrdinal((cycles[i + 1] as ListEntry).date) - toOrdinal((cycles[i] as ListEntry).date),
    );
  }
  const median = upperMedian([...gaps].sort((a, b) => a - b));
  if (!(minGap <= median && median <= maxGap)) return null;
  if (!subscription && gaps.filter((g) => g > maxGap).length > 1) return null;
  const amounts = cycles.map((e) => e.amount).sort((a, b) => a.compare(b));
  return {
    candidate: {
      counterparty: payee,
      typicalAmount: upperMedian(amounts),
      occurrences: byDate.length,
      monthsCovered: new Set(byDate.map((e) => e.date.slice(0, 7))).size,
      medianGapDays: median,
      lastDate: (byDate.at(-1) as ListEntry).date,
      currency,
    },
    seq: Math.min(...cluster.map((e) => e.seq)),
    rows: byDate.length,
  };
}

/**
 * `detectRecurringPayments` with the categorizer to use for undecided rows. Per payee and
 * currency the outflows split into amount clusters (`amountTolerance`). A cluster the signal's
 * exact-amount rule (`recurringDates` per amount) already covers row for row keeps that answer;
 * otherwise a cluster that qualifies as one drifting charge (`driftCandidate`) is one candidate, and
 * the rest fall back to the exact-amount groups. The result is a superset of `detectRecurring`'s
 * payees.
 */
function detectRecurringPaymentsWith(
  rows: readonly RecurringRow[],
  notSubscription: ReadonlySet<string>,
  opts: RecurringListOptions,
  categorizeRow: Categorize,
): RecurringCandidate[] {
  const tolerance = opts.amountTolerance ?? RECURRING_AMOUNT_TOLERANCE;
  const groups = new Map<string, { payee: string; currency: string; entries: ListEntry[] }>();
  let seq = 0;
  for (const t of rows) {
    const c = categorizedMember(t, notSubscription, categorizeRow);
    if (c === null) continue;
    const { payee, currency, amountKey } = c.member;
    const key = JSON.stringify([payee, currency]);
    let g = groups.get(key);
    if (g === undefined) {
      g = { payee, currency, entries: [] };
      groups.set(key, g);
    }
    g.entries.push({
      date: t.bookingDate,
      amount: D(amountKey),
      amountKey,
      category: c.category,
      seq: seq++,
    });
  }
  const found: Found[] = [];
  for (const g of groups.values()) {
    for (const cluster of amountClusters(g.entries, tolerance)) {
      const exact = exactCandidates(cluster, g.payee, g.currency, opts);
      const covered = exact.reduce((n, f) => n + f.rows, 0) === cluster.length;
      const drift = covered ? null : driftCandidate(cluster, g.payee, g.currency, opts);
      if (drift !== null) found.push(drift);
      else found.push(...exact);
    }
  }
  // First-seen order, then stable by last date (newest first), as `detectRecurring` (Q21).
  return found
    .sort((a, b) => a.seq - b.seq)
    .map((f) => f.candidate)
    .sort((a, b) => (a.lastDate < b.lastDate ? 1 : a.lastDate > b.lastDate ? -1 : 0));
}

/**
 * The recurring-payments list (the Subskrypcje tab, `recurring_payments`): `detectRecurring` plus,
 * for merchants filed as `subscriptions` or still unfiled, charges whose amount drifts within
 * `amountTolerance` (foreign-currency billing) or with an extra charge in a month, and two monthly
 * charges of a merchant filed as `subscriptions`. The subscription
 * signal (`detectRecurring`, `subscriptionPayees`) keeps the exact-amount rule.
 */
export function detectRecurringPayments(
  rows: readonly RecurringRow[],
  ctx: EngineContext,
  notSubscription: ReadonlySet<string>,
  opts: RecurringListOptions = {},
): RecurringCandidate[] {
  return detectRecurringPaymentsWith(rows, notSubscription, opts, (t, keys) =>
    categorize(t, ctx, keys),
  );
}

/** The payees (merchant keys) the recurring signal flags: payee-wide, every currency (Q8). */
export function subscriptionPayees(candidates: readonly RecurringCandidate[]): Set<string> {
  return new Set(candidates.map((c) => c.counterparty));
}
