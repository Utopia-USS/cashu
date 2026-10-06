// Asset detail v3 (design/v3/asset-detail/asset-detail.md, owner QA round 3 Q21-Q26; F6 owner decision 3: a
// drawer over the widget grid). Header: identity, price, the facts Wartość / Wynik / Śr. koszt / Ilość, the
// actions (+ Alert, + Transakcja, Zanotuj decyzję: one decision per position in a dialog, Decide.tsx) and a meta
// line (lots behind `n loty`, transactions, dividends, fees). Then the price chart with alert levels (user amber,
// agent blue), rule thresholds, the average cost and buy / sell markers; a two-column grid: Teza (plain text) and
// the model recommendation with its short reason on the left, Alerty above the research slot on the right
// (assetSlots.ts), `Sygnały i decyzje` below: the open signals as rows (a quiet `potwierdź`) above a timeline with
// one fact per row. The same content renders in the drawer (AssetDrawer) and as a page ("otwórz jako stronę").
// Watched instruments (not held): no facts and no meta line, no Teza, research only with notes.
// P1: the model recommendation is read-only here. The owner records their own decision separately.
// P2: the main strategy hint ends the sub line under the name (its title lists every hint); P3: the Rekomendacja card
// is tinted yellow / red when data stored after it puts it in question, with the reasons as short lines.
import { useMemo, useState } from "react";
import { LineChart, type Level } from "../../../charts";
import { labelIndices } from "../../../chart";
import { monthYearShort } from "../../../format";
import { useAsync } from "../../../hooks";
import { Seg, Skeleton, useToast } from "../../../ui";
import { FootFacts, PolDot, Widget } from "../../../widgets";
import { getPositionChart, getPositionDetail, type Position, type Thesis } from "../api";
import { accountLabel, bucketLabel, dmy, ENTRY_TYPE, micName, money, money0, pct, plural, qty, wdm } from "../labels";
import { InstLabel, PlanGlyph } from "./InstLabel";
import { AlertRow, removeAlertWithUndo } from "./Alerts";
import { type Alert, getDecisionsFor, getSignalsV2, invKey, type SignalV2, type WatchItem } from "./api";
import { isHeld, useInstState } from "./instState";
import { ASSET_SLOTS, type AssetSlotProps } from "./assetSlots";
import { PositionDecisionDialog } from "./Decide";
import { isResearchKind, signalNoteId } from "./research/logic";
import {
  assetTimeline, averageCost, FRESH_LABEL, freshOf, freshReasonLines, headerMeta, instName, knownHints, lotRows, openRows, planLabel, polarityOf,
  price as priceText, signalFact, STATE_LABEL, stateOf, tlDate, weekChange,
} from "./logic";
import { HintChip } from "./hints";
import { todayLocal } from "../../../time";
import { Age, Fact1, legacyDecisions, longText, type SignalsCtx, signalAge, useSignalAck } from "./Signals";

const MONTHS: [string, number][] = [["6M", 6], ["1R", 12], ["2R", 24], ["Max", 120]];

/** Name of an instrument for the drawer label and crumb before the detail loads. */
export function assetName(id: number, positions: Position[], watch: WatchItem[]): string {
  const p = positions.find((x) => String(x.instrument.id) === String(id));
  if (p) return instName(p.instrument);
  const w = watch.find((x) => x.instrument_id === id);
  return w?.instrument ? instName(w.instrument) : `instrument ${id}`;
}

