// Obserwowane (ia-v2.md 7, F-11): instruments the owner does not hold, with the price, a 30-day sparkline,
// the weekly change and the nearest alert or the note; `+ Dodaj` resolves a symbol or ISIN; agent-added rows
// carry the badge; removing toasts with undo (re-adds the instrument).
import { useEffect, useRef, useState } from "react";
import { ApiError } from "../../../core/api";
import { describeIssue, errorText } from "../../../core/messages";
import { Spark } from "../../../charts";
import { useInFlight } from "../../../hooks";
import { Skeleton, useToast } from "../../../ui";
import { AgentTag, FootFacts, Widget } from "../../../widgets";
import { pct, plural } from "../labels";
import { deleteWatch, postWatch, type WatchItem } from "./api";
import { instName, price, watchMove } from "./logic";
import { makeUndo } from "../undo";
import { offerUndo } from "./undoFlow";

const KIND_WORD: Record<string, string> = {
  price_below: "poniżej", price_above: "powyżej", sma_cross: "SMA", new_high: "nowy szczyt", drawdown_from_high: "spadek od szczytu",
};

/** "1 alert: poniżej 560,00 $" / "2 alerty" / the note / "bez alertu". */
export function watchSummary(w: WatchItem): string {
  const n = w.alerts.live;
  const near = w.alerts.nearest;
  const cur = w.price?.currency ?? w.instrument?.currency;
  if (n && near) {
    const what = near.level != null ? `${KIND_WORD[near.kind] ?? near.title} ${price(near.level, cur)}` : near.title;
    return `${plural(n, "alert", "alerty", "alertów")}: ${what}`;
  }
  if (n) return plural(n, "alert", "alerty", "alertów");
  return w.note ? w.note : "bez alertu";
}

export function WatchlistWidget({ slug, items, onChanged, onOpen, autoAdd }: {
  slug: string;
  items: WatchItem[] | null;
  onChanged: () => void;
  onOpen: (instrumentId: number) => void;
  /** Open the inline add row (the minimal view's "obserwuj instrument"). */
  autoAdd?: boolean;
}) {
  const toast = useToast();
  const [adding, setAdding] = useState(!!autoAdd);
  const [text, setText] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { if (adding) input.current?.focus(); }, [adding]);
  const list = items ?? [];
  const alerts = list.reduce((a, w) => a + w.alerts.live, 0);
  const add = async () => {
    const v = text.trim();
    if (!v) return;
    setBusy(true); setErr(null);
    try {
      const r = await postWatch(slug, { symbol_or_isin: v, note: note.trim() || null });
      setText(""); setNote(""); setAdding(false);
      const label = r.instrument ? instName(r.instrument) : v;
      // Coded warnings (F6 BE `warning_codes`) in Polish; an older server's English warning: one Polish line.
      const coded = r.warning_codes?.map((w) => describeIssue({ code: w.code, params: w.params, message: w.message }).text) ?? [];
      toast(coded.length ? `Obserwujesz ${label} · ${coded[0]}` : r.created_instrument && r.warnings?.length ? `Obserwujesz ${label} · symbol ceny zgadnięty, sprawdź, czy przyjdą notowania` : `Obserwujesz ${label}`, 6000);
      onChanged();
    } catch (e) {
      setErr(e instanceof ApiError && e.status === 409 && !e.code ? "Ten instrument już jest na liście." : errorText(e));
    } finally { setBusy(false); }
  };
  const flight = useInFlight();
  const remove = (w: WatchItem) => flight.run(async () => {
    try {
      await deleteWatch(slug, w.id);
      onChanged();
      // The undo re-adds the item with its note and tags; failures get a toast (F7 FE8). An agent's item comes
      // back as the owner's (the API has no restore for the watchlist).
      const u = makeUndo(Date.now(), () => postWatch(slug, { instrument_id: w.instrument_id, note: w.note, tags: w.tags?.length ? w.tags : null }));
      offerUndo(toast, `Usunięto ${w.instrument?.label ?? "instrument"} z obserwowanych`, u, "usunięcie z obserwowanych", onChanged, 10000,
        () => (w.source === "agent" ? "wraca jako Twoja pozycja" : null));
    } catch (e) { toast(`Nie usunięto: ${errorText(e)}`, 4000); }
  });
  return (
    <Widget title="Obserwowane" count={list.length || undefined} id="inv-watch"
      controls={<button className="btn sm" onClick={() => setAdding((v) => !v)} aria-expanded={adding}>+ Dodaj</button>}
      body="flush tight"
      footer={<FootFacts items={[alerts > 0 && <><b>{alerts}</b> {alerts === 1 ? "alert" : "alerty"}</>]} />}>
      {adding && (
        <div className="inline-add">
          <input ref={input} value={text} onChange={(e) => setText(e.target.value)} placeholder="symbol lub ISIN" aria-label="Symbol lub ISIN"
            onKeyDown={(e) => { if (e.key === "Enter") void add(); if (e.key === "Escape") { e.stopPropagation(); setAdding(false); } }} />
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="notatka" aria-label="Notatka" style={{ flex: "1 1 120px" }}
            onKeyDown={(e) => { if (e.key === "Enter") void add(); }} />
          <button className="btn primary sm" onClick={add} disabled={busy || !text.trim()}>{busy ? "Dodaję…" : "Dodaj"}</button>
          {err && <span className="neg" style={{ fontSize: 12, flexBasis: "100%" }} role="alert">{err}</span>}
        </div>
      )}
      {!items ? <div style={{ padding: "8px 16px" }}><Skeleton h={80} /></div> : !list.length ? (
        <div className="empty">Brak obserwowanych.</div>
      ) : (
        <table>
          <tbody>
            {list.map((w) => {
              const mv = watchMove(w.closes_30d, w.price?.change_1d);
              const wk = mv?.value ?? null;
              const label = w.instrument ? instName(w.instrument) : `instrument ${w.instrument_id}`;
              return (
                <tr key={w.id}>
                  <td>
                    <span className="nm"><button className="nm" onClick={() => onOpen(w.instrument_id)}>{label}</button>{w.source === "agent" && <> <AgentTag /></>}</span>
                    <span className="sym">{[w.instrument?.symbol, watchSummary(w)].filter(Boolean).join(" · ")}</span>
                  </td>
                  <td style={{ width: 80 }}><Spark values={(w.closes_30d ?? []).map((c) => c.close)} label={`${label}: 30 dni`} /></td>
                  <td className="num">
                    {w.price ? price(w.price.close, w.price.currency) : <span className="muted">brak ceny</span>}
                    {w.price?.stale && <span className="tag warn" style={{ marginLeft: 4 }}>stara</span>}
                    <span className={`sym ${wk == null ? "" : wk >= 0 ? "pos" : "neg"}`}>{mv ? `${pct(mv.value, true)} ${mv.label}` : ""}</span>
                  </td>
                  <td style={{ width: 28, paddingLeft: 0 }}>
                    <button className="icon-btn" title="Przestań obserwować" aria-label={`Przestań obserwować ${label}`} disabled={flight.busy} onClick={() => remove(w)}>✕</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </Widget>
  );
}
