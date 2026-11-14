// The recurring payments of one (merchant key, currency) group: the recurring deriver
// (`budget.recurring`) stores them per group, the phone's recurring reads recompute a group the
// stored answer does not cover (charges dated after `today`, a group with stale candidates).
//
// A group is the non-internal outflows of one merchant key and currency on the accounts that are not
// removed, in book order (`budgetBook`: account id, then row id): exactly the rows the book-based
// `budget.recurringPayments` + `budget.recurringSeries` read for that payee. The deriver keeps them in
// `fold_recurring_rows`, clustered by group in book order, each with what the detection reads: its
// amount, its outflow key when it is a detection member, the category it is judged by (its stored
// category, `budget.storedRecurringCategory`, else the engine's without the recurring signal) and its
// display payee. The candidates are the domain's per-group detection (`budget.detectRecurringGroup`),
// each with its own charges (`budget.groupSeries`) over the candidates the caller counts as active.
import { budget, D, type Decimal, format2, type IsoDate, ZERO } from "@cashu/domain";

/** One outflow of a group as `fold_recurring_rows` keeps it. */
export interface GroupEntryRow {
  readonly account: number;
  readonly id: number;
  readonly date: IsoDate;
  /** The amount as stored. */
  readonly amount: string;
  /** `format2(-amount)` when the row is a detection member (its category not excluded), else null. */
  readonly amountKey: string | null;
  /** The category the detection judges it by. */
  readonly category: string;
  /** The row's display payee (`displayPayee`). */
  readonly payee: string;
}

/** A group's outflows in book order (binds: merchant key, currency; the table's key order). */
export const GROUP_ENTRIES_SQL = `SELECT account_id AS account, id, booking_date AS date, amount,
    amount_key AS amountKey, category, payee
  FROM fold_recurring_rows WHERE merchant_key = ? AND currency = ?`;
export const BOOK_ORDER = "ORDER BY account_id, id";

const CANONICAL_OUTFLOW = /^-(?:0|[1-9]\d*)\.\d\d$/;

/**
 * `format2(-amount)` of an outflow (amount < 0), null for anything else: the stored text itself for a
 * canonical two-decimal amount, the exact decimal otherwise.
 */
export function outflowKey(amount: string): string | null {
  if (CANONICAL_OUTFLOW.test(amount)) return amount === "-0.00" ? null : amount.slice(1);
  const d = D(amount);
  return d.lt(ZERO) ? format2(d.neg()) : null;
}

/** One recurring candidate with its series, as stored in `fold_recurring` (text columns). */
export interface RecurringRecord {
  readonly merchantKey: string;
  readonly currency: string;
  /** `Decimal.toString()` (exact round trip). */
  readonly typicalAmount: string;
  readonly occurrences: number;
  readonly monthsCovered: number;
  readonly medianGapDays: number;
  /** The candidate's own last charge (`activeRecurring` reads it). */
  readonly lastDate: IsoDate;
  /** The book position of the row it was first seen at (account id, row id): the list order. */
  readonly seqAccount: number;
  readonly seqId: number;
  /** The display payee of its newest charge, else the merchant key. */
  readonly payee: string;
  /** The account of its newest charge. */
  readonly accountId: number | null;
  /** Its newest charge's date (a price rise may continue the series after `lastDate`). */
  readonly chargeLast: IsoDate | null;
  /** Its first charge's date, else `lastDate`. */
  readonly firstSeen: IsoDate;
  /** JSON `[[date, amount]]`: its last charges, newest first, positive (`Decimal.toString()`). */
  readonly charges: string;
}

/** How many charges a record keeps (the payee changes read the last 12). */
const RECORD_CHARGES = 12;
const PAYEE_DESCRIPTION_CHARS = 40;

/** The row's display payee: counterparty, else the cash title, else the description's start. */
export function displayPayee(
  name: string | null,
  reference: string | null,
  description: string | null,
  cash: boolean,
): string {
  if (name) return name;
  if (cash && reference) return reference;
  if (description) return Array.from(description).slice(0, PAYEE_DESCRIPTION_CHARS).join("");
  return reference ?? "";
}

interface Outflow {
  readonly row: GroupEntryRow;
  readonly bookingDate: IsoDate;
  readonly amount: Decimal;
}

/**
 * The recurring records of one group from its outflows (book order), in list order (last date newest
 * first, then first seen). `active` picks the candidates whose series are formed (the others take no
 * charges and are left out); default every candidate.
 */
export function groupRecords(
  merchantKey: string,
  currency: string,
  rows: readonly GroupEntryRow[],
  active: (c: budget.RecurringCandidate) => boolean = () => true,
): RecurringRecord[] {
  const entries: budget.RecurringGroupEntry[] = [];
  const entryRow: GroupEntryRow[] = [];
  for (const row of rows) {
    if (row.amountKey === null) continue;
    entries.push({ date: row.date, amountKey: row.amountKey, category: row.category });
    entryRow.push(row);
  }
  if (entries.length === 0) return [];
  const found = budget.recurringOrder(
    budget.detectRecurringGroup(merchantKey, currency, entries),
    (f) => f.first,
  );
  const own = found.filter((f) => active(f.candidate));
  if (own.length === 0) return [];
  const outflows: Outflow[] = rows.map((row) => ({
    row,
    bookingDate: row.date,
    amount: D(row.amount),
  }));
  const series = budget.groupSeries(
    own.map((f) => f.candidate),
    outflows,
  );
  return own.map((f, i) => {
    const c = f.candidate;
    const charges = series[i] as Outflow[];
    const first = entryRow[f.first] as GroupEntryRow;
    const newest = charges.at(-1);
    return {
      merchantKey,
      currency,
      typicalAmount: c.typicalAmount.toString(),
      occurrences: c.occurrences,
      monthsCovered: c.monthsCovered,
      medianGapDays: c.medianGapDays,
      lastDate: c.lastDate,
      seqAccount: first.account,
      seqId: first.id,
      payee: (newest === undefined ? "" : newest.row.payee) || merchantKey,
      accountId: newest === undefined ? null : newest.row.account,
      chargeLast: newest === undefined ? null : newest.bookingDate,
      firstSeen: charges[0]?.bookingDate ?? c.lastDate,
      charges: JSON.stringify(
        charges
          .slice(-RECORD_CHARGES)
          .reverse()
          .map((t) => [t.bookingDate, t.amount.copyAbs().toString()]),
      ),
    };
  });
}

/** List order of records: last date newest first, then first seen (book position). */
export function compareRecords(a: RecurringRecord, b: RecurringRecord): number {
  if (a.lastDate !== b.lastDate) return a.lastDate < b.lastDate ? 1 : -1;
  return a.seqAccount - b.seqAccount || a.seqId - b.seqId;
}
