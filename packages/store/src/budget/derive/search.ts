// Deriver budget.search (M3 companion performance): the full-text index the phone's search reads
// (`budgetSearch`) instead of a LIKE scan over every row.
//
// `fold_txn_fts` is a contentless FTS5 table (`content=''`, `contentless_delete=1`: rows are deleted
// by rowid, columns read as NULL) with one row per `transactions` row of an account that is not
// removed (the rows `budgetSearch` can list: their account row exists and is not removed), cash legs
// included:
// - rowid = `<booking day> * 2^32 + transactions.id` (`ftsRowid`; booking day = days since
//   1970-01-01): the index iterates in booking-date order, so the newest hits of a common word come
//   from the index with an early exit instead of sorting every hit, and `count(*)` of a match is the
//   number of visible hits;
// - `text`: `normalizeText(counterparty_name description reference)` and the row's `merchant_key`
//   (upper case, Polish l-stroke and every diacritic folded; the `unicode61 remove_diacritics 2`
//   tokenizer folds case and diacritics again, so a query token through `normalizeText` matches both
//   ways);
// - `amount`: the absolute amount as ONE token `<integer>d<fraction, at least 2 digits>`
//   (`-1284.00` -> `1284d00`, `12.5` -> `12d50`): unicode61 splits on `.`, so a plain `1284.00`
//   would index the fraction as its own token and the query `12` would hit `5.12`. A number typed in
//   the search is encoded the same way (`ftsAmountPrefix`) and prefix-matched.
//
// It is a pure function of the materializer-owned columns of `transactions` (text, merchant key,
// amount, booking date; a cash leg's text comes from the legs deriver, which runs first) and of which
// accounts are visible, so the snapshot leaves it and its memory out and an import derives them again
// (snapshot.ts).
//
// Incremental unit = the row. `fold_txn_fts_rows` remembers what each row key indexed (the
// transactions partition; a cash leg under its source partition, `leg` 1): its id, booking day and
// indexed text, so a vanished or re-anchored row is found and a claim-only change (category) is
// skipped. Candidates per apply: the dirty transaction partitions; after an account change every
// cash leg too (the legs deriver re-checks them all then: a pool opened or closed), and a change of
// the visible accounts (`fold_txn_fts_env`: one opened, removed or restored) re-indexes everything.
// Only that and a full re-fold rebuild the index (`deriveAll`): a document costs the same on both
// paths, so a bulk dirty set (a first sync's 1,000-event batches) stays incremental instead of
// re-indexing every row already there.
//
// Write order: FTS5 keeps the pending terms of a transaction in memory and flushes them whenever a
// rowid is not above the last one written, so documents go in ascending rowid order (measured at 60k,
// 1,000 inserts: ascending 2.2 ms, hash order 13.6 ms, descending 26 ms); the deletes too.
import { D, decimalKey, normalizeText } from "@cashu/domain";
import type { DeriveContext, Deriver } from "../../engine/types.js";
import { clearTableSql, type TableDef } from "../../sql/ddl.js";
import { CASHEXP, CASHLEG, splitKey } from "../transactions.js";
import { selectIn } from "./keys.js";

export const SEARCH_FTS = "fold_txn_fts";

/** `2^32`: an FTS rowid is `<booking day> * FTS_DAY + transactions.id`. */
export const FTS_DAY = 4_294_967_296;
/** The `transactions.id` of an FTS rowid: `rowid & FTS_ID_MASK`. */
export const FTS_ID_MASK = 4_294_967_295;

const ftsTable: TableDef = {
  name: SEARCH_FTS,
  internal: true,
  columns: [
    { name: "text", type: "TEXT" },
    { name: "amount", type: "TEXT" },
  ],
  virtual: {
    using: "fts5",
    args: ["content=''", "contentless_delete=1", "tokenize='unicode61 remove_diacritics 2'"],
  },
};

