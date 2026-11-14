// The recurring-payments detection and series assignment as they were before the per-group refactor
// (M3-C2a: `detectRecurringGroup`, `groupSeries`), frozen verbatim from the domain at that commit
// (`budget/categorize/recurring.ts` `detectRecurringPaymentsWith`, `recurringDates` and the helpers, `budget/analytics/
// recurring.ts` `recurringPayments` and `recurringSeries`) and rebuilt only on the domain's public API.
// The recurring oracle (`recurring-oracle.ts`) detects with these, so the deriver and the queries are
// compared with code the refactor never touched, and `recurring-frozen.test.ts` checks the refactored
// domain functions against them on random groups. Do not "fix" this file along with the domain: a
// deliberate change of the detection updates both, with the reason. Tests only.
import {
  budget,
  D,
  type Decimal,
  daysBetween,
  format2,
  type IsoDate,
  ONE,
  toOrdinal,
  ZERO,
} from "@cashu/domain";

type Categorize = (
  t: budget.EngineTxn,
  subscriptionKeys: ReadonlySet<string>,
) => budget.Categorization;
const NO_KEYS: ReadonlySet<string> = new Set();

/** The category of a merchant the owner (a rule, a seed or a decision) files as a subscription. */
const SUBSCRIPTIONS = "subscriptions";
/** The engine's default for a merchant nothing files yet (`categorize`, step 6). */
const UNFILED = "other";

interface RecurringMember {
  readonly payee: string;
  readonly currency: string;
  readonly amountKey: string;
}

/** `recurringMemberWith` plus the category it judged the row by. */
function categorizedMember(
  t: budget.RecurringRow,
  notSubscription: ReadonlySet<string>,
  categorizeRow: Categorize,
): { readonly member: RecurringMember; readonly category: string } | null {
  if (t.amount.gte(ZERO)) return null; // subscriptions are outflows
  const payee = budget.txnMerchantKey(t);
  if (!payee) return null;
  const d = t.decided;
  const cat =
    d && budget.TXN_DECIDED_SOURCES.has(d.source) && d.category
      ? d.category
      : categorizeRow(t, NO_KEYS).category;
  if (notSubscription.has(cat)) return null;
  // Python `f"{-t.amount:.2f}"`: the negation rounds to the context (28 digits) first.
  return {
    member: { payee, currency: t.currency, amountKey: format2(t.amount.neg()) },
    category: cat,
  };
}

/** Frozen `recurringDates`: `minOccurrences` rows and an upper median positive gap in range. */
function recurringDates(
  groupDates: readonly IsoDate[],
  opts: budget.RecurringOptions = {},
): budget.RecurringDates | null {
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

interface ListEntry {
  readonly date: IsoDate;
  readonly amount: Decimal;
  readonly amountKey: string;
  readonly category: string;
  /** Position in the caller's row order (first-seen order of the output). */
  readonly seq: number;
}

interface Found {
  readonly candidate: budget.RecurringCandidate;
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
  opts: budget.RecurringOptions,
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

/** One amount cluster read as a single drifting charge, or null (frozen `driftCandidate`). */
function driftCandidate(
  cluster: readonly ListEntry[],
  payee: string,
  currency: string,
  opts: budget.RecurringListOptions,
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

/** Frozen `detectRecurringPaymentsWith`: every payee group of the rows at once. */
export function detectRecurringPaymentsFrozen(
  rows: readonly budget.RecurringRow[],
  notSubscription: ReadonlySet<string>,
  opts: budget.RecurringListOptions,
  categorizeRow: Categorize,
): budget.RecurringCandidate[] {
  const tolerance = opts.amountTolerance ?? budget.RECURRING_AMOUNT_TOLERANCE;
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

/** Frozen `budget.recurringPayments`: the book's non-internal rows, the plain engine per row. */
export function recurringPaymentsFrozen(
  book: budget.BudgetBook,
  ctx: budget.EngineContext,
  notSubscription: ReadonlySet<string>,
  opts: budget.RecurringListOptions = {},
): budget.RecurringCandidate[] {
  const rows: budget.RecurringRow[] = [];
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
  return detectRecurringPaymentsFrozen(rows, notSubscription, opts, (t, keys) =>
    budget.categorize(t, ctx, keys),
  );
}

const groupKey = (payee: string, currency: string): string => JSON.stringify([payee, currency]);

/** True when `amount` (positive) is within `tolerance` of `typical` either way, as one amount cluster. */
function inBand(amount: Decimal, typical: Decimal, tolerance: Decimal): boolean {
  const factor = ONE.add(tolerance);
  return amount.mul(factor).gte(typical) && amount.lte(typical.mul(factor));
}

/** Frozen `budget.recurringSeries`: each candidate's own charges among the book's outflows. */
export function recurringSeriesFrozen(
  candidates: readonly budget.RecurringCandidate[],
  book: budget.BudgetBook,
  tolerance: Decimal = budget.RECURRING_AMOUNT_TOLERANCE,
): budget.RecurringSeries[] {
  const wanted = new Set(candidates.map((c) => groupKey(c.counterparty, c.currency)));
  const byPayee = new Map<string, budget.BudgetTxn[]>();
  for (const t of book.transactions) {
    if (!t.amount.lt(ZERO) || t.isInternalTransfer) continue;
    const key = groupKey(budget.txnMerchantKey(t), t.currency);
    if (!wanted.has(key)) continue;
    const seen = byPayee.get(key);
    if (seen === undefined) byPayee.set(key, [t]);
    else seen.push(t);
  }
  const members = new Map<budget.RecurringCandidate, budget.BudgetTxn[]>(
    candidates.map((c) => [c, []]),
  );
  for (const [key, rows] of byPayee) {
    const own = candidates.filter((c) => groupKey(c.counterparty, c.currency) === key);
    const byDate = [...rows].sort((a, b) =>
      a.bookingDate < b.bookingDate ? -1 : a.bookingDate > b.bookingDate ? 1 : 0,
    );
    const loose: budget.BudgetTxn[] = [];
    for (const t of byDate) {
      const amount = t.amount.copyAbs();
      let best: budget.RecurringCandidate | null = null;
      for (const c of own) {
        if (!inBand(amount, c.typicalAmount, tolerance)) continue;
        if (
          best === null ||
          amount.sub(c.typicalAmount).copyAbs().lt(amount.sub(best.typicalAmount).copyAbs())
        )
          best = c;
      }
      if (best === null) loose.push(t);
      else members.get(best)?.push(t);
    }
    for (const c of own) {
      const series = members.get(c) as budget.BudgetTxn[];
      let last = series.at(-1)?.bookingDate ?? c.lastDate;
      for (let i = 0; i < loose.length; i++) {
        const t = loose[i] as budget.BudgetTxn;
        if (t.bookingDate <= last) continue;
        const off = Math.abs(
          daysBetween(budget.nextChargeDate(last, c.medianGapDays), t.bookingDate),
        );
        if (off > budget.SERIES_DATE_SLACK_DAYS) continue;
        series.push(t);
        last = t.bookingDate;
        loose.splice(i, 1);
        i--;
      }
    }
  }
  return candidates.map((c) => ({
    candidate: c,
    key: `${c.counterparty}:${c.currency}:${c.typicalAmount.toString()}`,
    rows: members.get(c) as budget.BudgetTxn[],
  }));
}
