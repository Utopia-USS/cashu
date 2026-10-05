// Asset detail (design/v2/asset-detail.html, F-12; F6 owner decision 3: a drawer over the widget grid,
// design/v2/research/research-drawer.html): header facts, the price chart with alert levels (user amber,
// agent blue), rule thresholds (labelled with the rule id and basis), the average cost and buy / sell
// markers (labels stacked with leaders), then a two-column grid: Teza / Alerty / Loty on the left, the
// research slot on the right (assetSlots.ts; without it the timeline takes the right column), the
// signals-and-decisions timeline below. The same content renders in the drawer (AssetDrawer) and as a page
// ("otwórz jako stronę"). Watched instruments (not held) get the chart, alerts and timeline only.
import { useMemo, useState } from "react";
import { LineChart, type Level } from "../../../charts";
import { labelIndices } from "../../../chart";
import { monthYearShort } from "../../../format";
import { useAsync } from "../../../hooks";
import { Seg, Skeleton, useToast } from "../../../ui";
import { FootFacts, PolDot, Widget } from "../../../widgets";
import { type AccountRow, getPositionChart, getPositionDetail, type Position, type Thesis } from "../api";
import { accountLabel, bucketLabel, DECISION_ACTION, dm, dmy, ENTRY_TYPE, money, money0, pct, plural, qty, txnType, wdm } from "../labels";
import { AlertRow, removeAlertWithUndo } from "./Alerts";
import { type Alert, getSignalsV2, type WatchItem } from "./api";
import { ASSET_SLOTS, type AssetSlotProps, type AssetTimelineEntry, type ThesisField } from "./assetSlots";
import { isResearchKind } from "./research/logic";
import { instName, isDecided, polarityOf, price as priceText, signalText, weekChange } from "./logic";
import { SignalItem, type SignalsCtx } from "./Signals";

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
  const [decideOpen, setDecideOpen] = useState<number | null>(null);
  const pos = positions.find((p) => String(p.instrument.id) === String(id)) ?? null;
  const w = watch.find((x) => x.instrument_id === id) ?? null;
  const detail = useAsync(() => (pos ? getPositionDetail(slug, id) : Promise.resolve(null)), [slug, id, !!pos]);
  const chart = useAsync(() => getPositionChart(slug, id, months).catch(() => null), [slug, id, months]);
  const sig = useAsync(() => getSignalsV2(slug, "all").catch(() => []), [slug, id, ctx.positions]);
  const inst = pos?.instrument ?? detail.data?.instrument ?? w?.instrument ?? null;
  const name = inst ? instName(inst) : chart.data?.label ?? `instrument ${id}`;
  const mine = alerts.filter((a) => a.instrument_id === id);
  const live = mine.filter((a) => a.status === "active" || a.status === "triggered" || a.status === "snoozed");
  const signals = (sig.data ?? []).filter((s) => s.instrument_id === id);
  const open = signals.filter((s) => s.status === "active" || s.status === "acknowledged");
  const undecided = open.filter((s) => !isDecided(s) && !s.snoozed);
  const thesis = detail.data?.theses[detail.data.theses.length - 1] ?? null;
  const c = pos?.price_currency ?? chart.data?.currency ?? inst?.currency ?? "PLN";
  const series = chart.data?.series ?? [];
  const closes = series.map((p) => p.close);
  const last = chart.data?.last?.close ?? pos?.price ?? w?.price?.close ?? null;
  const high = chart.data?.high_52w ?? null;
  const fromHigh = high && last ? last / high - 1 : null;
  const wk = weekChange(series.length ? series.slice(-30) : (w?.closes_30d ?? null));
  const firstLot = [...(pos?.lots ?? [])].sort((a, b) => a.open_date.localeCompare(b.open_date))[0];
  const accounts = ctx.accounts;
  const acc = pos?.accounts.length === 1 ? accounts.find((a) => a.id === pos.accounts[0].account_id) : null;
  // Research signals have their own header note (research slot `HeaderNote`): the rule / alert signal leads here.
  const ruleOpen = open.filter((s) => !isResearchKind(s.kind));
  const mainSignal = ruleOpen.find((s) => !isDecided(s) && !s.snoozed) ?? ruleOpen[0] ?? null;
  const dividends = pos ? Object.entries(pos.dividends).filter(([, v]) => v) : [];
  const fees = (detail.data?.transactions ?? []).reduce((s, t) => s + (t.fee || 0), 0);

  const levels: Level[] = useMemo(() => {
    const out: Level[] = [];
    for (const a of live) {
      if ((a.kind === "price_below" || a.kind === "price_above") && typeof a.params.level === "number") {
        out.push({ y: a.params.level, cls: a.source === "agent" ? "agent" : "alert", label: `${a.source === "agent" ? "alert agenta" : "alert"} · ${a.kind === "price_below" ? "poniżej" : "powyżej"} ${priceText(a.params.level, c).replace(/\s?(zł|€|\$)$/, "")}` });
      }
    }
    for (const t of chart.data?.thresholds ?? []) {
      out.push({ y: t.y, cls: "rule", muted: true, label: `${t.rule_id} ${t.kind === "gain_from_cost" ? "+" : "-"}${Math.round(t.threshold * 100)} % od ${t.basis === "cost" ? "kosztu" : "szczytu"} · ${t.y.toLocaleString("pl-PL", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` });
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

  // Slots (research): props shared by every slot, the extra timeline rows from the slot's hook.
  const slot: AssetSlotProps = { slug, instrumentId: id, name, symbol: inst?.symbol ?? null, held: !!pos, thesis, noteId, mode, onChanged: ctx.onChanged };
  const extra: AssetTimelineEntry[] = ASSET_SLOTS.useTimeline?.(slot) ?? [];
  const { Research, ThesisTags, ThesisFieldChip, HeaderNote } = ASSET_SLOTS;
  const chip = (field: ThesisField) => (ThesisFieldChip ? <> <ThesisFieldChip {...slot} field={field} /></> : null);

  // Timeline: signals, decisions, thesis reviews, buys / sells. Research signals come as `Research: …` rows
  // from the research slot (useTimeline), so they are not listed twice.
  const timeline = [
    ...signals.filter((s) => !isResearchKind(s.kind)).map((s) => ({ at: s.first_seen_at ?? "", dot: polarityOf(s) === "positive" ? "pos" : polarityOf(s) === "negative" ? "neg" : "", head: polarityOf(s) === "positive" ? "Szansa" : polarityOf(s) === "negative" ? "Ryzyko" : "Sygnał",
      main: [signalText(s).lead?.replace(/ ·$/, ""), signalText(s).bold].filter(Boolean).join(" "), tail: s.status === "active" ? "otwarty" : s.status === "acknowledged" ? "potwierdzony" : s.status === "expired" ? "wygasł" : "rozstrzygnięty", signal: s.status === "active" && !isDecided(s) ? s.id : null })),
    ...(detail.data?.decisions ?? []).map((d) => ({ at: d.created_at ?? "", dot: "nw", head: `Decyzja: ${DECISION_ACTION[d.action] ?? d.action}`, main: d.quantity != null && (d.action === "bought" || d.action === "sold") ? `${qty(d.quantity)}${d.price != null ? ` @ ${money(d.price, d.currency ?? c)}` : ""}` : "", tail: d.reason ? `„${d.reason}"` : undefined, signal: null })),
    ...(detail.data?.theses ?? []).filter((t) => t.reviewed_at).map((t) => ({ at: t.reviewed_at!, dot: "", head: "Przegląd tezy", main: "", tail: "bez zmian", signal: null })),
    ...(detail.data?.transactions ?? []).filter((t) => t.type === "buy" || t.type === "sell").map((t) => ({ at: `${t.trade_date}T12:00:00`, dot: "nw", head: txnType(t.type).replace(/^./, (m) => m.toUpperCase()), main: `${qty(t.quantity)} @ ${money(t.price, t.currency)}`, tail: undefined, signal: null })),
    ...extra.map((e) => ({ at: e.at, dot: e.dot, head: e.head, main: e.main ?? "", tail: e.tail, signal: null as number | null, action: e.action })),
  ].filter((e) => e.at).sort((a, b) => b.at.localeCompare(a.at)).slice(0, 12) as { at: string; dot: string; head: string; main: string; tail?: string; signal: number | null; action?: AssetTimelineEntry["action"] }[];

  const pctOf = pos?.weight;
  // Phone width: room for the level labels and fewer date labels under the chart.
  const small = typeof window !== "undefined" && window.matchMedia?.("(max-width: 640px)").matches;
  const lastTrig = mine.map((a) => a.last_triggered_at).filter(Boolean).sort().slice(-1)[0] ?? null;
  const yearNow = new Date().toISOString().slice(0, 4);

  const head = (
    <section className="w ahead s2" aria-label={name}>
      <div>
        <h2 className="nm">{name} <span>{[inst?.symbol !== name ? inst?.symbol : null, inst?.mic, pos?.bucket ? bucketLabel(pos.bucket) : null].filter(Boolean).join(" · ")}</span></h2>
        <div className="muted" style={{ fontSize: 12.5, marginTop: 2 }}>
          {[acc ? accountLabel(acc, accounts) : pos ? `${plural(pos.accounts.length, "rachunek", "rachunki", "rachunków")}` : "obserwowany", firstLot ? `od ${dmy(firstLot.open_date)}` : null].filter(Boolean).join(" · ")}
          {mainSignal && <> · <PolDot polarity={polarityOf(mainSignal)} /> {polarityOf(mainSignal) === "positive" ? "szansa" : polarityOf(mainSignal) === "negative" ? "ryzyko" : "sygnał"}: {signalText(mainSignal).lead?.replace(/ ·$/, "") ?? signalText(mainSignal).title.toLowerCase()}</>}
          {HeaderNote && <HeaderNote {...slot} />}
          {live.length > 0 && ` · ${plural(live.length, "alert", "alerty", "alertów")}`}
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
            <div className="fact"><div className="l">Ilość</div><div className="v sm">{qty(pos.quantity)}</div></div>
            <div className="fact"><div className="l">Śr. koszt</div><div className="v sm">{pos.accounts[0]?.average_cost != null ? money(pos.accounts[0].average_cost, pos.accounts[0].cost_currency) : "-"}</div></div>
            <div className="fact"><div className="l">Wartość</div><div className="v sm">{money(pos.value, ctx.base)}</div>{pctOf != null && <div className="d">{pct(pctOf)} portfela</div>}</div>
            <div className="fact"><div className="l">Wynik</div><div className={`v sm ${(pos.unrealized ?? 0) >= 0 ? "pos" : "neg"}`}>{money0(pos.unrealized, ctx.base, true)}</div>
              <div className="d">{pct(pos.unrealized_pct, true)}{dividends.length ? ` · dywidendy ${dividends.map(([k, v]) => money0(v, k)).join(", ")}` : ""}</div></div>
          </div>
        </>
      )}
      <span className="spacer" />
      <div className="hdr-right">
        <button className="btn" onClick={onNewAlert}>+ Alert</button>
        {pos && <button className="btn" onClick={onAddTxn}>Dodaj transakcję</button>}
        <button className="btn primary" disabled={!undecided.length} title={undecided.length ? undefined : "Brak otwartego sygnału dla tego aktywa"}
          onClick={() => { setDecideOpen(undecided[0]?.id ?? null); document.getElementById(`asset-signals-${id}`)?.scrollIntoView({ behavior: "smooth", block: "center" }); }}>Zanotuj decyzję</button>
      </div>
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
        <div className="empty">{pos?.valuation_mode === "cost" ? "Wycena po koszcie + odsetki: instrument bez notowań, progi cenowe nie dotyczą." : pos?.valuation_mode === "manual" ? "Wycena ręczna: brak notowań rynkowych." : "Za mało notowań, żeby narysować wykres."}</div>
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
    <Widget title="Teza" tags={<>{thesis?.entry_type ? <span className="tag">{ENTRY_TYPE[thesis.entry_type] ?? thesis.entry_type}</span> : null}{ThesisTags && <ThesisTags {...slot} />}</>}
      controls={<button className="btn sm" onClick={() => onThesis(pos, thesis)}>{thesis ? "Edytuj" : "Dodaj"}</button>} body="tight"
      footer={thesis ? <FootFacts items={[thesis.created_at && `z ${dmy(thesis.created_at)}`, thesis.reviewed_at && <>przegląd tezy <b>{dm(thesis.reviewed_at)}</b></>]} /> : undefined}>
      {thesis ? (
        <div className="tz">
          {thesis.thesis && <p><b>Wejście</b>{thesis.thesis}{chip("entry")}</p>}
          {thesis.invalidation && <p><b>Unieważnienie</b>{thesis.invalidation}{chip("invalidation")}</p>}
          {thesis.exit_plan && <p><b>Plan wyjścia</b>{thesis.exit_plan}{chip("exit")}</p>}
          {thesis.size_plan && <p><b>Wielkość i dokupienia</b>{thesis.size_plan}{chip("size")}</p>}
        </div>
      ) : <div className="muted" style={{ fontSize: 13 }}>Brak tezy. Zapisz, dlaczego to masz i kiedy wyjdziesz: teza pokaże się obok sygnałów.</div>}
    </Widget>
  );

  const alertsW = (
    <Widget title={`Alerty dla ${inst?.symbol ?? name}`} count={live.length || undefined} controls={<button className="btn sm" onClick={onNewAlert}>+ Nowy</button>} body="tight"
      footer={<><span>ostatnio wyzwolony: <b>{lastTrig ? dm(lastTrig) : "brak"}</b></span>
        <span className="spacer" /><button className="lnk" onClick={onAlerts}>wszystkie alerty</button></>}>
      {!live.length ? <div className="muted" style={{ fontSize: 13 }}>Brak alertów dla tego aktywa.</div>
        : live.map((a) => <AlertRow key={a.id} a={a} compact onRemove={a.source === "agent" ? () => removeAlert(a) : undefined} />)}
    </Widget>
  );

  const lotsW = pos && (
    <Widget title="Loty" tags={<span className="tag">FIFO{acc ? ` · ${accountLabel(acc, accounts)}` : ""}</span>}
      controls={<button className="btn sm" onClick={() => onTxns(pos)}>Transakcje{detail.data ? ` (${detail.data.transactions.length})` : ""}</button>} body="flush tight"
      footer={<><FootFacts items={[<>dywidendy <b>{dividends.length ? dividends.map(([k, v]) => money(v, k)).join(", ") : money(0, c)}</b></>, <>opłaty <b>{money(fees, c)}</b></>]} />
        <span className="spacer" /><button className="lnk" onClick={onAddTxn}>+ transakcja</button></>}>
      <LotsTable p={pos} accounts={accounts} />
    </Widget>
  );

  const research = Research ? <Research {...slot} /> : null;
  const timelineW = (
    <Widget title="Sygnały i decyzje" id={`asset-signals-${id}`} className={research ? "s2" : undefined} controls={<button className="lnk" onClick={onJournal}>dziennik</button>} body="tight">
      {undecided.map((s) => (
        <SignalItem key={s.id} s={s} ctx={ctx} thesis={null} open={decideOpen === s.id} cursor={false} primary={false} onToggle={(v) => setDecideOpen(v ? s.id : null)} />
      ))}
      {!timeline.length ? <div className="muted" style={{ fontSize: 13 }}>Brak sygnałów i decyzji.</div> : (
        <div className="tl wide" style={{ marginTop: undecided.length ? 8 : 0 }}>
          {timeline.map((e, k) => (
            <div key={k} style={{ display: "contents" }}>
              <div className="d">{e.at.slice(0, 4) === yearNow ? dm(e.at) : `${dm(e.at)}.${e.at.slice(2, 4)}`}</div>
              <div className="m"><i className={e.dot} aria-hidden /></div>
              <div className="t"><b>{e.head}</b>{e.main ? ` · ${e.main}` : ""}{e.tail && <span> · {e.tail}</span>}
                {e.signal && <> · <button className="lnk" onClick={() => setDecideOpen(e.signal)}>decyzja</button></>}
                {e.action && <> · <button className="lnk" onClick={e.action.onClick}>{e.action.label}</button></>}</div>
            </div>
          ))}
        </div>
      )}
    </Widget>
  );

  // Two columns (research.css .g2): the left stack (Teza, Alerty, Loty) next to the research slot; without
  // a research section the timeline takes the right column so no cell stays empty.
  return (
    <div className="g2 asset">
      {head}
      {priceChart}
      <div className="stack">{thesisW}{alertsW}{lotsW}</div>
      {research ?? timelineW}
      {research && timelineW}
    </div>
  );
}

