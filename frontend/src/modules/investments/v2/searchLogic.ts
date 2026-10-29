// Instrument search (F12 F1, Apple Stocks pattern): the pure parts of the search-to-add field. Rows of a result,
// what a hit posts to the watchlist, the short type word, when the free-text row shows, the toast after an add.
// Tested in tests/instrument-search.test.mjs.
import { ASSET_CLASS } from "../labels.ts";
import type { SearchHit, SearchResult, WatchInput } from "./api.ts";
import { S, TYPE_WORD_L } from "./searchLogic.strings.ts";

/** Short type word on the right of a row; remote `other` is an index (Yahoo INDEX), a local `other` says nothing. */
const TYPE_WORD: Record<string, string> = TYPE_WORD_L;
export function typeWord(h: Pick<SearchHit, "asset_class" | "source">): string | null {
  if (TYPE_WORD[h.asset_class]) return TYPE_WORD[h.asset_class];
  if (h.asset_class === "other") return h.source === "local" ? null : S.index;
  return ASSET_CLASS[h.asset_class] ?? null;
}

/** `new` and `saved` hits are added by a click or Enter; `watched` / `held` open the asset. */
export const isAddable = (h: Pick<SearchHit, "state">): boolean => h.state === "new" || h.state === "saved";

/** The POST body for a picked hit: a saved entry comes back by its id (the same row is restored); a new hit goes as
 * a pick (the backend verifies the Yahoo symbol, reuses a stored instrument with that alias); a hit without a Yahoo
 * symbol falls back to the id, else the ISIN / symbol as free text. */
export function watchInputOf(h: SearchHit): WatchInput {
  if (h.state === "saved" && h.instrument_id != null) return { instrument_id: h.instrument_id };
  if (h.yahoo_symbol) {
    return { pick: { yahoo_symbol: h.yahoo_symbol, ticker: h.symbol || null, name: h.name || null, asset_class: h.asset_class || null, mic: h.mic, isin: h.isin } };
  }
  if (h.instrument_id != null) return { instrument_id: h.instrument_id };
  return { symbol_or_isin: h.isin ?? h.symbol };
}

const ISIN = /^[A-Z]{2}[A-Z0-9]{9}\d$/;
/** Text that could be a ticker (`VWCE`, `VWCE.DE`, `BTC-USD`, `^GSPC`) or an ISIN: one word, at most 15 characters. */
export function looksLikeSymbol(text: string): boolean {
  const v = text.trim();
  return ISIN.test(v.toUpperCase()) || /^[A-Za-z0-9^][A-Za-z0-9.\-=:]{0,14}$/.test(v);
}

export type SearchRow = { kind: "hit"; key: string; hit: SearchHit } | { kind: "free"; key: string; text: string };

/** The query as the backend cleans it (`clean_query`: whitespace runs collapsed, trimmed). A result belongs to the
 * field only while its `query` equals this. */
export const normQuery = (text: string): string => text.split(/\s+/).filter(Boolean).join(" ");

export interface SearchView {
  rows: SearchRow[];
  /** The rows are an older query's (the text changed since): shown dimmed, never acted on. */
  stale: boolean;
  /** `Wyszukiwanie online niedostępne` (all remote sources failed). */
  unavailable: boolean;
  /** `Brak wyników` (nothing local, nothing remote, nothing pending). */
  empty: boolean;
}

/** Local rows first, then remote (a key once); the free-text row `Dodaj „<text>”` last when the remote search is
 * unavailable, or when there are no results at all and the text looks like a symbol or ISIN. A result for another
 * query than the field's text is stale: its hits stay visible (dimmed) until the fresh answer, with no free row,
 * no status line. `pending` = the remote answer for the current text is still on its way. */
export function searchView(res: SearchResult | null, text: string, pending: boolean): SearchView {
  const q = normQuery(text);
  if (!q || !res) return { rows: [], stale: false, unavailable: false, empty: false };
  const stale = res.query !== q;
  const seen = new Set<string>();
  const rows: SearchRow[] = [];
  for (const hit of [...res.local, ...res.remote]) {
    if (seen.has(hit.key)) continue;
    seen.add(hit.key);
    rows.push({ kind: "hit", key: hit.key, hit });
  }
  if (stale) return { rows, stale, unavailable: false, empty: false };
  const unavailable = !pending && res.remote_status === "unavailable";
  const empty = !rows.length && !pending && !unavailable;
  if (unavailable || (empty && looksLikeSymbol(q))) rows.push({ kind: "free", key: `t:${q}`, text: q });
  return { rows, stale, unavailable, empty };
}

/** A row Enter or a click can act on: a fresh addable hit or the free row. */
export const isActionable = (r: SearchRow): boolean => r.kind === "free" || isAddable(r.hit);

/** Index of the row Enter acts on when nothing is highlighted: the first addable row (a hit or the free row). */
export function defaultRow(rows: SearchRow[]): number | null {
  const i = rows.findIndex(isActionable);
  return i < 0 ? null : i;
}

/** The highlighted row's index from its key: the same row after the remote answer replaces the local-only one; the
 * first row when the key is gone; null when nothing is highlighted (or nothing is listed). */
export function highlightIndex(rows: SearchRow[], key: string | null): number | null {
  if (key == null || !rows.length) return null;
  const i = rows.findIndex((r) => r.key === key);
  return i < 0 ? 0 : i;
}

/** What Enter does now: `wait` while the rows are stale or no answer for the text arrived yet (the component runs
 * the search at once and acts on the fresh answer), else the row index to act on, or null (nothing to do). */
export function enterTarget(view: SearchView, hasAnswer: boolean, active: number | null): number | "wait" | null {
  if (view.stale || !hasAnswer) return "wait";
  return active ?? defaultRow(view.rows);
}

/** Up / Down over `n` rows from `cur` (null = none highlighted), wrapping. */
export function moveHighlight(cur: number | null, n: number, dir: 1 | -1): number | null {
  if (!n) return null;
  if (cur == null) return dir === 1 ? 0 : n - 1;
  return (cur + dir + n) % n;
}

/** The option's accessible name (an option's children are presentational, so the action is in the name):
 * `Obserwuj VWCE` / `Obserwujesz VWCE` / `VWCE`, then the name, exchange, type and the state tag. */
export function optionLabel(h: SearchHit, exchange: string | null): string {
  const head = isAddable(h) ? S.watch(h.symbol) : h.state === "watched" ? S.watching(h.symbol) : h.symbol;
  const tag = h.state === "saved" ? S.saved : h.state === "held" ? S.held : null;
  return [head, h.name || null, exchange, typeWord(h), tag].filter(Boolean).join(", ");
}

/** Toast after an add: `Obserwujesz <name>` / `Przywrócono <name>`, a coded warning appended (`· <warning>`); an older
 * server's English warning on a created instrument becomes one line in the UI language. `describe` = describeIssue's text. */
export function addedToast(
  r: { restored?: boolean; created_instrument?: boolean; warnings?: string[]; warning_codes?: { code: string; params: Record<string, unknown> | null; message: string }[] },
  name: string,
  describe: (w: { code: string; params: Record<string, unknown> | null; message: string }) => string,
): string {
  const head = r.restored ? S.restored(name) : S.watching(name);
  const coded = r.warning_codes?.map(describe) ?? [];
  if (coded.length) return `${head} · ${coded[0]}`;
  if (r.created_instrument && r.warnings?.length) return `${head} · ${S.guessedSymbol}`;
  return head;
}
