// The search-index oracle of the store tests (M3): the `budget.search` FTS5 index read back token by
// token (`fts5vocab` instances, which a contentless table still has) and compared with an index built
// from the rows by plain SQL, written independently of the deriver; and `budgetSearch` compared with
// a JS filter of the visible rows (word-prefix tokens, case and diacritics folded, amounts, category
// label words). Synthetic data only.
import { budget, normalizeText } from "@cashu/domain";
import fc from "fast-check";
import { expect } from "vitest";
import { budgetSearch } from "../budget/companion-queries.js";
import {
  bookingDay,
  FTS_DAY,
  ftsAmountPrefix,
  ftsAmountToken,
  SEARCH_FTS,
  type SearchSource,
  searchText,
} from "../budget/derive/search.js";
import type { Store } from "../materialize.js";
import { runQuery } from "../query.js";
import { type categoryScript, deliver } from "./category-script.js";

const TOKENIZE = "tokenize='unicode61 remove_diacritics 2'";

/** Every token instance of an FTS5 table as `rowid column offset term`, sorted. */
function instances(store: Store, schema: string, table: string): string[] {
  const vocab = `${table}_vocab_oracle`;
  store.driver.exec(
    `CREATE VIRTUAL TABLE IF NOT EXISTS temp.${vocab} USING fts5vocab(${schema}, ${table}, instance)`,
  );
  try {
    return store.driver
      .prepare(`SELECT doc, col, offset, term FROM temp.${vocab}`)
      .all<{ doc: number; col: string; offset: number; term: string }>()
      .map((r) => `${r.doc} ${r.col} ${r.offset} ${r.term}`)
      .sort();
  } finally {
    store.driver.exec(`DROP TABLE IF EXISTS temp.${vocab}`);
  }
}

/** The index as stored: every token instance (`rowid column offset term`). */
export function searchIndex(store: Store): string[] {
  return instances(store, "main", SEARCH_FTS);
}

/** The rows the index holds: every `transactions` row of an account that is not removed. */
function sources(store: Store): SearchSource[] {
  return store.read<SearchSource>(
    `SELECT t.id, t.gid, t.account_id, t.booking_date, t.dedup_hash, t.occurrence, t.amount,
       t.counterparty_name, t.description, t.reference, t.merchant_key
     FROM transactions t JOIN accounts a ON a.id = t.account_id
     WHERE a.removed_at IS NULL ORDER BY t.id`,
  );
}

/** A row's FTS rowid: its booking day (UTC days since 1970-01-01, computed apart) * 2^32 + its id. */
function rowidOf(r: SearchSource): number {
  const day = Math.round(new Date(`${r.booking_date}T00:00:00Z`).getTime() / 86_400_000);
  expect(bookingDay(r.booking_date)).toBe(day);
  return day * FTS_DAY + r.id;
}

/** The index the rows give: a plain FTS5 table of the recomputed text and amount, read back. */
function expectedIndex(store: Store): string[] {
  store.driver.exec(
    `CREATE VIRTUAL TABLE temp.search_oracle USING fts5(text, amount, ${TOKENIZE})`,
  );
  try {
    const insert = store.driver.prepare(
      "INSERT INTO temp.search_oracle (rowid, text, amount) VALUES (?, ?, ?)",
    );
    for (const r of sources(store)) {
      insert.run(rowidOf(r), searchText(r), ftsAmountToken(r.amount));
    }
    return instances(store, "temp", "search_oracle");
  } finally {
    store.driver.exec("DROP TABLE IF EXISTS temp.search_oracle");
  }
}

/**
 * The index equals the recompute from every visible row (one document per row, cash legs included,
 * its text and amount tokens, its booking-date rowid), and its memory remembers each row once with
 * its id and booking day.
 */
export function expectSearchIndexed(store: Store): void {
  expect(searchIndex(store)).toEqual(expectedIndex(store));
  const remembered = store.read<{ id: number; day: number; sig: string }>(
    "SELECT id, day, sig FROM fold_txn_fts_rows ORDER BY id",
  );
  expect(remembered).toEqual(
    sources(store).map((r) => ({
      id: r.id,
      day: Math.floor(rowidOf(r) / FTS_DAY),
      sig: `${searchText(r)}\u0001${ftsAmountToken(r.amount)}`,
    })),
  );
}

interface VisibleRow extends SearchSource {
  currency: string;
  category: string | null;
  category_source: string | null;
  is_internal_transfer: number;
}