export function AssetDetail({ id, ctx, positions, alerts, watch, mode, noteId, onNewAlert, onAddTxn, onTxns, onThesis, onJournal, onAlerts, onAlertsChanged }: {
  id: number;
  ctx: SignalsCtx;
  positions: Position[];
  alerts: Alert[];
  watch: WatchItem[];
  mode: "drawer" | "page";
  /** `?note=` of the deep link, passed to the research slot. */
  noteId: string | null;
  onNewAlert: () => void;
  onAddTxn: () => void;
  onTxns: (p: Position) => void;
  onThesis: (p: Position, thesis: Thesis | null) => void;
  onJournal: () => void;
  /** The alerts manager filtered to this instrument. */
  onAlerts: () => void;
  onAlertsChanged: () => void;
}) {
  const toast = useToast();
  const slug = ctx.slug;
  const [months, setMonths] = useState(24);
  const [decideOpen, setDecideOpen] = useState(false);
  const [lotsOpen, setLotsOpen] = useState(false);
  const pos = positions.find((p) => String(p.instrument.id) === String(id)) ?? null;
  const w = watch.find((x) => x.instrument_id === id) ?? null;
  // Keyed (F7 PX4): reopening an asset shows its last detail, chart and signals at once and refreshes them.
  // Re-read with the page's data (`ctx.positions` changes on every reload): a decision or its undo shows in the timeline.
  const detail = useAsync(() => (pos ? getPositionDetail(slug, id) : Promise.resolve(null)), [slug, id, !!pos, ctx.positions],
    { key: pos ? invKey(slug, "position", id) : undefined });
  // Watched (not held): no position detail, so the timeline's decisions come from the journal of this instrument.
  const watchedDecisions = useAsync(() => (pos ? Promise.resolve(null) : getDecisionsFor(slug, id)), [slug, id, !!pos, ctx.positions],
    { key: pos ? undefined : invKey(slug, "decisions", id) });
  const chart = useAsync(() => getPositionChart(slug, id, months), [slug, id, months], { key: invKey(slug, "chart", id, months) });
  const sig = useAsync(() => getSignalsV2(slug, "all"), [slug, id, ctx.positions], { key: invKey(slug, "signals", "all") });
  const inst = pos?.instrument ?? detail.data?.instrument ?? w?.instrument ?? null;
  const name = inst ? instName(inst) : chart.data?.label ?? `instrument ${id}`;
  const mine = alerts.filter((a) => a.instrument_id === id);
  const live = mine.filter((a) => a.status === "active" || a.status === "triggered" || a.status === "snoozed");
  const signals = (sig.data ?? []).filter((s) => s.instrument_id === id);
  const undecided = openRows(signals);
  // The header glyph says something waits for a decision: open signals no decision covers (none once decided).
  const state = stateOf(undecided.map(polarityOf));
  const thesis = detail.data?.theses[detail.data.theses.length - 1] ?? null;
  const c = pos?.price_currency ?? chart.data?.currency ?? inst?.currency ?? "PLN";
  const series = chart.data?.series ?? [];
  const closes = series.map((p) => p.close);
  const last = chart.data?.last?.close ?? pos?.price ?? w?.price?.close ?? null;
  const high = chart.data?.high_52w ?? null;
  const fromHigh = high && last ? last / high - 1 : null;
  const wk = weekChange(series.length ? series.slice(-30) : (w?.closes_30d ?? null));
  const accounts = ctx.accounts;
  const lots = lotRows(pos?.lots ?? []);
  const firstLot = lots.rows[0];
  const acc = pos?.accounts.length === 1 ? accounts.find((a) => a.id === pos.accounts[0].account_id) : null;
  const fees = (detail.data?.transactions ?? []).reduce((s, t) => s + (t.fee || 0), 0);
  const meta = pos ? headerMeta({ lots: lots.rows.length, txns: detail.data ? detail.data.transactions.length : null, dividends: pos.dividends, fees, currency: c }) : [];
  const legacy = legacyDecisions(slug);
  // Held: a decision without an open signal is fine (position decisions); watched, or an older server: only with one.
  const canDecide = undecided.length > 0 || (!!pos && !legacy);

  const levels: Level[] = useMemo(() => {
    const out: Level[] = [];
    for (const a of live) {
      if ((a.kind === "price_below" || a.kind === "price_above") && typeof a.params.level === "number") {
        out.push({ y: a.params.level, cls: a.source === "agent" ? "agent" : "alert", label: `${a.source === "agent" ? "alert agenta" : "alert"} · ${a.kind === "price_below" ? "poniżej" : "powyżej"} ${priceText(a.params.level, c).replace(/\s?(zł|€|\$)$/, "")}` });
      }
    }
    for (const t of chart.data?.thresholds ?? []) {
      // By rule kind, never the strategy's rule id (FE-A A6): "transza -15 % od szczytu", "zysk +60 % od kosztu".
      const word = ({ drawdown_from_high: "transza", loss_from_cost: "strata", gain_from_cost: "zysk" } as Record<string, string>)[t.kind] ?? "reguła";
      out.push({ y: t.y, cls: "rule", muted: true, label: `${word} ${t.kind === "gain_from_cost" ? "+" : "-"}${Math.round(t.threshold * 100)} % od ${t.basis === "cost" ? "kosztu" : "szczytu"} · ${t.y.toLocaleString("pl-PL", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` });
    }
    if (high != null) out.push({ y: high, cls: "rule", muted: true, label: `szczyt 52 tyg. · ${high.toLocaleString("pl-PL", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` });
    const cost = chart.data?.cost?.average;
    if (cost != null && pos?.valuation_mode === "market") out.push({ y: cost, cls: "cost", muted: true, label: `śr. koszt · ${cost.toLocaleString("pl-PL", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` });
    return out;
  }, [live, chart.data, high, c, pos?.valuation_mode]);
  // Buy / sell markers inside the shown range, on the line (the close of the trade day).
  const markers = (chart.data?.markers ?? []).filter((m) => series.length > 1 && m.date >= series[0].date).map((m) => {
    let i = series.findIndex((p) => p.date >= m.date);
    if (i < 0) i = series.length - 1;
    return { i, cls: (m.type === "sell" ? "sell" : "buy") as "buy" | "sell" };
  });
  const vol30 = (() => {
    const xs = closes.slice(-31);
    if (xs.length < 10) return null;
    const r = xs.slice(1).map((v, i) => Math.log(v / xs[i]));
    const m = r.reduce((a, b) => a + b, 0) / r.length;
    return Math.sqrt(r.reduce((a, b) => a + (b - m) ** 2, 0) / (r.length - 1));
  })();
  const nearest = live.filter((a) => a.kind.startsWith("price_") && typeof a.params.level === "number" && last)
    .map((a) => ({ a, d: (a.params.level as number) / last! - 1 })).sort((x, y) => Math.abs(x.d) - Math.abs(y.d))[0];
  const removeAlert = (a: Alert) => { void removeAlertWithUndo(slug, a, toast, onAlertsChanged); };

  const slot: AssetSlotProps = { slug, instrumentId: id, name, symbol: inst?.symbol ?? null, held: !!pos, thesis, noteId, mode, onChanged: ctx.onChanged, onRead: ctx.onResearchRead };
  const { Research, ThesisTags } = ASSET_SLOTS;
  const researchShown = ASSET_SLOTS.useResearchShown?.(slot) ?? true;
  const names = useMemo(() => new Map(ctx.positions.map((p) => [Number(p.instrument.id), instName(p.instrument)] as [number, string])), [ctx.positions]);
  const timeline = assetTimeline({
    signals, decisions: (pos ? detail.data?.decisions : watchedDecisions.data) ?? [], theses: detail.data?.theses ?? [], txns: detail.data?.transactions ?? [],
    ctx: { total: ctx.total, base: ctx.base, names }, currency: c,
  });

  const pctOf = pos?.weight;
  // Phone width: room for the level labels and fewer date labels under the chart.
  const small = typeof window !== "undefined" && window.matchMedia?.("(max-width: 640px)").matches;
  const yearNow = todayLocal().slice(0, 4);
  // All accounts, not the first one (F7 FE6); per-account cost stays in "Per rachunek".
  const avgCost = pos ? averageCost(pos, ctx.base) : null;
  // Held from the unfiltered data (the same source as the tiles); a held-only recommendation on a watched
  // instrument is hidden, like the tile.
  const instState = useInstState();
  const held = !!pos || isHeld(instState, id);
  const pLabel = (v: string | null) => planLabel(v, held);
  const plan = inst?.plan && pLabel(inst.plan) ? inst.plan : null;
  const toSignals = () => document.getElementById(`asset-signals-${id}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
  // P2: what the owner's own rules say now (the detail's, else the position / watchlist row's); main first.
  const hints = knownHints(detail.data?.hints ?? pos?.hints ?? w?.hints ?? [], held);
  // P3: the recommendation's freshness (yellow / red card, reason lines).
  const fresh = plan ? freshOf(inst?.plan_freshness) : null;
  const reasons = fresh ? freshReasonLines(inst?.plan_freshness, { hints, alerts: mine }) : [];

  const head = (
    <section className="w ahead s2" aria-label={name}>
      <div>
        <h2 className="nm">{inst ? (
          <InstLabel density="header" inst={inst} text={name} card={false}
            sub={[inst.symbol !== name ? inst.symbol : null, micName(inst.mic), bucketLabel(pos?.bucket)].filter(Boolean).join(" · ")} />
        ) : name}</h2>
        <div className="muted hsub" style={{ fontSize: 12.5, marginTop: 2 }}>
          {[acc ? accountLabel(acc, accounts) : pos ? plural(pos.accounts.length, "rachunek", "rachunki", "rachunków") : "obserwowany", firstLot ? `od ${dmy(firstLot.open_date)}` : null].filter(Boolean).join(" · ")}
          {state && <> · <button className="lnk hsig" onClick={toSignals}><PolDot state={state} /> {STATE_LABEL[state]}</button></>}
          {hints.length > 0 && <> · <HintChip hint={hints[0]} held={held} all={hints} /></>}
        </div>
      </div>
      <div className="sep" aria-hidden />
      <div>
        <div className="px">{last != null ? money(last, c) : "-"}{wk != null && <span className={wk >= 0 ? "pos" : "neg"}>{pct(wk, true)} tydz.</span>}</div>
        <div className="muted" style={{ fontSize: 12 }}>{chart.data?.last ? wdm(chart.data.last.date) : ""}{fromHigh != null ? <> · od szczytu <b className={fromHigh < 0 ? "neg" : "pos"}>{pct(fromHigh)}</b></> : ""}</div>
      </div>
      {pos && (
        <>
          <div className="sep" aria-hidden />
          <div className="hfx">
            <div className="fact"><div className="l">Wartość</div><div className="v sm">{money(pos.value, ctx.base)}</div>{pctOf != null && <div className="d">{pct(pctOf)} portfela</div>}</div>
            <div className="fact"><div className="l">Wynik</div><div className={`v sm ${(pos.unrealized ?? 0) >= 0 ? "pos" : "neg"}`}>{money0(pos.unrealized, ctx.base, true)}</div>
              <div className="d">{pct(pos.unrealized_pct, true)}</div></div>
            <div className="fact"><div className="l">Śr. koszt</div><div className="v sm">{avgCost ? money(avgCost.value, avgCost.currency) : "-"}</div></div>
            <div className="fact"><div className="l">Ilość</div><div className="v sm">{qty(pos.quantity)}</div></div>
          </div>
        </>
      )}
      <span className="spacer" />
      <div className="hdr-right">
        <button className="btn" onClick={onNewAlert}>+ Alert</button>
        {pos && <button className="btn" onClick={onAddTxn}>+ Transakcja</button>}
        <button className="btn primary" disabled={!canDecide} title={canDecide ? undefined : "Brak otwartego sygnału"} onClick={() => setDecideOpen(true)}>Zanotuj decyzję</button>
      </div>
      {pos && (
        <div className="hmeta">
          {meta.map((m, k) => (
            <span key={m.kind} className="mi">
              {k > 0 && <span className="msep" aria-hidden>·</span>}
              {m.kind === "lots" ? (m.toggle
                ? <button className="lnk" aria-expanded={lotsOpen} aria-controls={`hlots-${id}`} onClick={() => setLotsOpen((v) => !v)}>{m.text}</button>
                : <span>{m.text}</span>)
                : m.kind === "txns" ? <button className="lnk" onClick={() => onTxns(pos)}>{m.text}</button>
                : <span>{m.label} <b>{m.value}</b></span>}
            </span>
          ))}
        </div>
      )}
      {pos && lotsOpen && lots.rows.length > 1 && (
        <div className="hlots" id={`hlots-${id}`}>
          <table className="lots">
            <thead><tr><th>data</th><th className="num">ilość</th><th className="num">cena</th><th className="num">wynik</th><th className="num">wynik %</th></tr></thead>
            <tbody>
              {lots.rows.map((l, k) => {
                const a = accounts.find((x) => x.id === l.account_id);
                return (
                  <tr key={k}>
                    <td className="tnum">{dmy(l.open_date)}{lots.multi && a && <span className="sym">{accountLabel(a, accounts)}</span>}</td>
                    <td className="num">{qty(l.quantity)}</td>
                    <td className="num">{l.unit_cost != null ? money(l.unit_cost, l.currency) : "-"}</td>
                    <td className={`num ${(l.result ?? 0) >= 0 ? "pos" : "neg"}`}>{money0(l.result, l.currency, true)}</td>
                    <td className={`num ${(l.resultPct ?? 0) >= 0 ? "pos" : "neg"}`}>{pct(l.resultPct, true)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );

  const priceChart = (
    <Widget title="Cena z poziomami" count={c} className="s2" controls={<Seg quiet label="Zakres" value={months} onChange={setMonths} items={MONTHS} />} body="tight"
      footer={<FootFacts items={[
        high != null && <>szczyt 52 tyg. <b>{money(high, c)}</b></>,
        closes.length > 1 && <>dołek <b>{money(Math.min(...closes), c)}</b></>,
        vol30 != null && <>zmienność 30 dni <b>{pct(vol30)}</b></>,
        nearest && <>do alertu {priceText(nearest.a.params.level as number, c)}: <b>{pct(nearest.d, true)}</b></>,
      ]} />}>
      <div className="legend" style={{ marginBottom: 6 }}>
        <span><i className="main" />cena</span>
        {levels.some((l) => l.cls === "alert") && <span><i className="alert" />alerty</span>}
        {levels.some((l) => l.cls === "agent") && <span><i className="agent" />alert agenta</span>}
        {(chart.data?.thresholds.length ?? 0) > 0 && <span><i className="rule" />progi reguł</span>}
        {levels.some((l) => l.cls === "cost") && <span><i className="cost" />śr. koszt</span>}
        {markers.some((m) => m.cls === "buy") && <span><i className="dotb" />zakupy</span>}
        {markers.some((m) => m.cls === "sell") && <span><i className="dots" />sprzedaże</span>}
      </div>
      {chart.loading && !chart.data ? <Skeleton h={mode === "drawer" ? 260 : 300} /> : series.length < 2 ? (
        <div className="empty">{pos?.valuation_mode === "cost" ? "Wycena po koszcie: bez notowań." : pos?.valuation_mode === "manual" ? "Wycena ręczna: bez notowań." : "Za mało notowań."}</div>
      ) : (
        <LineChart label={`${name}: cena z poziomami alertów i reguł`} height={mode === "drawer" ? 260 : 300} padL={small ? 36 : 46} padR={small ? 150 : 200} yTicks={5}
          yFmt={(v) => v.toLocaleString("pl-PL", { maximumFractionDigits: v >= 100 ? 0 : 2 })}
          xLabels={labelIndices(series.length, small ? 3 : 5).map((i) => ({ i, text: monthYearShort(series[i].date) }))}
          series={[{ values: closes, cls: "main", endLabel: last != null ? money(last, c) : undefined }]} levels={levels} markers={markers}
          tooltip={(i) => <><div className="k">{dmy(series[i].date)}</div><div>cena <b>{money(series[i].close, c)}</b></div></>} />
      )}
    </Widget>
  );

  const thesisW = pos && (
    <Widget title="Teza" tags={<>{thesis?.entry_type ? <span className="sub">{ENTRY_TYPE[thesis.entry_type] ?? thesis.entry_type}</span> : null}{ThesisTags && <ThesisTags {...slot} />}</>}
      controls={<button className="btn sm" onClick={() => onThesis(pos, thesis)}>{thesis ? "Edytuj" : "Dodaj"}</button>} body="tight">
      {thesis ? (
        <div className="tz">
          {thesis.thesis && <p><b>Wejście</b>{thesis.thesis}</p>}
          {thesis.invalidation && <p><b>Unieważnienie</b>{thesis.invalidation}</p>}
          {thesis.exit_plan && <p><b>Plan wyjścia</b>{thesis.exit_plan}</p>}
          {thesis.size_plan && <p><b>Wielkość i dokupienia</b>{thesis.size_plan}</p>}
        </div>
      ) : <div className="muted" style={{ fontSize: 13 }}>Brak tezy.</div>}
    </Widget>
  );

  // P3: tinted yellow (may be outdated) / red (outdated, the owner's explicit exception to "no P/L red"), a tag, and
  // the reasons stored after the recommendation as short muted lines (a note reason links to its note).
  const recW = plan && (
    <Widget title="Rekomendacja" className={fresh ? `recw ${fresh}` : "recw"}
      tags={<>
        {inst?.plan_at && <span className="sub" title="Rekomendacja modelu. Decyzję zapisujesz osobno.">{dmy(inst.plan_at)}</span>}
        {fresh && <span className={`tag ${fresh === "out" ? "neg" : "warn"}`} title="Według danych zapisanych po rekomendacji">{FRESH_LABEL[fresh]}</span>}
      </>} body="tight">
      <div className="rec" aria-label={`Rekomendacja modelu: ${pLabel(plan)}`} data-fresh={fresh ?? undefined}>
        <b><PlanGlyph plan={plan} className="pcoin" />{pLabel(plan)}</b>
        {inst?.plan_reason && <p>{inst.plan_reason}</p>}
        {reasons.length > 0 && (
          <ul className="rsn" aria-label="Powody">
            {reasons.map((r) => (
              <li key={r.key}>{r.noteId != null && ctx.onOpenNote
                ? <button className="lnk" onClick={() => ctx.onOpenNote!(id, r.noteId, null)}>{r.text}</button>
                : r.text}</li>
            ))}
          </ul>
        )}
      </div>
    </Widget>
  );

  const alertsW = (
    <Widget title="Alerty" controls={<><button className="lnk" onClick={onAlerts}>wszystkie</button><button className="btn sm" onClick={onNewAlert}>+ Nowy</button></>} body="tight">
      {!live.length ? <div className="muted" style={{ fontSize: 13 }}>Brak alertów.</div>
        : live.map((a) => <AlertRow key={a.id} a={a} compact onRemove={a.source === "agent" ? () => removeAlert(a) : undefined} />)}
    </Widget>
  );

  const research = Research && researchShown ? <Research {...slot} /> : null;
  const timelineW = (
    <Widget title="Sygnały i decyzje" id={`asset-signals-${id}`} className={thesisW || recW || research ? "s2" : undefined} controls={<button className="lnk" onClick={onJournal}>dziennik</button>} body="tight">
      {undecided.length > 0 && (
        <div className="osig">{undecided.map((s) => <OpenSignalRow key={s.id} s={s} ctx={ctx} />)}</div>
      )}
      {!timeline.length && !undecided.length ? <div className="muted" style={{ fontSize: 13 }}>Brak sygnałów i decyzji.</div> : timeline.length > 0 && (
        <div className="tl wide">
          {timeline.map((e) => (
            <div key={e.key} style={{ display: "contents" }}>
              <div className="d">{tlDate(e.at, yearNow)}</div>
              <div className="m"><i className={e.dot} aria-hidden /></div>
              <div className="t" title={e.title}><b>{e.head}</b>{e.fact ? ` · ${e.fact}` : ""}{e.tail && <span> · {e.tail}</span>}
                {e.sub && <div className="sub">{e.sub}</div>}</div>
            </div>
          ))}
        </div>
      )}
    </Widget>
  );

  // Two columns (research.css .g2): Teza + Rekomendacja on the left, Alerty above research on the right. With
  // nothing on the left (watched, no recommendation) Alerty move there; a right column left empty takes the timeline.
  const left = thesisW || recW;
  const leftCol = left ? <div className="stack">{thesisW}{recW}</div> : <div className="stack">{alertsW}</div>;
  const rightCol = left ? <div className="stack">{alertsW}{research}</div> : research;
  return (
    <div className="g2 asset">
      {head}
      {priceChart}
      {leftCol}
      {rightCol ?? timelineW}
      {rightCol && timelineW}
      {decideOpen && (
        <PositionDecisionDialog instrumentId={id} name={name} symbol={inst?.symbol ?? null} signals={undecided} ctx={ctx} thesis={thesis} held={!!pos}
          onClose={() => setDecideOpen(false)} />
      )}
    </div>
  );
}

/** One open signal of the asset (7.1): the glyph, one fact (+ `notatka` for research), the date and a quiet
 * `potwierdź` (acknowledge, toast + `Cofnij`). The decision is the header's, once per position. */
function OpenSignalRow({ s, ctx }: { s: SignalV2; ctx: SignalsCtx }) {
  const { ack, busy } = useSignalAck(ctx);
  const research = isResearchKind(s.kind) || s.source === "research";
  const noteId = research ? signalNoteId(s) : null;
  return (
    <div className="sig orow" data-signal={s.id}>
      <PolDot polarity={polarityOf(s)} />
      <div className="m" title={longText(s, ctx)}>
        <Fact1 f={signalFact(s)} />
        {research && ctx.onOpenNote && <> · <button className="lnk" onClick={() => ctx.onOpenNote!(s.instrument_id, noteId, typeof s.payload.theme === "string" ? s.payload.theme : null)}>notatka</button></>}
        <Age a={signalAge(s, ctx)} />
      </div>
      <div className="rt"><button className="lnk quiet" disabled={busy(s)} onClick={() => ack(s)}>potwierdź</button></div>
    </div>
  );
}