function LotsTable({ p, accounts }: { p: Position; accounts: AccountRow[] }) {
  const lots = [...p.lots].sort((a, b) => a.open_date.localeCompare(b.open_date));
  const sumQ = lots.reduce((s, l) => s + l.quantity, 0);
  const sumCost = lots.reduce((s, l) => s + l.quantity * (l.unit_cost ?? 0), 0);
  const sumRes = lots.reduce((s, l) => s + (l.result ?? 0), 0);
  const multi = new Set(lots.map((l) => l.account_id)).size > 1;
  if (!lots.length) return <div className="empty">Brak otwartych lotów.</div>;
  return (
    <table>
      <thead><tr><th>Data</th><th className="num">Ilość</th><th className="num">Cena</th><th className="num">Wynik</th><th className="num">Wynik %</th></tr></thead>
      <tbody>
        {lots.map((l, k) => {
          const cost = l.quantity * (l.unit_cost ?? 0);
          const r = l.result != null && cost ? l.result / cost : null;
          const a = accounts.find((x) => x.id === l.account_id);
          return (
            <tr key={k}>
              <td className="tnum">{l.open_date}{multi && a && <span className="sym">{accountLabel(a, accounts)}</span>}</td>
              <td className="num">{qty(l.quantity)}</td>
              <td className="num">{l.unit_cost != null ? money(l.unit_cost, l.currency) : "-"}</td>
              <td className={`num ${(l.result ?? 0) >= 0 ? "pos" : "neg"}`}>{money0(l.result, l.currency, true)}</td>
              <td className={`num ${(r ?? 0) >= 0 ? "pos" : "neg"}`}>{pct(r, true)}</td>
            </tr>
          );
        })}
        <tr className="sum"><td>razem</td><td className="num">{qty(sumQ)}</td><td className="num">{sumQ ? money(sumCost / sumQ, lots[0].currency) : "-"}</td>
          <td className="num">{money0(sumRes, lots[0].currency, true)}</td><td className="num">{pct(sumCost ? sumRes / sumCost : null, true)}</td></tr>
      </tbody>
    </table>
  );
}