const words = (s: string): string[] => s.split(/[^\p{L}\p{N}]+/u).filter((w) => w !== "");

/** The `budgetSearch` semantics as a plain filter: every hit, newest first. */
function expectedHits(store: Store, q: string): VisibleRow[] {
  const tokens = q
    .split(/\s+/)
    .map((raw) => normalizeText(raw))
    .filter((t) => /[\p{L}\p{N}]/u.test(t));
  if (tokens.length === 0) return [];
  const rows = store.read<VisibleRow>(
    `SELECT t.id, t.gid, t.account_id, t.dedup_hash, t.occurrence, t.amount, t.counterparty_name,
       t.description, t.reference, t.merchant_key, t.booking_date, t.category, t.category_source,
       t.is_internal_transfer, t.currency
     FROM transactions t JOIN accounts a ON a.id = t.account_id WHERE a.removed_at IS NULL`,
  );
  const matches = (r: VisibleRow, token: string): boolean => {
    // a token is a phrase of its words; the oracle's queries are single words
    const [word = ""] = words(token);
    if (words(searchText(r)).some((w) => w.startsWith(word))) return true;
    if (
      /^\d+(?:[.,]\d+)?$/.test(token) &&
      ftsAmountToken(r.amount).startsWith(ftsAmountPrefix(token))
    )
      return true;
    const uncategorized =
      Number(r.amount) < 0 && r.is_internal_transfer === 0 && r.category_source === "default";
    return (
      !uncategorized &&
      budget.CATEGORIES.some(
        (c) =>
          c.key === r.category &&
          [...words(normalizeText(c.label)), ...words(normalizeText(c.labelEn))].some((w) =>
            w.startsWith(token),
          ),
      )
    );
  };
  return rows
    .filter((r) => tokens.every((t) => matches(r, t)))
    .sort((a, b) =>
      a.booking_date !== b.booking_date
        ? a.booking_date < b.booking_date
          ? 1
          : -1
        : a.gid < b.gid
          ? 1
          : a.gid > b.gid
            ? -1
            : 0,
    );
}

/** Queries over the scripts' merchants, titles, amounts and category labels. */
const QUERIES = [
  "s",
  "sklep",
  "SKLEP ryb",
  "biedronka 12",
  "12",
  "23",
  "23,9",
  "10.00",
  "spot",
  "kawa",
  "przel",
  "wyp",
  "żab",
  "subs",
  // category labels: `other` (the uncategorized check), shopping, two labels, a label and a word
  "inne",
  "zak",
  "inne zak",
  "inne sklep",
  "zzz",
];

/**
 * `budgetSearch` equals the plain filter of the visible rows (page, total, whether every hit shares
 * one merchant key). Small limits put the page's last booking date inside a day's hits, the case the
 * date-ordered index cuts by gid.
 */
function expectSearchQueries(store: Store, queries: readonly string[] = QUERIES): void {
  for (const q of queries) {
    const want = expectedHits(store, q);
    const keys = new Set(want.map((r) => r.merchant_key ?? ""));
    // the payee summary: at least 2 hits, one merchant key, one currency
    const shared =
      want.length >= 2 &&
      keys.size === 1 &&
      !keys.has("") &&
      new Set(want.map((r) => r.currency)).size === 1;
    for (const limit of [1, 3, 200]) {
      const got = runQuery(store, budgetSearch, { q, lang: "pl", limit }).value;
      expect({
        q,
        limit,
        total: got.total,
        page: got.rows.map((r) => r.gid),
        shared: got.summary !== null,
      }).toEqual({
        q,
        limit,
        total: want.length,
        page: want.slice(0, limit).map((r) => r.gid),
        shared,
      });
    }
  }
}

/**
 * The search-index property over a random budget script: after every batch the index equals the
 * recompute from the rows, the incremental derivation equals `deriveAll` (the index and its memory
 * are unchanged by `rederive`) and `budgetSearch` equals the plain filter; a rebuild keeps the index.
 */
export const searchProperty = (script: typeof categoryScript) =>
  fc.property(script, fc.integer({ min: 1, max: 1_000_000 }), (events, seed) => {
    const a = deliver(events, seed, (s) => {
      expectSearchIndexed(s);
      const incremental = searchIndex(s);
      s.rederive();
      expect(searchIndex(s)).toEqual(incremental);
      expectSearchQueries(s);
    });
    a.rebuild();
    expectSearchIndexed(a);
  });
