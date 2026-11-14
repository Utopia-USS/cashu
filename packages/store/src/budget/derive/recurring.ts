// Deriver budget.recurring (M3 companion performance): the recurring payments per (merchant key,
// currency) group, so the phone's bills, upcoming charges and payee changes read a few stored rows
// instead of detecting over the whole book (`budget.recurringPayments` + `budget.recurringSeries`).
//
// Four tables (`recurring-groups.ts` computes a group):
// - `fold_recurring_rows`: every row that counts in a group (a non-internal outflow with a merchant
//   key on an account that is not removed), clustered by group in book order, with what the detection
//   reads: amount, outflow key when it is a detection member, the category it is judged by (its
//   stored category, the categories deriver runs before this one; the engine only for rows with none,
//   `engine` 1), and its display payee. A group read is one range scan of it.
// - `fold_recurring`: one row per recurring candidate of every group over ALL its rows (no `today`
//   cut, every candidate counted active), with its series summary (newest charge's payee and account,
//   first and newest charge, the last 12 charges). The queries decide "active" (45 days before the
//   vault's newest booking date up to `today`) and recompute the few groups the stored answer does not
//   cover (charges after `today`, a group with both active and stale candidates) from the rows table.
// - `fold_recurring_keys`: per group and amount key, the detection members with that amount (`n`) and
//   how many of them are filed `subscriptions` or unfiled (`filed`); `fold_recurring_groups`: the
//   groups where some amount repeats `RECURRING_MIN_OCCURRENCES` times or some member is filed so
//   (`budget.RECURRING_FILED_CATEGORIES`). Only such a group can hold a candidate (the domain's
//   `detectRecurringGroup` returns nothing for the others), so neither the deriver nor the queries read
//   the rows of any other group: a subset of a group's rows (the queries' `<= today` cut) cannot recur
//   either.
//
// Incremental unit = the group. Per apply the candidate rows are the dirty transaction partitions, the
// rows whose category or transfer flag changed (read from `fold_category_changes` without taking
// them: this deriver runs between the categories and the months derivers, the months deriver takes
// them) and the engine-judged rows of a re-ruled payee. A row whose stored entry is unchanged is
// skipped; a changed, new or vanished one updates its group's counts and recomputes its old and new
// group when that group may recur or holds a record (else nothing to read). A change of the visible
// accounts or their types (signature in `fold_recurring_env`), a contribution change (the payment
// patterns the engine reads: the engine passes it as "all"), a full pass of the categories deriver, a
// full re-fold or a bulk dirty set runs `deriveAll`, which writes only what differs (the counts move
// with the entries it changes). A merchant rule whose row is gone re-judges every engine-judged row.
import { budget, D, type IsoDate } from "@cashu/domain";
import type { DeriveContext, Deriver } from "../../engine/types.js";
import type { Read } from "../../query.js";
import { type IndexDef, indexName, type TableDef } from "../../sql/ddl.js";
import { budgetEngineContext } from "../read-models.js";
import {
  BOOK_ORDER,
  displayPayee,
  GROUP_ENTRIES_SQL,
  type GroupEntryRow,
  groupRecords,
  outflowKey,
  type RecurringRecord,
} from "../recurring-groups.js";
import { CASHEXP, CASHLEG, splitKey, TRANSACTIONS } from "../transactions.js";
import { ALL_CHANGED, categoriesDeriver, categoryChanges } from "./categories.js";
import { selectIn } from "./keys.js";

/**
 * The public tables written in every apply that changes the records (a live query over them wakes with
 * these): the rows, the accounts (visibility, type) and, for a row the engine judges, the merchant
 * rules. The modules' payment patterns are contributions: the overview reads them (`upcomingOf`).
 */
const WAKES_WITH = [TRANSACTIONS, "accounts", "category_rules"] as const;

