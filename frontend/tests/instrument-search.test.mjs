// F12 instrument search (searchLogic.ts): rows of a result, the POST body of a hit, the type word, the free-text
// row, keyboard highlight and the toast after an add.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  addedToast, defaultRow, enterTarget, highlightIndex, isAddable, looksLikeSymbol, moveHighlight, normQuery, optionLabel, searchView, typeWord, watchInputOf,
} from "../src/modules/investments/v2/searchLogic.ts";

const hit = (o) => ({
  key: "y:VWCE.DE", instrument_id: null, state: "new", symbol: "VWCE", yahoo_symbol: "VWCE.DE", name: "Vanguard FTSE All-World", exchange: "XETRA",
  mic: "XETR", asset_class: "etf", currency: "EUR", isin: null, source: "yahoo", ...o,
});
const res = (query, local, remote, remote_status = "ok") => ({ query, local, remote, remote_status });

test("type words: ETF, akcja, fundusz, krypto; remote other is an index, local other says nothing", () => {
  assert.equal(typeWord({ asset_class: "etf", source: "yahoo" }), "ETF");
  assert.equal(typeWord({ asset_class: "equity", source: "local" }), "akcja");
  assert.equal(typeWord({ asset_class: "fund", source: "yahoo" }), "fundusz");
  assert.equal(typeWord({ asset_class: "crypto", source: "yahoo" }), "krypto");
  assert.equal(typeWord({ asset_class: "other", source: "yahoo" }), "indeks");
  assert.equal(typeWord({ asset_class: "other", source: "local" }), null);
});

test("POST body: saved by id (restore), new as a pick, no Yahoo symbol falls back to the id or the ISIN", () => {
  // remote hits outside the profile now carry instrument_id null (review fix): a pick; an OpenFIGI listing with a
  // Yahoo symbol for an ISIN query: a pick with its ISIN
  assert.deepEqual(watchInputOf(hit({ source: "openfigi", yahoo_symbol: "VWRA.L", symbol: "VWRA", mic: "XLON", isin: "IE00BK5BQT80", key: "y:VWRA.L" })), {
    pick: { yahoo_symbol: "VWRA.L", ticker: "VWRA", name: "Vanguard FTSE All-World", asset_class: "etf", mic: "XLON", isin: "IE00BK5BQT80" },
  });
  assert.deepEqual(watchInputOf(hit({ state: "saved", instrument_id: 7, key: "i:7", source: "local" })), { instrument_id: 7 });
  assert.deepEqual(watchInputOf(hit({})), {
    pick: { yahoo_symbol: "VWCE.DE", ticker: "VWCE", name: "Vanguard FTSE All-World", asset_class: "etf", mic: "XETR", isin: null },
  });
  // a remote hit merged into a shared instrument that is not in the profile still goes as a pick (no network on the server)
  assert.ok("pick" in watchInputOf(hit({ instrument_id: 3 })));
  assert.deepEqual(watchInputOf(hit({ yahoo_symbol: null, instrument_id: 3 })), { instrument_id: 3 });
  assert.deepEqual(watchInputOf(hit({ yahoo_symbol: null, isin: "IE00BK5BQT80", source: "openfigi" })), { symbol_or_isin: "IE00BK5BQT80" });
  assert.equal(isAddable({ state: "new" }), true);
  assert.equal(isAddable({ state: "saved" }), true);
  assert.equal(isAddable({ state: "watched" }), false);
  assert.equal(isAddable({ state: "held" }), false);
});

test("rows: local first, a key once; the free row when remote is unavailable or nothing matches a symbol-like text", () => {
  const a = hit({ key: "i:1", source: "local", instrument_id: 1, state: "watched" });
  const b = hit({});
  let v = searchView(res("vw", [a], [b, a]), "vw", false);
  assert.deepEqual(v.rows.map((r) => r.key), ["i:1", "y:VWCE.DE"]);
  assert.equal(v.unavailable, false);
  assert.equal(v.empty, false);
  v = searchView(res("vwce", [a], [], "unavailable"), "vwce", false);
  assert.equal(v.unavailable, true);
  assert.deepEqual(v.rows.map((r) => r.kind), ["hit", "free"]);
  // pending: no unavailable line, no free row yet
  v = searchView(res("vwce", [], [], "unavailable"), "vwce", true);
  assert.equal(v.unavailable, false);
  assert.equal(v.rows.length, 0);
  v = searchView(res("zzqx", [], []), "zzqx", false);
  assert.equal(v.empty, true);
  assert.deepEqual(v.rows, [{ kind: "free", key: "t:zzqx", text: "zzqx" }]);
  v = searchView(res("all world fund", [], []), "all  world fund ", false);
  assert.equal(v.empty, true);
  assert.equal(v.rows.length, 0);
  assert.deepEqual(searchView(null, "x", true).rows, []);
});

