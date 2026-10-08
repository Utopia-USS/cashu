// Search-to-add (F12 F1, Apple Stocks pattern): `+ Dodaj` on Obserwowane opens one field; typing lists the
// profile's own instruments at once (remote=0) and the online matches after (one skeleton row while pending).
// A row: bold ticker, the name under it, exchange and type on the right, then by entry state a round `+` (new,
// saved with the `zapisany` tag), a check (watched) or `w portfelu` (held). Clicking a new / saved row adds it,
// a watched / held row opens the asset. Combobox + listbox (aria-activedescendant): Up / Down move the highlight,
// Enter acts on it (default the first addable row), Esc closes; focus stays in the field. The option carries the
// action in its name (an option's children are presentational): the `+` and the check are decoration. After an add
// the field clears and stays open. Remote search unavailable, or nothing found for a symbol-like text: the
// free-text row `Dodaj „<text>”` posts `symbol_or_isin` (the deterministic path).
//
// Results never act for another query than the field's (F12 review MED-2): every answer is tagged with its query;
// the moment the text changes the shown rows are stale (dimmed, inert) and the superseded requests are aborted.
// Enter on stale rows runs the search at once and acts on the fresh answer's first addable row (the local answer,
// else the full one), or does nothing.
import { type KeyboardEvent, useCallback, useEffect, useId, useRef, useState } from "react";
import { ApiError } from "../../../core/api";
import { describeIssue, errorText } from "../../../core/messages";
import { Skeleton, useToast } from "../../../ui";
import { micName } from "../labels";
import { postWatch, type SearchResult, searchInstruments } from "./api";
import { instName } from "./logic";
import {
  addedToast, defaultRow, enterTarget, highlightIndex, isActionable, isAddable, moveHighlight, normQuery, optionLabel, type SearchRow,
  searchView, typeWord, watchInputOf,
} from "./searchLogic";

const DEBOUNCE_MS = 250;