/** One row per recurring candidate (see `RecurringRecord`). */
const recurringTable: TableDef = {
  name: "fold_recurring",
  primaryKey: ["merchant_key", "currency", "typical_amount"],
  internal: true,
  // a companion deriver's table: derived again on import (Deriver.companion)
  snapshot: false,
  withoutRowid: true,
  wakesWith: WAKES_WITH,
  columns: [
    { name: "merchant_key", type: "TEXT", notNull: true },
    { name: "currency", type: "TEXT", notNull: true },
    { name: "typical_amount", type: "TEXT", notNull: true },
    { name: "occurrences", type: "INTEGER", notNull: true },
    { name: "months_covered", type: "INTEGER", notNull: true },
    { name: "median_gap_days", type: "INTEGER", notNull: true },
    { name: "last_date", type: "TEXT", notNull: true },
    { name: "seq_account", type: "INTEGER", notNull: true },
    { name: "seq_id", type: "INTEGER", notNull: true },
    { name: "payee", type: "TEXT", notNull: true },
    { name: "account_id", type: "INTEGER" },
    { name: "charge_last", type: "TEXT" },
    { name: "first_seen", type: "TEXT", notNull: true },
    /** JSON `[[date, amount]]`, newest first, positive. */
    { name: "charges", type: "TEXT", notNull: true },
  ],
};

/** Every row that counts in a group, clustered by group in book order (`GroupEntryRow`). */
const recurringRowsTable: TableDef = {
  name: "fold_recurring_rows",
  primaryKey: ["merchant_key", "currency", "account_id", "id"],
  internal: true,
  // a companion deriver's table: derived again on import (Deriver.companion)
  snapshot: false,
  withoutRowid: true,
  wakesWith: WAKES_WITH,
  columns: [
    { name: "merchant_key", type: "TEXT", notNull: true },
    { name: "currency", type: "TEXT", notNull: true },
    { name: "account_id", type: "INTEGER", notNull: true },
    /** `transactions.id`. */
    { name: "id", type: "INTEGER", notNull: true },
    /** The row key (the transactions partition). */
    { name: "row", type: "TEXT", notNull: true },
    { name: "booking_date", type: "TEXT", notNull: true },
    { name: "amount", type: "TEXT", notNull: true },
    /** `format2(-amount)` for a detection member, else NULL (its category is not a subscription's). */
    { name: "amount_key", type: "TEXT" },
    { name: "category", type: "TEXT", notNull: true },
    /** The row's display payee (the series' newest charge names the payee). */
    { name: "payee", type: "TEXT", notNull: true },
    /** 1: no stored category, judged by the engine (a merchant rule can move it). */
    { name: "engine", type: "INTEGER", notNull: true },
  ],
  indexes: [
    { columns: ["row"], unique: true },
    { columns: ["merchant_key", "engine"], where: "engine = 1" },
  ],
};

/** A `fold_recurring_keys` row that lets its group recur (`budget.detectRecurringGroup`). */
const MAY_RECUR_WHERE = `n >= ${budget.RECURRING_MIN_OCCURRENCES} OR filed > 0`;
const MAY_RECUR = `(${MAY_RECUR_WHERE})`;

const MAY_RECUR_INDEX: IndexDef = { columns: ["merchant_key", "currency"], where: MAY_RECUR_WHERE };

/** Per group and amount key: detection members (`n`) and those filed so (`filed`). */
const keysTable: TableDef = {
  name: "fold_recurring_keys",
  primaryKey: ["merchant_key", "currency", "amount_key"],
  internal: true,
  // a companion deriver's table: derived again on import (Deriver.companion)
  snapshot: false,
  withoutRowid: true,
  columns: [
    { name: "merchant_key", type: "TEXT", notNull: true },
    { name: "currency", type: "TEXT", notNull: true },
    { name: "amount_key", type: "TEXT", notNull: true },
    { name: "n", type: "INTEGER", notNull: true },
    { name: "filed", type: "INTEGER", notNull: true },
  ],
  indexes: [MAY_RECUR_INDEX],
};

/** Whether a group may recur is one seek (`markGroup` names it: the planner prefers the key). */
const MAY_RECUR_KEYS = `fold_recurring_keys INDEXED BY ${indexName(keysTable, MAY_RECUR_INDEX)}`;

/** The groups that may recur (a key with `MAY_RECUR`): the only ones the detection reads. */
const groupsTable: TableDef = {
  name: "fold_recurring_groups",
  primaryKey: ["merchant_key", "currency"],
  internal: true,
  // a companion deriver's table: derived again on import (Deriver.companion)
  snapshot: false,
  withoutRowid: true,
  wakesWith: WAKES_WITH,
  columns: [
    { name: "merchant_key", type: "TEXT", notNull: true },
    { name: "currency", type: "TEXT", notNull: true },
  ],
};

const FILED = new Set(budget.RECURRING_FILED_CATEGORIES);

