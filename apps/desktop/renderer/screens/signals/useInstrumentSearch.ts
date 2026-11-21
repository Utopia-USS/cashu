// The search-to-add field of the ported InstrumentSearch.tsx (ab24ab6, F12 F1): typing lists the profile's own
// instruments and the online matches; a new / saved row adds it, a watched / held row opens the asset; Up / Down
// move the highlight, Enter acts on it (default the first addable row), Esc closes. Results never act for another
// query than the field's: a changed text makes the shown rows stale (dimmed, inert); Enter on stale rows searches at
// once and acts on the fresh answer's first addable row. The native search answers local and online hits in one
// reply (the old local-first answer has no twin: the online rows arrive with the local ones).
import { S } from "@cashu/i18n/investments/v2/InstrumentSearch.strings";
import { useToast } from "@cashu/ui";
import { describeIssue } from "@cashu/ui-logic/core/messages";
import {
  addedToast,
  defaultRow,
  enterTarget,
  highlightIndex,
  isActionable,
  moveHighlight,
  normQuery,
  type SearchRow,
  searchView,
  watchInputOf,
} from "@cashu/ui-logic/investments/v2/searchLogic";
import type { SearchResult } from "@cashu/ui-logic/investments/v2/types";
import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import { errorText, OutcomeError } from "./legacy/outcome.js";
import { useLegacySignalsApi } from "./useLegacySignalsApi.js";

const DEBOUNCE_MS = 250;

export interface InstrumentSearchInput {
  /** Esc in the field. */
  onClose(): void;
  /** A watched / held row: open the asset (legacy instrument number). */
  onOpen(instrumentId: number): void;
}

export function useInstrumentSearch(o: InstrumentSearchInput) {
  const toast = useToast();
  const api = useLegacySignalsApi();
  const [text, setText] = useState("");
  const [res, setRes] = useState<SearchResult | null>(null);
  /** The query whose answer is on its way. */
  const [remoteFor, setRemoteFor] = useState<string | null>(null);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** The query of the request in flight / answered (null: none). */
  const started = useRef<string | null>(null);
  /** Enter pressed on stale rows: act on this query's first fresh addable row. */
  const enterFor = useRef<string | null>(null);

  useEffect(() => {
    input.current?.focus();
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  const add = async (row: SearchRow) => {
    if (busy) return;
    setBusy(row.key);
    setErr(null);
    try {
      const r = await api.postWatch(
        row.kind === "free" ? { symbol_or_isin: row.text } : watchInputOf(row.hit),
      );
      const name = row.kind === "hit" ? row.hit.name || row.hit.symbol : row.text;
      toast(
        addedToast(r, name, (w) => describeIssue(w).text),
        6000,
      );
      setText("");
      setRes(null);
      setActiveKey(null);
      started.current = null;
    } catch (e) {
      setErr(
        e instanceof OutcomeError && e.code === "already_watched" ? S.alreadyListed : errorText(e),
      );
    } finally {
      setBusy(null);
      input.current?.focus();
    }
  };
  const act = (row: SearchRow) => {
    if (isActionable(row)) {
      void add(row);
      return;
    }
    if (row.kind === "hit" && row.hit.instrument_id != null) o.onOpen(row.hit.instrument_id);
  };

  /** Start the search for `q` now (the debounce fires, or Enter flushes it); once per query. */
  const run = (q: string) => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    if (started.current === q) return;
    started.current = q;
    setRemoteFor(q);
    const settle = (r: SearchResult) => {
      if (started.current !== q) return;
      setRes(r);
      setRemoteFor(null);
      // Enter waiting for this answer: its first addable row, else nothing.
      if (enterFor.current === q) {
        enterFor.current = null;
        const fresh = searchView(r, q, false);
        const i = defaultRow(fresh.rows);
        const row = i == null ? undefined : fresh.rows[i];
        if (row) act(row);
      }
    };
    api.searchInstruments(q).then(
      (r) => settle({ ...r, query: q }),
      // A failed search leaves the free-text path.
      () => settle({ query: q, local: [], remote: [], remote_status: "unavailable" }),
    );
  };

  const change = (value: string) => {
    setText(value);
    setErr(null);
    setActiveKey(null);
    enterFor.current = null;
    const q = normQuery(value);
    if (q !== started.current) started.current = null;
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    if (!q) {
      setRes(null);
      setRemoteFor(null);
      return;
    }
    timer.current = setTimeout(() => run(q), DEBOUNCE_MS);
  };

  const q = normQuery(text);
  const pending = remoteFor === q && q !== "";
  const hasAnswer = !!q && res?.query === q;
  const view = searchView(res, text, pending);
  const rows = view.rows;
  const waiting = !!q && !hasAnswer;
  const open = !!q && (rows.length > 0 || pending || waiting);
  const active = view.stale ? null : highlightIndex(rows, activeKey);

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      o.onClose();
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!rows.length || view.stale) return;
      const i = moveHighlight(active, rows.length, e.key === "ArrowDown" ? 1 : -1);
      const key = i == null ? null : (rows[i]?.key ?? null);
      setActiveKey(key);
      if (key)
        requestAnimationFrame(() =>
          document
            .querySelector(`[data-search-key="${CSS.escape(key)}"]`)
            ?.scrollIntoView?.({ block: "nearest" }),
        );
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      if (!q) return;
      const t = enterTarget(view, hasAnswer, active);
      if (t === "wait") {
        enterFor.current = q;
        run(q);
        return;
      }
      const row = t == null ? undefined : rows[t];
      if (row) act(row);
    }
  };
  return {
    input,
    text,
    rows,
    view,
    open,
    active,
    waiting,
    pending,
    busy,
    err,
    change,
    onKey,
    act,
    setActiveKey,
  };
}
export type InstrumentSearchState = ReturnType<typeof useInstrumentSearch>;
