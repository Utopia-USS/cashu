// Obserwowane (ia-v2.md 7, F-11; home v3 Q6: a tab of Aktywa): instruments the owner does not hold, with the
// price, a 30-day sparkline, the weekly change and the nearest alert or the note; `+ Dodaj` opens the instrument
// search (F12, InstrumentSearch.tsx); agent-added rows carry the badge; removing toasts with undo (re-adds the
// instrument by id, which restores the same entry with its research, notes and tags).
import { type ReactNode, useState } from "react";
import { errorText } from "../../../core/messages";
import { Spark } from "../../../charts";
import { useInFlight } from "../../../hooks";
import { Skeleton, useToast } from "../../../ui";
import { AgentTag, FootFacts, Widget } from "../../../widgets";
import { pct } from "../labels";
import { deleteWatch, postWatch, type WatchItem } from "./api";
import { HintChip, mainHint } from "./hints";
import { InstLabel } from "./InstLabel";
import { InstrumentSearch } from "./InstrumentSearch";
import { instName, planLabel, price, watchMove, weekChange } from "./logic";
import { offerRecreate } from "./undoFlow";
import { KIND_WORD, S } from "./Watchlist.strings.ts";

type Toast = ReturnType<typeof useToast>;

/** Stop watching with an undo toast (the list's ✕ and the asset header's `Obserwujesz`): the undo re-adds by
 * `instrument_id`, which restores the same row (F12 B1); failures get a toast (F7 FE8). An agent's item comes back
 * as the owner's. The outcome is the POST's own (F7 fix pass F6): 409 "Już na liście", 404 "Nie przywrócono: ...". */
export async function removeWatchWithUndo(slug: string, w: Pick<WatchItem, "id" | "instrument_id" | "note" | "tags" | "source">, label: string,
  toast: Toast, onChanged: () => void): Promise<void> {
  try {
    await deleteWatch(slug, w.id);
    onChanged();
    offerRecreate(toast, S.removed(label),
      () => postWatch(slug, { instrument_id: w.instrument_id, note: w.note, tags: w.tags?.length ? w.tags : null }),
      S.removeWhat, onChanged, errorText, 10000, () => (w.source === "agent" ? S.backAsYours : null));
  } catch (e) { toast(S.removeFailed(errorText(e)), 4000); }
}

/** "1 alert: poniżej 560,00 $" / "2 alerty" / the note / "bez alertu". */
export function watchSummary(w: WatchItem): string {
  const n = w.alerts.live;
  const near = w.alerts.nearest;
  const cur = w.price?.currency ?? w.instrument?.currency;
  if (n && near) {
    const what = near.level != null ? `${(KIND_WORD as Record<string, string | undefined>)[near.kind] ?? near.title} ${price(near.level, cur)}` : near.title;
    return `${S.alerts(n)}: ${what}`;
  }
  if (n) return S.alerts(n);
  return w.note ? w.note : S.noAlert;
}

/** "1 alert: poniżej 560,00 $" / "2 alerty" / "bez alertu" (the Obserwowane tab's Alerty column, no note). */
export function watchAlerts(w: WatchItem): string {
  return w.alerts.live ? watchSummary({ ...w, note: null }) : S.noAlert;
}

/** The Obserwowane list (home v3 Q6): `wide` = the Aktywa tab (Instrument | Rekomendacja + strategia | 30 dni | Cena | tydz. | Alerty | ✕,
 * rows open the asset); narrow = the light grid's widget (name + summary | spark | price | ✕). The instrument search
 * shows while `adding`. */