const envTable: TableDef = {
  name: "fold_recurring_env",
  primaryKey: ["k"],
  internal: true,
  // a companion deriver's table: derived again on import (Deriver.companion)
  snapshot: false,
  withoutRowid: true,
  columns: [
    { name: "k", type: "TEXT", notNull: true },
    { name: "v", type: "TEXT", notNull: true },
  ],
};

/** Same bulk rule as the categories deriver: a full pass beats per-group work on big dirty sets. */
const FULL_PASS_SHARE = 8;
const FULL_PASS_MIN = 256;
/** Rows per read of the full pass. */
const CHUNK_ROWS = 4096;

/** The row key of a view row (the transactions materializer's partition). */
const ROW_KEY = `CASE WHEN t.dedup_hash LIKE '${CASHEXP}%' THEN t.dedup_hash
  ELSE v.gid || '|' || t.dedup_hash || '|' || t.occurrence END`;

/** A view row with what decides its entry. */
interface KeyedRow {
  readonly row: string;
  readonly mk: string | null;
  readonly currency: string;
  readonly internal: number;
  readonly removed: number;
  readonly id: number;
  readonly account: number;
  readonly date: IsoDate;
  readonly amount: string;
  readonly category: string | null;
  readonly source: string | null;
  readonly name: string | null;
  readonly iban: string | null;
  readonly description: string | null;
  readonly reference: string | null;
  readonly accountType: string;
}

const KEYED_SELECT = `SELECT ${ROW_KEY} AS row, t.merchant_key AS mk, t.currency,
    t.is_internal_transfer AS internal, (a.removed_at IS NOT NULL) AS removed,
    t.id, t.account_id AS account, t.booking_date AS date, t.amount, t.category,
    t.category_source AS source, t.counterparty_name AS name, t.counterparty_iban AS iban,
    t.description, t.reference, a.type AS accountType
  FROM transactions t JOIN view_ids v ON v.id = t.account_id JOIN accounts a ON a.id = t.account_id`;

/** A row's stored entry (`fold_recurring_rows`). */
interface Entry {
  readonly mk: string;
  readonly currency: string;
  readonly account: number;
  readonly id: number;
  readonly date: string;
  readonly amount: string;
  readonly amountKey: string | null;
  readonly category: string;
  readonly payee: string;
  readonly engine: number;
}

const ENTRY_COLUMNS = `merchant_key AS mk, currency, account_id AS account, id,
  booking_date AS date, amount, amount_key AS amountKey, category, payee, engine`;

const sameEntry = (a: Entry, b: Entry): boolean =>
  a.mk === b.mk &&
  a.currency === b.currency &&
  a.account === b.account &&
  a.id === b.id &&
  a.date === b.date &&
  a.amount === b.amount &&
  a.amountKey === b.amountKey &&
  a.category === b.category &&
  a.payee === b.payee &&
  a.engine === b.engine;

interface Env {
  readonly notSubscription: ReadonlySet<string>;
  /** The engine's category without the recurring signal (built on its first use). */
  engine(r: KeyedRow): string;
}

function envOf(ctx: DeriveContext): Env {
  let categorizer: budget.Categorizer | null = null;
  const none: ReadonlySet<string> = new Set();
  return {
    notSubscription: new Set([
      ...budget.NOT_SUBSCRIPTION_CATEGORIES,
      ...ctx.contributions.notSubscriptionCategories(),
    ]),
    engine(r) {
      if (categorizer === null) {
        const read: Read = (sql, ...params) => ctx.sql.all(sql, ...params);
        categorizer = budget.createCategorizer(
          budgetEngineContext(read, ctx.contributions.paymentPatterns()),
        );
      }
      return categorizer.categorize(
        {
          amount: D(r.amount),
          counterpartyName: r.name,
          counterpartyIban: r.iban,
          description: r.description,
          reference: r.reference,
          isInternalTransfer: false,
        },
        none,
      ).category;
    },
  };
}

/** The entry a view row has now, or null when it counts in no group. */
function entryOf(r: KeyedRow, env: Env): Entry | null {
  if (r.removed === 1 || r.internal === 1 || !r.mk) return null;
  const key = outflowKey(r.amount);
  if (key === null) return null;
  const stored = budget.storedRecurringCategory(r.category, r.source);
  const category = stored ?? env.engine(r);
  return {
    mk: r.mk,
    currency: r.currency,
    account: r.account,
    id: r.id,
    date: r.date,
    amount: r.amount,
    amountKey: env.notSubscription.has(category) ? null : key,
    category,
    payee: displayPayee(
      r.name,
      r.reference,
      r.description,
      r.accountType === budget.CASH_ACCOUNT_TYPE,
    ),
    engine: stored === null ? 1 : 0,
  };
}