export function InstrumentSearch({ slug, onClose, onChanged, onOpen }: {
  slug: string;
  /** Esc in the field. */
  onClose: () => void;
  /** After an add (the watchlist re-reads). */
  onChanged: () => void;
  /** A watched / held row: open the asset. */
  onOpen: (instrumentId: number) => void;
}) {
  const toast = useToast();
  const [text, setText] = useState("");
  const [res, setRes] = useState<SearchResult | null>(null);
  /** The query whose remote answer is on its way. */
  const [remoteFor, setRemoteFor] = useState<string | null>(null);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ctrl = useRef<AbortController | null>(null);
  /** The query of the requests in flight / answered (null: none). */
  const started = useRef<string | null>(null);
  /** Enter pressed on stale rows: act on this query's first fresh addable row. */
  const enterFor = useRef<string | null>(null);
  const byKey = useRef(false);
  const id = useId();
  const listId = `${id}-list`;
  const optId = (i: number) => `${id}-opt-${i}`;

  useEffect(() => { input.current?.focus(); }, []);

  /** Start the search for `q` now (the debounce fires, or Enter flushes it); once per query. */
  const run = useCallback((q: string) => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    if (started.current === q) return;
    started.current = q;
    ctrl.current?.abort();
    const c = new AbortController();
    ctrl.current = c;
    const remote = q.length >= 2;
    let full = false;
    setRemoteFor(remote ? q : null);
    if (remote) {
      searchInstruments(slug, q, false, c.signal)
        .then((r) => { if (!c.signal.aborted && !full) setRes({ ...r, query: q, remote: [] }); })
        .catch(() => {});
    }
    searchInstruments(slug, q, remote, c.signal)
      .then((r) => { if (c.signal.aborted) return; full = true; setRes({ ...r, query: q }); setRemoteFor(null); })
      .catch(() => {
        // A failed search (an older server without the endpoint, a network error) leaves the free-text path.
        if (c.signal.aborted) return;
        full = true;
        setRes((cur) => ({ query: q, local: cur?.query === q ? cur.local : [], remote: [], remote_status: "unavailable" }));
        setRemoteFor(null);
      });
  }, [slug]);

  // A new text: the old answer is stale at once, its requests are aborted, the search starts after the debounce.
  useEffect(() => {
    const q = normQuery(text);
    if (q !== started.current) {
      ctrl.current?.abort();
      started.current = null;
    }
    if (!q) { setRes(null); setRemoteFor(null); return; }
    if (started.current === q) return; // only whitespace changed
    timer.current = setTimeout(() => run(q), DEBOUNCE_MS);
    return () => { if (timer.current) { clearTimeout(timer.current); timer.current = null; } };
  }, [text, run]);
  useEffect(() => () => ctrl.current?.abort(), []);

  const q = normQuery(text);
  const pending = remoteFor === q;
  const hasAnswer = !!q && res?.query === q;
  const view = searchView(res, text, pending);
  const rows = view.rows;
  const waiting = !!q && !hasAnswer;
  const open = !!q && (rows.length > 0 || pending || waiting);
  const active = view.stale ? null : highlightIndex(rows, activeKey);

  useEffect(() => {
    if (active == null || !byKey.current) return;
    byKey.current = false;
    document.getElementById(optId(active))?.scrollIntoView?.({ block: "nearest" });
  }, [active]);

  const add = async (row: SearchRow) => {
    if (busy) return;
    setBusy(row.key); setErr(null);
    try {
      const r = await postWatch(slug, row.kind === "free" ? { symbol_or_isin: row.text } : watchInputOf(row.hit));
      const name = r.instrument ? instName(r.instrument) : row.kind === "hit" ? row.hit.name || row.hit.symbol : row.text;
      toast(addedToast(r, name, (w) => describeIssue(w).text), 6000);
      setText(""); setRes(null); setActiveKey(null);
      onChanged();
    } catch (e) {
      setErr(e instanceof ApiError && e.status === 409 && !e.code ? "Już na liście" : errorText(e));
    } finally {
      setBusy(null);
      input.current?.focus();
    }
  };
  const act = (row: SearchRow) => {
    if (isActionable(row)) { void add(row); return; }
    if (row.kind === "hit" && row.hit.instrument_id != null) onOpen(row.hit.instrument_id);
  };

  // Enter waiting for a fresh answer: the local one's first addable row, else the full one's, else nothing.
  useEffect(() => {
    const want = enterFor.current;
    if (!want || want !== q || !hasAnswer || view.stale) return;
    const i = defaultRow(rows);
    if (i != null) { enterFor.current = null; act(rows[i]); return; }
    if (!pending) enterFor.current = null;
  });

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onClose(); return; }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!rows.length || view.stale) return;
      const i = moveHighlight(active, rows.length, e.key === "ArrowDown" ? 1 : -1);
      byKey.current = true;
      setActiveKey(i == null ? null : rows[i].key);
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      if (!q) return;
      const t = enterTarget(view, hasAnswer, active);
      if (t === "wait") { enterFor.current = q; run(q); return; }
      if (t != null && rows[t]) act(rows[t]);
    }
  };

  return (
    <div className="isearch">
      <input ref={input} value={text} maxLength={60} autoComplete="off" spellCheck={false}
        onChange={(e) => { setText(e.target.value); setErr(null); setActiveKey(null); enterFor.current = null; }} onKeyDown={onKey}
        placeholder="Nazwa, symbol lub ISIN" aria-label="Szukaj instrumentu"
        role="combobox" aria-autocomplete="list" aria-expanded={open} aria-controls={listId}
        aria-activedescendant={open && active != null ? optId(active) : undefined} />
      {err && <div className="ise neg" role="alert">{err}</div>}
      {open && view.empty && <div className="isn muted" role="status">Brak wyników</div>}
      <ul className="isl" id={listId} role="listbox" aria-label="Wyniki" hidden={!open} aria-busy={waiting || undefined}
        data-stale={view.stale || undefined} onMouseDown={(e) => e.preventDefault()}>
        {rows.map((row, i) => (
          <li key={row.key} id={optId(i)} role="option" aria-selected={i === active} aria-disabled={view.stale || undefined} className="iso"
            aria-label={row.kind === "hit" ? optionLabel(row.hit, row.hit.exchange ?? micName(row.hit.mic)) : undefined}
            onMouseMove={() => { if (!view.stale && active !== i) setActiveKey(row.key); }}
            onClick={() => { if (!view.stale && !busy) act(row); }}>
            {row.kind === "free" ? (
              <>
                <span className="tx"><span className="tk">Dodaj „{row.text}”</span></span>
                <span className="isx"><span className="isadd" aria-hidden>+</span></span>
              </>
            ) : <HitRow row={row} />}
          </li>
        ))}
        {open && ((pending && !view.stale) || (waiting && !rows.length)) && (
          <li className="iso isk" aria-hidden>
            <span className="tx"><Skeleton w={56} h={11} /><Skeleton w="60%" h={9} style={{ marginTop: 5 }} /></span>
          </li>
        )}
      </ul>
      {open && view.unavailable && <div className="isn muted" role="status">Wyszukiwanie online niedostępne</div>}
    </div>
  );
}

function HitRow({ row }: { row: Extract<SearchRow, { kind: "hit" }> }) {
  const h = row.hit;
  const ex = h.exchange ?? micName(h.mic);
  const type = typeWord(h);
  return (
    <>
      <span className="tx">
        <span className="tk">{h.symbol}</span>
        {h.name && <span className="nm" title={h.name}>{h.name}</span>}
      </span>
      {h.state === "saved" && <span className="tag" title="Wróci z researchem i notatkami">zapisany</span>}
      {h.state === "held" && <span className="tag">w portfelu</span>}
      {(ex || type) && <span className="ism">{ex && <span>{ex}</span>}{type && <span>{type}</span>}</span>}
      <span className="isx">
        {isAddable(h) ? <span className="isadd" aria-hidden>+</span> : h.state === "watched" ? <span className="isok" aria-hidden>✓</span> : null}
      </span>
    </>
  );
}