export function WatchTable({ slug, items, wide, adding, onAdding, onChanged, onOpen, flags }: {
  slug: string;
  items: WatchItem[] | null;
  wide?: boolean;
  adding: boolean;
  onAdding: (v: boolean) => void;
  onChanged: () => void;
  onOpen: (instrumentId: number) => void;
  /** Markers after the name (signal glyph, bell, page): Aktywa's `rowFlags`. */
  flags?: (w: WatchItem) => ReactNode;
}) {
  const toast = useToast();
  const list = items ?? [];
  const recommendationCoverage = list.filter((w) => planLabel(w.instrument?.plan, false)).length;
  const flight = useInFlight();
  const remove = (w: WatchItem) => flight.run(() =>
    removeWatchWithUndo(slug, w, w.instrument ? instName(w.instrument) : "instrument", toast, onChanged));
  const addRow = adding && <InstrumentSearch slug={slug} onClose={() => onAdding(false)} onChanged={onChanged} onOpen={onOpen} />;
  const removeBtn = (w: WatchItem, label: string) => (
    <button className="icon-btn" title={S.unwatch} aria-label={S.unwatchAria(label)} disabled={flight.busy} onClick={() => remove(w)}>✕</button>
  );
  const body = !items ? <div style={{ padding: "8px 16px" }}><Skeleton h={80} /></div> : !list.length ? (
    <div className="empty">{S.empty}</div>
  ) : wide ? (
    <div className="scroll">
      <table>
        <thead><tr><th className="c-inst">Instrument</th><th className="c-hint">{S.colRecommendation} <span className="watch-cov">{recommendationCoverage}/{list.length}</span></th><th className="c-spark">{S.col30d}</th><th className="num">{S.colPrice}</th><th className="num">{S.colWeek}</th><th>{S.colAlerts}</th><th style={{ width: 28 }}><span className="sr-only">{S.colActions}</span></th></tr></thead>
        <tbody>
          {list.map((w) => {
            const mv = watchMove(w.closes_30d, w.price?.change_1d);
            // A one-session change (no week of closes yet) gets its suffix and title.
            const daily = mv != null && weekChange(w.closes_30d) == null;
            const label = w.instrument ? instName(w.instrument) : `instrument ${w.instrument_id}`;
            const hint = mainHint(w.hints, w.held);
            const recommendation = planLabel(w.instrument?.plan, false);
            return (
              <tr key={w.id} className="rowlink" onClick={(e) => { if (!(e.target as HTMLElement).closest("button, a, input, select")) onOpen(w.instrument_id); }}>
                <td className="c-inst">
                  {w.instrument ? (
                    <InstLabel inst={w.instrument} onOpen={() => onOpen(w.instrument_id)} sub={w.note ?? undefined} hints={w.hints}
                      badges={<>{flags?.(w)}{w.source === "agent" && <AgentTag mono text="agent" />}</>} />
                  ) : <span className="nm"><button className="nm" onClick={() => onOpen(w.instrument_id)}>{label}</button></span>}
                </td>
                <td className="c-hint"><div className="watch-rec">
                  {recommendation
                    ? <span className="watch-plan" title={w.instrument?.plan_reason ?? undefined} aria-label={S.recommendationAria(recommendation)}>{recommendation}</span>
                    : <span className="watch-plan unset">{S.none}</span>}
                  {hint && <HintChip hint={hint} held={w.held} />}
                </div></td>
                <td className="c-spark"><Spark values={(w.closes_30d ?? []).map((c) => c.close)} label={S.spark30d(label)} /></td>
                <td className="num">{w.price ? price(w.price.close, w.price.currency) : <span className="muted">{S.noPrice}</span>}{w.price?.stale && <> <span className="tag warn">{S.stale}</span></>}</td>
                <td className={`num ${mv == null ? "muted" : mv.value >= 0 ? "pos" : "neg"}`} title={daily ? S.oneSessionTitle : undefined}>{mv ? `${pct(mv.value, true)}${daily ? ` ${S.oneDay}` : ""}` : "-"}</td>
                <td className={w.alerts.live ? undefined : "muted"}>{watchAlerts(w)}</td>
                <td style={{ width: 28, paddingLeft: 0 }}>{removeBtn(w, label)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  ) : (
    <table>
      <tbody>
        {list.map((w) => {
          const mv = watchMove(w.closes_30d, w.price?.change_1d);
          const wk = mv?.value ?? null;
          const label = w.instrument ? instName(w.instrument) : `instrument ${w.instrument_id}`;
          return (
            <tr key={w.id}>
              <td className="c-inst wide">
                {w.instrument ? (
                  <InstLabel density="compact" inst={w.instrument} onOpen={() => onOpen(w.instrument_id)} badges={w.source === "agent" && <AgentTag mono text="agent" />} sub={watchSummary(w)} hints={w.hints} />
                ) : (
                  <><span className="nm"><button className="nm" onClick={() => onOpen(w.instrument_id)}>{label}</button>{w.source === "agent" && <> <AgentTag mono text="agent" /></>}</span>
                    <span className="sym">{watchSummary(w)}</span></>
                )}
              </td>
              <td className="c-spark" style={{ width: 72 }}><Spark values={(w.closes_30d ?? []).map((c) => c.close)} label={S.spark30d(label)} /></td>
              <td className="num">
                {w.price ? price(w.price.close, w.price.currency) : <span className="muted">{S.noPrice}</span>}
                {w.price?.stale && <span className="tag warn" style={{ marginLeft: 4 }}>{S.stale}</span>}
                <span className={`sym ${wk == null ? "" : wk >= 0 ? "pos" : "neg"}`}>{mv ? `${pct(mv.value, true)} ${mv.label}` : ""}</span>
              </td>
              <td style={{ width: 28, paddingLeft: 0 }}>{removeBtn(w, label)}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
  return <>{addRow}{body}</>;
}

/** The standalone Obserwowane widget (the light grid of a zero-start profile only; the full home shows the list
 * as the Aktywa tab). */
export function WatchlistWidget({ slug, items, onChanged, onOpen, autoAdd }: {
  slug: string;
  items: WatchItem[] | null;
  onChanged: () => void;
  onOpen: (instrumentId: number) => void;
  /** Open the instrument search (the minimal view's "obserwuj instrument"). */
  autoAdd?: boolean;
}) {
  const [adding, setAdding] = useState(!!autoAdd);
  const list = items ?? [];
  const alerts = list.reduce((a, w) => a + w.alerts.live, 0);
  return (
    <Widget title={S.title} count={list.length || undefined} id="inv-watch"
      controls={<button className="btn sm" onClick={() => setAdding((v) => !v)} aria-expanded={adding}>{S.add}</button>}
      body="flush tight"
      footer={<FootFacts items={[alerts > 0 && <><b>{alerts}</b> {S.alertsWord(alerts)}</>]} />}>
      <WatchTable slug={slug} items={items} adding={adding} onAdding={setAdding} onChanged={onChanged} onOpen={onOpen} />
    </Widget>
  );
}