const groupId = (mk: string, currency: string): string => JSON.stringify([mk, currency]);

/** The view rows the row keys name now (keys naming no row, and cash legs, are absent). */
function rowsByKey(ctx: DeriveContext, keys: readonly string[]): Map<string, KeyedRow> {
  const wanted = new Set(keys);
  const out = new Map<string, KeyedRow>();
  const hashesByRoot = new Map<string, string[]>();
  const expenses: string[] = [];
  for (const key of wanted) {
    if (key.startsWith(CASHEXP)) expenses.push(key.slice(CASHEXP.length));
    else if (!key.startsWith(CASHLEG)) {
      const [root, hash] = splitKey(key);
      const list = hashesByRoot.get(root) ?? [];
      list.push(hash);
      hashesByRoot.set(root, list);
    }
  }
  const take = (rows: KeyedRow[]) => {
    for (const r of rows) if (wanted.has(r.row)) out.set(r.row, r);
  };
  for (const [root, hashes] of hashesByRoot) {
    take(
      selectIn<KeyedRow>(
        ctx.sql,
        `${KEYED_SELECT} WHERE t.account_id = (SELECT id FROM view_ids WHERE gid = ?)
           AND t.dedup_hash IN (%IN%)`,
        [...new Set(hashes)],
        [root],
      ),
    );
  }
  take(
    selectIn<KeyedRow>(
      ctx.sql,
      `${KEYED_SELECT} WHERE t.gid IN (%IN%) AND t.dedup_hash LIKE '${CASHEXP}%'`,
      expenses,
    ),
  );
  return out;
}

/** The visible accounts and their types (the rows' visibility and display payees depend on them). */
function envSignature(ctx: DeriveContext): string {
  return JSON.stringify(
    ctx.sql
      .all<{ id: number; removed: number; type: string }>(
        "SELECT id, (removed_at IS NOT NULL) AS removed, type FROM accounts ORDER BY id",
      )
      .map((a) => [a.id, a.removed, a.type]),
  );
}

function storedSignature(ctx: DeriveContext): string | undefined {
  return ctx.sql.get<{ v: string }>("SELECT v FROM fold_recurring_env WHERE k = 'env'")?.v;
}

function deleteEntry(ctx: DeriveContext, e: Entry): void {
  ctx.sql.write(
    recurringRowsTable.name,
    `DELETE FROM fold_recurring_rows
     WHERE merchant_key = ? AND currency = ? AND account_id = ? AND id = ?`,
    e.mk,
    e.currency,
    e.account,
    e.id,
  );
}

function insertEntry(ctx: DeriveContext, key: string, e: Entry): void {
  ctx.sql.insert(
    recurringRowsTable.name,
    `INSERT INTO fold_recurring_rows (merchant_key, currency, account_id, id, row, booking_date,
       amount, amount_key, category, payee, engine)`,
    "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    e.mk,
    e.currency,
    e.account,
    e.id,
    key,
    e.date,
    e.amount,
    e.amountKey,
    e.category,
    e.payee,
    e.engine,
  );
}

/** One row's stored entry before and now (null: none). */
interface EntryChange {
  readonly key: string;
  readonly old: Entry | undefined;
  readonly now: Entry | null;
}

/** Count deltas per `[merchant key, currency, amount key]` (JSON). */
type KeyDeltas = Map<string, { n: number; filed: number }>;

function countEntry(deltas: KeyDeltas, e: Entry, sign: 1 | -1): void {
  if (e.amountKey === null) return;
  const k = JSON.stringify([e.mk, e.currency, e.amountKey]);
  const d = deltas.get(k) ?? { n: 0, filed: 0 };
  d.n += sign;
  if (FILED.has(e.category)) d.filed += sign;
  deltas.set(k, d);
}