/**
 * What each row key indexed: its `transactions.id`, booking day (its FTS rowid together) and `sig`
 * (text, U+0001, amount token). Left out of snapshots: the deriver rebuilds it with the index.
 */
const rowsTable: TableDef = {
  name: "fold_txn_fts_rows",
  primaryKey: ["leg", "row"],
  internal: true,
  withoutRowid: true,
  snapshot: false,
  columns: [
    { name: "leg", type: "INTEGER", notNull: true },
    { name: "row", type: "TEXT", notNull: true },
    { name: "id", type: "INTEGER", notNull: true },
    { name: "day", type: "INTEGER", notNull: true },
    { name: "sig", type: "TEXT", notNull: true },
  ],
};

/** The visible accounts the index was built over (`k` = 'visible', `v` = JSON ids). */
const envTable: TableDef = {
  name: "fold_txn_fts_env",
  primaryKey: ["k"],
  internal: true,
  withoutRowid: true,
  snapshot: false,
  columns: [
    { name: "k", type: "TEXT", notNull: true },
    { name: "v", type: "TEXT", notNull: true },
  ],
};

/** Rows per read of the full pass. */
const CHUNK_ROWS = 4096;

/** The columns of a `transactions` row the index is a function of. */
export interface SearchSource {
  readonly id: number;
  readonly gid: string;
  readonly account_id: number;
  readonly booking_date: string;
  readonly dedup_hash: string;
  readonly occurrence: number;
  readonly amount: string;
  readonly counterparty_name: string | null;
  readonly description: string | null;
  readonly reference: string | null;
  readonly merchant_key: string | null;
}

const COLUMNS = `t.id, t.gid, t.account_id, t.booking_date, t.dedup_hash, t.occurrence, t.amount,
  t.counterparty_name, t.description, t.reference, t.merchant_key`;

/** The rows the index holds: those of the accounts that are not removed. */
const INDEXED_FROM = `FROM transactions t JOIN accounts a ON a.id = t.account_id
  WHERE a.removed_at IS NULL`;

/** The indexed `text` of a row: its statement texts and merchant key, normalized. */
export function searchText(r: SearchSource): string {
  const own = normalizeText(
    [r.counterparty_name, r.description, r.reference].filter((s) => s).join(" "),
  );
  return r.merchant_key ? `${own} ${r.merchant_key}`.trim() : own;
}

const PLAIN_AMOUNT = /^[-+]?(\d+)(?:\.(\d*))?$/;

/** The indexed `amount` token of a stored amount: `<integer>d<fraction, >= 2 digits>`, unsigned. */
export function ftsAmountToken(amount: string): string {
  // the common plain decimal text without a Decimal; anything else (an exponent) through decimalKey
  const plain = PLAIN_AMOUNT.exec(amount);
  const [int = "0", frac = ""] = plain
    ? [plain[1]?.replace(/^0+(?=\d)/, ""), plain[2]?.replace(/0+$/, "")]
    : decimalKey(D(amount).copyAbs()).split(".");
  return `${int}d${frac.padEnd(2, "0")}`;
}

/**
 * The amount prefix of a number typed in the search (`/^\d+([.,]\d+)?$/`): `1284` -> `1284`,
 * `1284,5` -> `1284d5`, `12.500` -> `12d50`; prefix-matched against `ftsAmountToken` (`1284` finds
 * 1284.00 and 12840.10, `12.5` finds 12.50 and 12.55). Zeros past the second decimal are trimmed as
 * the stored token trims them (`12.500` finds 12.50, as `12.50` does).
 */