test("symbol-like text and the keyboard highlight", () => {
  for (const t of ["VWCE", "vwce.de", "BTC-USD", "^GSPC", "IE00BK5BQT80"]) assert.equal(looksLikeSymbol(t), true, t);
  for (const t of ["all world", "Vanguard FTSE All-World UCITS"]) assert.equal(looksLikeSymbol(t), false, t);
  const rows = searchView(res("vw", [hit({ key: "i:1", state: "held", instrument_id: 1 })], [hit({})]), "vw", false).rows;
  assert.equal(defaultRow(rows), 1);
  assert.equal(defaultRow(rows.slice(0, 1)), null);
  assert.equal(moveHighlight(null, 3, 1), 0);
  assert.equal(moveHighlight(null, 3, -1), 2);
  assert.equal(moveHighlight(2, 3, 1), 0);
  assert.equal(moveHighlight(0, 3, -1), 2);
  assert.equal(moveHighlight(null, 0, 1), null);
});

test("toast: Obserwujesz / Przywrócono, a coded warning appended", () => {
  const d = (w) => `PL:${w.code}`;
  assert.equal(addedToast({}, "Orlen", d), "Obserwujesz Orlen");
  assert.equal(addedToast({ restored: true }, "Orlen", d), "Przywrócono Orlen");
  assert.equal(addedToast({ warning_codes: [{ code: "watchlist.unverified_price_symbol", params: {}, message: "x" }] }, "VWCE", d),
    "Obserwujesz VWCE · PL:watchlist.unverified_price_symbol");
  assert.match(addedToast({ created_instrument: true, warnings: ["guessed"] }, "VWCE", d), /^Obserwujesz VWCE · symbol ceny zgadnięty/);
});

test("stale query (review MED-2): another query's rows are stale, inert for Enter, no free row or status line", () => {
  assert.equal(normQuery("  pk   o "), "pk o");
  const pkn = hit({ key: "y:PKN.WA", symbol: "PKN", yahoo_symbol: "PKN.WA", name: "Orlen" });
  // the field says PKO, the shown answer is PK's: stale, Enter waits for the fresh answer
  let v = searchView(res("PK", [], [pkn]), "PKO", false);
  assert.equal(v.stale, true);
  assert.deepEqual(v.rows.map((r) => r.key), ["y:PKN.WA"]);
  assert.equal(v.empty, false);
  assert.equal(v.unavailable, false);
  assert.equal(enterTarget(v, false, null), "wait");
  assert.equal(enterTarget(v, false, 0), "wait");
  // a stale unavailable answer shows neither the line nor the free row for the new text
  v = searchView(res("PK", [], [], "unavailable"), "PKO", false);
  assert.equal(v.stale, true);
  assert.deepEqual(v.rows, []);
  // whitespace differences are the same query (the backend's clean_query)
  v = searchView(res("PK O", [], [pkn]), " PK  O", false);
  assert.equal(v.stale, false);
  assert.equal(enterTarget(v, true, null), 0);
  // a fresh answer without an addable row: Enter does nothing
  v = searchView(res("pk", [hit({ key: "i:1", state: "watched", instrument_id: 1 })], []), "pk", false);
  assert.equal(enterTarget(v, true, null), null);
  // the highlighted row wins over the default
  v = searchView(res("vw", [hit({ key: "i:1", state: "held", instrument_id: 1 })], [hit({})]), "vw", false);
  assert.equal(enterTarget(v, true, 0), 0);
  assert.equal(enterTarget(v, true, null), 1);
  // no answer yet for the text (debounce): wait
  assert.equal(enterTarget(searchView(null, "vw", false), false, null), "wait");
});

test("highlight by key (review LOW-10): kept when the remote answer replaces the local rows, else the first row", () => {
  const local = searchView(res("vw", [hit({ key: "i:1", state: "saved", instrument_id: 1, source: "local" })], []), "vw", true).rows;
  const full = searchView(res("vw", [hit({ key: "i:1", state: "saved", instrument_id: 1, source: "local" })], [hit({ key: "y:A" }), hit({ key: "y:B" })]), "vw", false).rows;
  assert.equal(highlightIndex(local, "i:1"), 0);
  assert.equal(highlightIndex(full, "y:B"), 2);
  assert.equal(highlightIndex(full, "i:1"), 0);
  assert.equal(highlightIndex(full, "gone"), 0);
  assert.equal(highlightIndex(full, null), null);
  assert.equal(highlightIndex([], "y:B"), null);
});

test("option names carry the action (an option's children are presentational)", () => {
  assert.equal(optionLabel(hit({}), "XETRA"), "Obserwuj VWCE, Vanguard FTSE All-World, XETRA, ETF");
  assert.equal(optionLabel(hit({ state: "saved" }), "Xetra"), "Obserwuj VWCE, Vanguard FTSE All-World, Xetra, ETF, zapisany");
  assert.equal(optionLabel(hit({ state: "watched" }), null), "Obserwujesz VWCE, Vanguard FTSE All-World, ETF");
  assert.equal(optionLabel(hit({ state: "held", source: "local", asset_class: "other" }), "GPW"), "VWCE, Vanguard FTSE All-World, GPW, w portfelu");
});