/** Apply count deltas to `fold_recurring_keys` (in key order), dropping keys that reach zero. */
function applyKeyDeltas(ctx: DeriveContext, deltas: KeyDeltas): void {
  for (const [k, d] of [...deltas].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (d.n === 0 && d.filed === 0) continue;
    const [mk, currency, amountKey] = JSON.parse(k) as [string, string, string];
    ctx.sql.write(
      keysTable.name,
      `INSERT INTO fold_recurring_keys (merchant_key, currency, amount_key, n, filed)
       VALUES (?, ?, ?, ?, ?) ON CONFLICT (merchant_key, currency, amount_key)
       DO UPDATE SET n = n + excluded.n, filed = filed + excluded.filed`,
      mk,
      currency,
      amountKey,
      d.n,
      d.filed,
    );
    if (d.n < 0) {
      ctx.sql.write(
        keysTable.name,
        `DELETE FROM fold_recurring_keys
         WHERE merchant_key = ? AND currency = ? AND amount_key = ? AND n = 0`,
        mk,
        currency,
        amountKey,
      );
    }
  }
}

/**
 * Store the changed entries (every delete before any insert: a row key that moved keeps its id) with
 * their counts (`fold_recurring_keys`) and return the groups they touched.
 */
function setEntries(ctx: DeriveContext, changes: Iterable<EntryChange>): Set<string> {
  const groups = new Set<string>();
  const inserts: EntryChange[] = [];
  const deltas: KeyDeltas = new Map();
  for (const c of changes) {
    if (c.old !== undefined && c.now !== null && sameEntry(c.old, c.now)) continue;
    if (c.old !== undefined) {
      groups.add(groupId(c.old.mk, c.old.currency));
      deleteEntry(ctx, c.old);
      countEntry(deltas, c.old, -1);
    }
    if (c.now !== null) {
      groups.add(groupId(c.now.mk, c.now.currency));
      inserts.push(c);
      countEntry(deltas, c.now, 1);
    }
  }
  applyKeyDeltas(ctx, deltas);
  // in key order: a bulk insert appends to the clustered table instead of splitting its pages
  const byKey = (a: Entry, b: Entry) =>
    a.mk < b.mk
      ? -1
      : a.mk > b.mk
        ? 1
        : a.currency < b.currency
          ? -1
          : a.currency > b.currency
            ? 1
            : a.account - b.account || a.id - b.id;
  inserts.sort((a, b) => byKey(a.now as Entry, b.now as Entry));
  for (const c of inserts) insertEntry(ctx, c.key, c.now as Entry);
  return groups;
}

interface StoredRecord {
  merchant_key: string;
  currency: string;
  typical_amount: string;
  occurrences: number;
  months_covered: number;
  median_gap_days: number;
  last_date: string;
  seq_account: number;
  seq_id: number;
  payee: string;
  account_id: number | null;
  charge_last: string | null;
  first_seen: string;
  charges: string;
}

/** A record as its stored columns, in column order (equal arrays: equal rows). */
const columnsOf = (r: RecurringRecord): (string | number | null)[] => [
  r.merchantKey,
  r.currency,
  r.typicalAmount,
  r.occurrences,
  r.monthsCovered,
  r.medianGapDays,
  r.lastDate,
  r.seqAccount,
  r.seqId,
  r.payee,
  r.accountId,
  r.chargeLast,
  r.firstSeen,
  r.charges,
];

const storedColumns = (s: StoredRecord): (string | number | null)[] => [
  s.merchant_key,
  s.currency,
  s.typical_amount,
  s.occurrences,
  s.months_covered,
  s.median_gap_days,
  s.last_date,
  s.seq_account,
  s.seq_id,
  s.payee,
  s.account_id,
  s.charge_last,
  s.first_seen,
  s.charges,
];