export function ftsAmountPrefix(number: string): string {
  const [int = "", frac] = number.replace(",", ".").split(".");
  const canonical = int.replace(/^0+(?=\d)/, "");
  if (frac === undefined) return canonical;
  const digits = frac.length > 2 ? frac.replace(/0+$/, "").padEnd(2, "0") : frac;
  return `${canonical}d${digits}`;
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Days since 1970-01-01 of an ISO booking date (the high part of its FTS rowid). */
export function bookingDay(date: string): number {
  const m = ISO_DATE.exec(date);
  if (m === null) throw new RangeError(`search index: booking date ${date} is not YYYY-MM-DD`);
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 86_400_000;
}

/** The FTS rowid of (booking day, id) in SQL, from two small bound integers. */
export const FTS_ROWID_SQL = `(CAST(? AS INTEGER) * ${FTS_DAY} + CAST(? AS INTEGER))`;

function checkId(id: number): number {
  if (!Number.isInteger(id) || id < 0 || id > FTS_ID_MASK) {
    throw new RangeError(`search index: transactions.id ${id} does not fit the low 32 rowid bits`);
  }
  return id;
}

const sigOf = (text: string, amount: string): string => `${text}\u0001${amount}`;

/** Memory key: `<leg>\u0000<row>`. */
const memKey = (leg: number, row: string): string => `${leg}\u0000${row}`;

/** One document (a single-row insert: FTS5 takes multi-row VALUES slower, measured ~1.4x). */
function indexRow(ctx: DeriveContext, day: number, id: number, text: string, amount: string): void {
  ctx.sql.write(
    SEARCH_FTS,
    `INSERT INTO ${SEARCH_FTS} (rowid, text, amount) VALUES (${FTS_ROWID_SQL}, ?, ?)`,
    day,
    checkId(id),
    text,
    amount,
  );
}

function remember(
  ctx: DeriveContext,
  leg: number,
  row: string,
  id: number,
  day: number,
  sig: string,
): void {
  ctx.sql.insert(
    rowsTable.name,
    "INSERT OR REPLACE INTO fold_txn_fts_rows (leg, row, id, day, sig)",
    "(?, ?, ?, ?, ?)",
    leg,
    row,
    id,
    day,
    sig,
  );
}

/** The memory key of a loaded row on the account whose gid is `root`. */
function rowKeyOf(
  r: SearchSource,
  root: string,
  legOf: ReadonlyMap<string, string>,
): { leg: number; row: string } {
  if (r.dedup_hash.startsWith(CASHLEG)) {
    const partition = legOf.get(r.gid);
    // the legs deriver records every leg it writes; the incremental path finds legs only there
    if (partition === undefined) {
      throw new Error(`search index: cash leg ${r.gid} has no fold_txn_legs row`);
    }
    return { leg: 1, row: partition };
  }
  if (r.dedup_hash.startsWith(CASHEXP)) return { leg: 0, row: r.dedup_hash };
  return { leg: 0, row: `${root}|${r.dedup_hash}|${r.occurrence}` };
}

/**
 * The visible accounts (an `accounts` row, not removed: the index holds their rows only), as stored
 * in `fold_txn_fts_env`. A row can arrive before its account (another device's events), so an
 * account opened, removed or restored changes it.
 */
function visibleSignature(ctx: DeriveContext): string {
  return JSON.stringify(
    ctx.sql
      .all<{ id: number }>("SELECT id FROM accounts WHERE removed_at IS NULL ORDER BY id")
      .map((a) => a.id),
  );
}

function deriveAll(ctx: DeriveContext): void {
  ctx.sql.write(SEARCH_FTS, clearTableSql(ftsTable));
  ctx.sql.write(rowsTable.name, clearTableSql(rowsTable));
  const legOf = new Map(
    ctx.sql
      .all<{ partition: string; leg_gid: string }>("SELECT partition, leg_gid FROM fold_txn_legs")
      .map((l) => [l.leg_gid, l.partition]),
  );
  const roots = new Map(
    ctx.sql
      .all<{ id: number; gid: string }>(
        "SELECT id, gid FROM view_ids WHERE id IN (SELECT DISTINCT account_id FROM transactions)",
      )
      .map((v) => [v.id, v.gid]),
  );
  // In rowid order (booking date, id: the booking-date index), chunked by that key.
  let after: { date: string; id: number } = { date: "", id: 0 };
  for (;;) {
    const rows = ctx.sql.all<SearchSource>(
      `SELECT ${COLUMNS} ${INDEXED_FROM} AND (t.booking_date, t.id) > (?, ?)
       ORDER BY t.booking_date, t.id LIMIT ${CHUNK_ROWS}`,
      after.date,
      after.id,
    );
    // the chunk's documents, then its memory rows (queued: multi-row inserts)
    const memory: [number, string, number, number, string][] = [];
    for (const r of rows) {
      const text = searchText(r);
      const amount = ftsAmountToken(r.amount);
      const day = bookingDay(r.booking_date);
      const key = rowKeyOf(r, roots.get(r.account_id) ?? "", legOf);
      indexRow(ctx, day, r.id, text, amount);
      memory.push([key.leg, key.row, r.id, day, sigOf(text, amount)]);
    }
    for (const m of memory) remember(ctx, ...m);
    const last = rows.at(-1);
    if (last === undefined || rows.length < CHUNK_ROWS) break;
    after = { date: last.booking_date, id: last.id };
  }
  ctx.sql.write(
    envTable.name,
    "INSERT OR REPLACE INTO fold_txn_fts_env (k, v) VALUES ('visible', ?)",
    visibleSignature(ctx),
  );
}

/** The current indexed rows (and cash legs) of these partitions, by memory key. */
function currentRows(ctx: DeriveContext, keys: readonly string[]): Map<string, SearchSource> {
  const out = new Map<string, SearchSource>();
  const hashesByRoot = new Map<string, Set<string>>();
  const expenses: string[] = [];
  for (const key of keys) {
    if (key.startsWith(CASHEXP)) expenses.push(key.slice(CASHEXP.length));
    else if (key.includes("|")) {
      const [root, hash] = splitKey(key);
      const set = hashesByRoot.get(root) ?? new Set<string>();
      set.add(hash);
      hashesByRoot.set(root, set);
    }
  }
  const wanted = new Set(keys);
  for (const [root, hashes] of hashesByRoot) {
    for (const r of selectIn<SearchSource>(
      ctx.sql,
      `SELECT ${COLUMNS} ${INDEXED_FROM}
         AND t.account_id = (SELECT id FROM view_ids WHERE gid = ?) AND t.dedup_hash IN (%IN%)`,
      [...hashes],
      [root],
    )) {
      const key = `${root}|${r.dedup_hash}|${r.occurrence}`;
      if (wanted.has(key)) out.set(memKey(0, key), r);
    }
  }
  for (const r of selectIn<SearchSource>(
    ctx.sql,
    `SELECT ${COLUMNS} ${INDEXED_FROM} AND t.gid IN (%IN%) AND t.dedup_hash LIKE '${CASHEXP}%'`,
    expenses,
  )) {
    out.set(memKey(0, r.dedup_hash), r);
  }
  const legs = selectIn<{ partition: string; leg_gid: string }>(
    ctx.sql,
    "SELECT partition, leg_gid FROM fold_txn_legs WHERE partition IN (%IN%)",
    keys,
  );
  const partOf = new Map(legs.map((l) => [l.leg_gid, l.partition]));
  for (const r of selectIn<SearchSource>(
    ctx.sql,
    `SELECT ${COLUMNS} ${INDEXED_FROM} AND t.gid IN (%IN%) AND t.dedup_hash LIKE '${CASHLEG}%'`,
    [...partOf.keys()],
  )) {
    const part = partOf.get(r.gid);
    if (part !== undefined) out.set(memKey(1, part), r);
  }
  return out;
}

interface Remembered {
  leg: number;
  row: string;
  id: number;
  day: number;
  sig: string;
}

interface Doc {
  readonly leg: number;
  readonly row: string;
  readonly id: number;
  readonly day: number;
  readonly text: string;
  readonly amount: string;
}

/** Ascending FTS rowid (booking day, then id). */
const byRowid = (x: { day: number; id: number }, y: { day: number; id: number }): number =>
  x.day - y.day || x.id - y.id;

function derive(ctx: DeriveContext, keys: readonly string[]): void {
  const old = new Map(
    selectIn<Remembered>(
      ctx.sql,
      "SELECT leg, row, id, day, sig FROM fold_txn_fts_rows WHERE leg IN (0, 1) AND row IN (%IN%)",
      keys,
    ).map((m) => [memKey(m.leg, m.row), m]),
  );
  const now = currentRows(ctx, keys);
  // Every stale rowid goes before any new one is written: a rowid can move between keys.
  const removed: { day: number; id: number }[] = [];
  const added: Doc[] = [];
  for (const key of new Set([...old.keys(), ...now.keys()])) {
    const before = old.get(key);
    const loaded = now.get(key);
    const text = loaded === undefined ? "" : searchText(loaded);
    const amount = loaded === undefined ? "" : ftsAmountToken(loaded.amount);
    const day = loaded === undefined ? 0 : bookingDay(loaded.booking_date);
    const sig = loaded === undefined ? undefined : sigOf(text, amount);
    if (
      before !== undefined &&
      loaded !== undefined &&
      before.id === loaded.id &&
      before.day === day &&
      before.sig === sig
    ) {
      continue;
    }
    const [legText, row] = key.split("\u0000") as [string, string];
    const leg = Number(legText);
    if (before !== undefined) removed.push({ day: before.day, id: before.id });
    if (loaded === undefined || sig === undefined) {
      ctx.sql.write(
        rowsTable.name,
        "DELETE FROM fold_txn_fts_rows WHERE leg = ? AND row = ?",
        leg,
        row,
      );
    } else added.push({ leg, row, id: loaded.id, day, text, amount });
  }
  removed.sort(byRowid);
  for (const r of removed) {
    ctx.sql.write(
      SEARCH_FTS,
      `DELETE FROM ${SEARCH_FTS} WHERE rowid = ${FTS_ROWID_SQL}`,
      r.day,
      r.id,
    );
  }
  added.sort(byRowid);
  for (const a of added) indexRow(ctx, a.day, a.id, a.text, a.amount);
  for (const a of added) remember(ctx, a.leg, a.row, a.id, a.day, sigOf(a.text, a.amount));
}

export const searchDeriver: Deriver = {
  id: "budget.search",
  // Only the phone reads it (companion queries): registered with `StoreOptions.companionReads`.
  companion: true,
  // 2: rowid = booking day * 2^32 + id (date-ordered), only the rows of visible accounts
  version: 2,
  tables: [ftsTable, rowsTable, envTable],
  writes: [],
  inputs: ["budget.transactions", "core.accounts"],
  derive(dirty, ctx) {
    const txns = dirty.get("budget.transactions");
    if (txns === "all") {
      deriveAll(ctx);
      return;
    }
    const keys = new Set(txns ?? []);
    if (dirty.has("core.accounts")) {
      const stored = ctx.sql.get<{ v: string }>(
        "SELECT v FROM fold_txn_fts_env WHERE k = 'visible'",
      )?.v;
      if (stored !== visibleSignature(ctx)) {
        deriveAll(ctx); // an account opened, removed or restored: its rows join or leave the index
        return;
      }
      // the legs deriver re-checked every leg: so does this one
      for (const r of ctx.sql.all<{ row: string }>(
        "SELECT row FROM fold_txn_fts_rows WHERE leg = 1 UNION SELECT partition FROM fold_txn_legs",
      )) {
        keys.add(r.row);
      }
    }
    if (keys.size > 0) derive(ctx, [...keys]);
  },
  deriveAll,
};