/** Store a group's records, writing only what changed. */
function writeGroup(
  ctx: DeriveContext,
  stored: readonly StoredRecord[],
  records: readonly RecurringRecord[],
): void {
  const before = new Map(stored.map((s) => [s.typical_amount, JSON.stringify(storedColumns(s))]));
  for (const r of records) {
    const cols = columnsOf(r);
    const old = before.get(r.typicalAmount);
    before.delete(r.typicalAmount);
    if (old === JSON.stringify(cols)) continue;
    ctx.sql.write(
      recurringTable.name,
      `INSERT OR REPLACE INTO fold_recurring (merchant_key, currency, typical_amount, occurrences,
         months_covered, median_gap_days, last_date, seq_account, seq_id, payee, account_id,
         charge_last, first_seen, charges) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ...cols,
    );
  }
  for (const s of stored) {
    if (!before.has(s.typical_amount)) continue;
    ctx.sql.write(
      recurringTable.name,
      "DELETE FROM fold_recurring WHERE merchant_key = ? AND currency = ? AND typical_amount = ?",
      s.merchant_key,
      s.currency,
      s.typical_amount,
    );
  }
}

/**
 * Recompute the groups (JSON `[merchant key, currency]`) from the rows table: first whether each may
 * recur (its counts, `fold_recurring_groups`); a group that cannot and holds no record has nothing to
 * read (its detection is empty, as its stored answer).
 */
function recomputeGroups(ctx: DeriveContext, groups: Iterable<string>): void {
  for (const g of groups) {
    const [mk, currency] = JSON.parse(g) as [string, string];
    const may = markGroup(ctx, mk, currency);
    const stored = ctx.sql.all<StoredRecord>(
      "SELECT * FROM fold_recurring WHERE merchant_key = ? AND currency = ?",
      mk,
      currency,
    );
    if (!may && stored.length === 0) continue;
    const rows = may
      ? ctx.sql.all<GroupEntryRow>(`${GROUP_ENTRIES_SQL} ${BOOK_ORDER}`, mk, currency)
      : [];
    writeGroup(ctx, stored, groupRecords(mk, currency, rows));
  }
}

/** Whether the group may recur now (its counts), kept in `fold_recurring_groups`. */
function markGroup(ctx: DeriveContext, mk: string, currency: string): boolean {
  const may =
    ctx.sql.get(
      `SELECT 1 AS x FROM ${MAY_RECUR_KEYS}
       WHERE merchant_key = ? AND currency = ? AND ${MAY_RECUR} LIMIT 1`,
      mk,
      currency,
    ) !== undefined;
  const was =
    ctx.sql.get(
      "SELECT 1 AS x FROM fold_recurring_groups WHERE merchant_key = ? AND currency = ?",
      mk,
      currency,
    ) !== undefined;
  if (may !== was) {
    ctx.sql.write(
      groupsTable.name,
      may
        ? "INSERT INTO fold_recurring_groups (merchant_key, currency) VALUES (?, ?)"
        : "DELETE FROM fold_recurring_groups WHERE merchant_key = ? AND currency = ?",
      mk,
      currency,
    );
  }
  return may;
}

function deriveAll(ctx: DeriveContext): void {
  const env = envOf(ctx);
  // Every row that counts in a group, read in id-order chunks.
  const entries = new Map<string, Entry>();
  let after = 0;
  for (;;) {
    const chunk = ctx.sql.all<KeyedRow>(
      `${KEYED_SELECT} WHERE t.id > ? AND t.merchant_key <> '' AND t.is_internal_transfer = 0
         AND a.removed_at IS NULL ORDER BY t.id LIMIT ${CHUNK_ROWS}`,
      after,
    );
    for (const r of chunk) {
      const e = entryOf(r, env);
      if (e !== null) entries.set(r.row, e);
    }
    if (chunk.length < CHUNK_ROWS) break;
    after = (chunk.at(-1) as KeyedRow).id;
  }
  // fold_recurring_rows: write only what differs from the last derivation.
  const changes: EntryChange[] = [];
  for (const s of ctx.sql.all<Entry & { row: string }>(
    `SELECT row, ${ENTRY_COLUMNS} FROM fold_recurring_rows`,
  )) {
    changes.push({ key: s.row, old: s, now: entries.get(s.row) ?? null });
    entries.delete(s.row);
  }
  for (const [key, now] of entries) changes.push({ key, old: undefined, now });
  for (const g of setEntries(ctx, changes)) {
    const [mk, currency] = JSON.parse(g) as [string, string];
    markGroup(ctx, mk, currency);
  }
  // fold_recurring: every group from the rows table, compared with the stored records.
  const stored = new Map<string, StoredRecord[]>();
  for (const s of ctx.sql.all<StoredRecord>("SELECT * FROM fold_recurring")) {
    const g = groupId(s.merchant_key, s.currency);
    const list = stored.get(g);
    if (list === undefined) stored.set(g, [s]);
    else list.push(s);
  }
  // only the groups that may recur hold candidates; the others' records (none) are removed below
  let group: { mk: string; currency: string; rows: GroupEntryRow[] } | null = null;
  const flush = () => {
    if (group === null) return;
    const g = groupId(group.mk, group.currency);
    writeGroup(ctx, stored.get(g) ?? [], groupRecords(group.mk, group.currency, group.rows));
    stored.delete(g);
  };
  for (const r of ctx.sql.all<GroupEntryRow & { mk: string; currency: string }>(
    `SELECT r.merchant_key AS mk, r.currency, r.account_id AS account, r.id,
       r.booking_date AS date, r.amount, r.amount_key AS amountKey, r.category, r.payee
     FROM fold_recurring_groups g JOIN fold_recurring_rows r
       ON r.merchant_key = g.merchant_key AND r.currency = g.currency
     ORDER BY r.merchant_key, r.currency, r.account_id, r.id`,
  )) {
    if (group === null || group.mk !== r.mk || group.currency !== r.currency) {
      flush();
      group = { mk: r.mk, currency: r.currency, rows: [] };
    }
    group.rows.push(r);
  }
  flush();
  for (const gone of stored.values()) writeGroup(ctx, gone, []);
  ctx.sql.write(
    envTable.name,
    "INSERT OR REPLACE INTO fold_recurring_env (k, v) VALUES ('env', ?)",
    envSignature(ctx),
  );
}

export const recurringDeriver: Deriver = {
  id: "budget.recurring",
  // Only the phone reads it (companion queries): registered with `StoreOptions.companionReads`.
  companion: true,
  // 2: the per-group counts (`fold_recurring_keys`, `fold_recurring_groups`)
  version: 2,
  tables: [recurringTable, recurringRowsTable, keysTable, groupsTable, envTable],
  writes: [],
  // The categories deriver's inputs: it runs whenever that one did and reads its changes
  // (handover.test.ts checks the pair and the order categories, recurring, months).
  inputs: categoriesDeriver.inputs,
  derive(dirty, ctx) {
    const changes = categoryChanges(ctx);
    const txns = dirty.get("budget.transactions");
    const rules = dirty.get("budget.category_rules");
    if (txns === "all" || rules === "all" || changes.includes(ALL_CHANGED)) {
      deriveAll(ctx);
      return;
    }
    const signature = storedSignature(ctx);
    if (
      (signature === undefined || dirty.has("core.accounts")) &&
      envSignature(ctx) !== signature
    ) {
      deriveAll(ctx);
      return;
    }
    const keys = new Set([...(txns ?? []), ...changes]);
    // a merchant rule moves the engine-judged rows of its payee
    let everyEngineRow = false;
    for (const gid of rules ?? []) {
      const r = ctx.sql.get<{ merchant_key: string }>(
        "SELECT merchant_key FROM category_rules WHERE gid = ?",
        gid,
      );
      if (r === undefined) {
        everyEngineRow = true; // a rule row gone: its payee is unknown, re-judge every such row
        continue;
      }
      for (const e of ctx.sql.all<{ row: string }>(
        "SELECT row FROM fold_recurring_rows WHERE merchant_key = ? AND engine = 1",
        r.merchant_key,
      )) {
        keys.add(e.row);
      }
    }
    if (everyEngineRow) {
      for (const e of ctx.sql.all<{ row: string }>(
        "SELECT row FROM fold_recurring_rows WHERE engine = 1",
      )) {
        keys.add(e.row);
      }
    }
    if (keys.size === 0) return;
    if (keys.size >= FULL_PASS_MIN) {
      const total =
        ctx.sql.get<{ n: number }>("SELECT count(*) AS n FROM fold_recurring_rows")?.n ?? 0;
      if (keys.size * FULL_PASS_SHARE > total) {
        deriveAll(ctx);
        return;
      }
    }
    const list = [...keys];
    const old = new Map(
      selectIn<Entry & { row: string }>(
        ctx.sql,
        `SELECT row, ${ENTRY_COLUMNS} FROM fold_recurring_rows WHERE row IN (%IN%)`,
        list,
      ).map((e) => [e.row, e]),
    );
    const rows = rowsByKey(ctx, list);
    const env = envOf(ctx);
    const groups = setEntries(
      ctx,
      list.map((key) => {
        const row = rows.get(key);
        return { key, old: old.get(key), now: row === undefined ? null : entryOf(row, env) };
      }),
    );
    if (groups.size > 0) recomputeGroups(ctx, groups);
  },
  deriveAll,
};
