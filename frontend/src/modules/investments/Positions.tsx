// Pozycje: table with expandable rows (lots per account, thesis, 24-month price chart with rule
// thresholds), Razem / Per rachunek split, sorting, bucket filter from the allocation panel.
import { Fragment, useMemo, useState } from "react";
import { Line, LineChart, ReferenceDot, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { cssVar, dtFmt } from "../../format";
import { useAsync } from "../../hooks";
import { Seg, Skeleton, Tag } from "../../ui";
import {
  type AccountRow, type BucketRow, getPositionChart, getPositionDetail, type Position, type PositionChart, type Positions, type Signal,
} from "./api";
import { accountLabel, bucketLabel, dm, dmy, ENTRY_TYPE, money, nAccountsInv, nInstruments, pct, qty, txnType } from "./labels";
import { signalTitle } from "./logic";

type Sort = "value" | "result" | "drift";
type Split = "total" | "account";

export interface PositionsActions {
  onClassify: (instrumentId: number | string) => void;
  onAddTxn: (instrumentId: number | string | null) => void;
  onTxns: (p: Position) => void;
  onThesis: (p: Position, thesisId: number | null) => void;
  onDecisions: (p: Position) => void;
}

export function PositionsTable({ data, accounts, buckets, signals, hasStrategy, bucketFilter, onClearFilter, actions, slug, refreshKey }: {
  data: Positions;
  accounts: AccountRow[];
  buckets: BucketRow[];
  signals: Signal[];
  hasStrategy: boolean;
  bucketFilter: string | null;
  onClearFilter: () => void;
  actions: PositionsActions;
  slug: string;
  refreshKey: number;
}) {
  const [split, setSplit] = useState<Split>("total");
  const [sort, setSort] = useState<Sort>("value");
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const c = data.base_currency;
  const drift = new Map(buckets.map((b) => [b.bucket_id, b.drift_pp]));

  const rows = useMemo(() => {
    let list = data.positions;
    if (bucketFilter) list = list.filter((p) => (p.bucket ?? "") === bucketFilter);
    const key = (p: Position) => (sort === "value" ? p.value ?? 0 : sort === "result" ? p.unrealized_pct ?? -Infinity : Math.abs(drift.get(p.bucket ?? "") ?? 0) * 1e9 + (p.value ?? 0));
    return [...list].sort((a, b) => key(b) - key(a));
  }, [data.positions, bucketFilter, sort, buckets]); // eslint-disable-line react-hooks/exhaustive-deps

  const usedAccounts = new Set(data.positions.flatMap((p) => p.accounts.map((a) => a.account_id)));
  const cashBase = data.cash.reduce((s, x) => s + (x.amount_base ?? 0), 0);
  const cashAccounts = data.cash.filter((x) => x.amount !== 0).length;
  const toggle = (id: string) => setOpen((cur) => { const n = new Set(cur); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const accLabel = (id: number) => { const a = accounts.find((x) => x.id === id); return a ? accountLabel(a, accounts) : `rachunek ${id}`; };

  return (
    <section className="card chart-card positions" id="inv-positions">
      <div className="controls" style={{ marginBottom: 8 }}>
        <h2 style={{ margin: 0 }}>Pozycje</h2>
        <Tag>{nInstruments(data.positions.length)} · {nAccountsInv(usedAccounts.size)}</Tag>
        {bucketFilter && (
          <button className="tag info" style={{ cursor: "pointer", background: "transparent" }} onClick={onClearFilter} title="Usuń filtr">
            filtr: {bucketLabel(bucketFilter)} ✕
          </button>
        )}
        <span className="spacer" />
        <button className="btn" onClick={() => actions.onAddTxn(null)} title="Transakcja wpisana ręcznie (kupno, wpłata, dywidenda…)">Dodaj transakcję</button>
        <Seg<Split> items={[["Razem", "total"], ["Per rachunek", "account"]]} value={split} onChange={setSplit} />
        <select value={sort} onChange={(e) => setSort(e.target.value as Sort)} aria-label="Sortowanie pozycji">
          <option value="value">sortuj: wartość</option>
          <option value="result">sortuj: wynik %</option>
          <option value="drift">sortuj: dryf</option>
        </select>
      </div>
      <div className="scroll">
        <table>
          <thead>
            <tr>
              <th style={{ width: 22 }} aria-label="Rozwiń" />
              <th>Instrument</th><th>Koszyk</th><th className="num">Ilość</th><th className="num">Śr. koszt</th><th className="num">Cena · data</th>
              <th className="num">Wartość</th><th className="num">Udział</th><th className="num">Wynik</th><th className="num">Wynik %</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => {
              const id = String(p.instrument.id);
              const parts = split === "account" && p.accounts.length > 0 ? p.accounts.map((a) => ({ key: `${id}:${a.account_id}`, a })) : [{ key: id, a: null }];
              return parts.map(({ key, a }) => {
                const isOpen = open.has(key);
                return (
                  <Fragment key={key}>
                    <PositionRow p={p} part={a} accLabel={accLabel} open={isOpen} onToggle={() => toggle(key)} signals={signals}
                      hasStrategy={hasStrategy} onClassify={() => actions.onClassify(p.instrument.id)} currency={c} />
                    {isOpen && (
                      <tr className="detail">
                        <td colSpan={10}>
                          <PositionDetailView slug={slug} p={p} accountId={a?.account_id ?? null} accLabel={accLabel} actions={actions} refreshKey={refreshKey} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              });
            })}
            {!rows.length && (
              <tr><td colSpan={10} className="muted">{bucketFilter ? "Brak pozycji w tym koszyku." : "Brak otwartych pozycji."}</td></tr>
            )}
            {!bucketFilter && data.cash.length > 0 && (split === "total" ? (
              <tr>
                <td /><td className="muted">Gotówka <span className="sym">{nAccountsInv(cashAccounts)}</span></td><td><Tag>Gotówka</Tag></td>
                <td className="num" /><td className="num" /><td className="num" />
                <td className="num">{money(cashBase, c)}</td><td className="num">{pct(data.total ? cashBase / data.total : null)}</td><td className="num" /><td className="num" />
              </tr>
            ) : data.cash.filter((x) => x.amount !== 0).map((x) => (
              <tr key={`cash:${x.account_id}:${x.currency}`}>
                <td /><td className="muted">Gotówka <span className="sym">{accLabel(x.account_id)}{x.currency !== c ? ` · ${money(x.amount, x.currency)}` : ""}</span></td><td><Tag>Gotówka</Tag></td>
                <td className="num" /><td className="num" /><td className="num" />
                <td className="num">{money(x.amount_base, c)}</td><td className="num">{pct(data.total && x.amount_base != null ? x.amount_base / data.total : null)}</td><td className="num" /><td className="num" />
              </tr>
            )))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function avgCost(p: Position): { v: number | null; c: string } {
  const cur = new Set(p.accounts.map((a) => a.cost_currency));
  if (cur.size !== 1) return { v: null, c: p.price_currency ?? "PLN" };
  let q = 0, sum = 0;
  for (const a of p.accounts) { if (a.average_cost == null) return { v: null, c: [...cur][0] }; q += a.quantity; sum += a.average_cost * a.quantity; }
  return { v: q ? sum / q : null, c: [...cur][0] };
}

function PositionRow({ p, part, accLabel, open, onToggle, signals, hasStrategy, onClassify, currency }: {
  p: Position; part: Position["accounts"][number] | null; accLabel: (id: number) => string; open: boolean; onToggle: () => void;
  signals: Signal[]; hasStrategy: boolean; onClassify: () => void; currency: string;
}) {
  const i = p.instrument;
  const sym = [i.symbol && i.symbol !== i.name ? i.symbol : null, i.mic].filter(Boolean).join(" · ");
  const mine = signals.filter((s) => s.instrument_id != null && String(s.instrument_id) === String(i.id));
  const conc = mine.find((s) => s.kind === "position_concentration");
  const action = mine.find((s) => s.severity === "action" && s.kind !== "position_concentration");
  const unclassified = i.needs_classification || (hasStrategy && !p.bucket);
  const avg = part ? { v: part.average_cost, c: part.cost_currency } : avgCost(p);
  const value = part ? part.value : p.value;
  const result = part ? (part.value != null && part.cost != null ? part.value - part.cost : null) : p.unrealized;
  const resultPct = part ? part.unrealized_pct : p.unrealized_pct;
  const weight = part ? part.weight : p.weight;
  const quantity = part ? part.quantity : p.quantity;
  const nonMarket = p.valuation_mode !== "market";
  const tone = (v: number | null) => (v == null ? "" : v > 0 ? "pos" : v < 0 ? "neg" : "");
  return (
    <tr className={`exp clickable ${open ? "open" : ""}`} onClick={onToggle}>
      <td>
        <button className="chev" aria-expanded={open} aria-label={`${open ? "Zwiń" : "Rozwiń"} ${i.label}`} onClick={(e) => { e.stopPropagation(); onToggle(); }}>
          {open ? "▾" : "▸"}
        </button>
      </td>
      <td>
        {i.name} {sym && <span className="sym">{sym}</span>}
        {part && <span className="sym blk">{accLabel(part.account_id)}</span>}
        {!part && (i.isin || nonMarket || conc || action || unclassified) && (
          <span className="sym blk">
            {i.isin && <>{i.isin} </>}
            {p.valuation_mode === "cost" && <Tag>koszt + odsetki</Tag>}
            {p.valuation_mode === "manual" && <> <Tag>wycena ręczna</Tag></>}
            {conc && <> <Tag tone="warn">koncentracja {pct(Number(conc.payload.weight))}</Tag></>}
            {action && <> <Tag tone="neg">sygnał: {signalTitle(action).toLowerCase().replace(/ ≥.*$/, "")}</Tag></>}
            {unclassified && <> <Tag tone="warn">bez koszyka</Tag></>}
          </span>
        )}
      </td>
      <td>
        {unclassified
          ? <button className="lnk" style={{ fontSize: 12 }} onClick={(e) => { e.stopPropagation(); onClassify(); }}>sklasyfikuj</button>
          : p.bucket ? <Tag>{bucketLabel(p.bucket)}</Tag> : <span className="muted">-</span>}
      </td>
      <td className="num">{qty(quantity)}</td>
      <td className="num">{money(avg.v, avg.c)}</td>
      <td className="num">
        {money(p.price, p.price_currency ?? currency)}{" "}
        {nonMarket ? <span className="tag warn">wycena</span>
          : p.is_stale ? <span className="tag warn" title="Cena nieaktualna">{dm(p.price_date)}</span>
          : <span className="sym">{dm(p.price_date)}</span>}
      </td>
      <td className="num">{money(value, currency)}</td>
      <td className="num">{pct(weight)}</td>
      <td className={`num ${tone(result)}`}>{money(result, currency, true)}</td>
      <td className={`num ${tone(resultPct)}`}>{pct(resultPct, true)}</td>
    </tr>
  );
}

function PositionDetailView({ slug, p, accountId, accLabel, actions, refreshKey }: {
  slug: string; p: Position; accountId: number | null; accLabel: (id: number) => string; actions: PositionsActions; refreshKey: number;
}) {
  const id = p.instrument.id;
  const detail = useAsync(() => getPositionDetail(slug, id), [slug, id, refreshKey]);
  const chart = useAsync(() => getPositionChart(slug, id, 24), [slug, id, refreshKey]);
  const lots = p.lots.filter((l) => accountId == null || l.account_id === accountId);
  const byAcc = [...new Set(lots.map((l) => l.account_id))];
  const thesis = detail.data?.theses[detail.data.theses.length - 1] ?? null;
  const divs = Object.entries(p.dividends);
  const nTx = detail.data?.transactions.length;
  const nDec = detail.data?.decisions.length ?? 0;
  return (
    <div className="detail-grid">
      <div>
        <h4>Loty (FIFO) <Tag>{lots.length}{byAcc.length === 1 ? ` · ${accLabel(byAcc[0])}` : ""}</Tag></h4>
        <table>
          <thead><tr><th>Data</th><th className="num">Ilość</th><th className="num">Cena</th><th className="num">Wynik</th></tr></thead>
          <tbody>
            {byAcc.map((acc) => (
              <Fragment key={acc}>
                {byAcc.length > 1 && <tr className="lots-acc"><td colSpan={4}>{accLabel(acc)}</td></tr>}
                {lots.filter((l) => l.account_id === acc).map((l, k) => (
                  <tr key={k}>
                    <td>{l.open_date}</td>
                    <td className="num">{qty(l.quantity)}</td>
                    <td className="num">{l.unit_cost == null ? <span className="muted" title="Koszt nieznany">?</span> : money(l.unit_cost, l.currency)}</td>
                    <td className={`num ${l.result == null ? "" : l.result >= 0 ? "pos" : "neg"}`}>{money(l.result, l.currency, true)}</td>
                  </tr>
                ))}
              </Fragment>
            ))}
            <tr>
              <td className="muted" colSpan={2}>dywidendy łącznie</td>
              <td className="num muted" colSpan={2}>{divs.length ? divs.map(([cc, v]) => money(v, cc)).join(" · ") : money(0, p.price_currency ?? "PLN")}</td>
            </tr>
          </tbody>
        </table>
        <div className="controls" style={{ margin: "10px 0 0" }}>
          <button className="btn" onClick={() => actions.onTxns(p)}>Transakcje{nTx != null ? ` (${nTx})` : ""}</button>
          <button className="btn" onClick={() => actions.onAddTxn(id)}>Dodaj transakcję</button>
        </div>
      </div>
      <div>
        {detail.data == null ? (
          <><Skeleton w={90} h={12} /><Skeleton h={60} style={{ marginTop: 8 }} /></>
        ) : thesis ? (
          <>
            <h4>Teza <Tag>z {dmy(thesis.created_at)}</Tag>{thesis.entry_type && <Tag>{ENTRY_TYPE[thesis.entry_type] ?? thesis.entry_type}</Tag>}</h4>
            <div className="thesis">
              {thesis.thesis && <><b>Wejście:</b> {thesis.thesis}<br /></>}
              {thesis.invalidation && <><b>Unieważnienie:</b> {thesis.invalidation}<br /></>}
              {thesis.exit_plan && <><b>Plan wyjścia:</b> {thesis.exit_plan}<br /></>}
              {thesis.size_plan && <><b>Wielkość i dokupienia:</b> {thesis.size_plan}<br /></>}
              <b>Ostatni przegląd tezy:</b> {thesis.reviewed_at ? `${dmy(thesis.reviewed_at)} · bez zmian` : "jeszcze nie"}
            </div>
            <div className="controls" style={{ margin: "10px 0 0" }}>
              <button className="btn" onClick={() => actions.onThesis(p, thesis.id)}>Edytuj tezę</button>
              <button className="btn" onClick={() => actions.onDecisions(p)}>Decyzje ({nDec})</button>
            </div>
          </>
        ) : (
          <>
            <h4>Teza</h4>
            <div className="thesis">Brak tezy. Zapisz, dlaczego trzymasz tę pozycję, co by ją unieważniło i kiedy wyjdziesz.</div>
            <div className="controls" style={{ margin: "10px 0 0" }}>
              <button className="btn" onClick={() => actions.onThesis(p, null)}>Dodaj tezę</button>
              {nDec > 0 && <button className="btn" onClick={() => actions.onDecisions(p)}>Decyzje ({nDec})</button>}
            </div>
          </>
        )}
      </div>
      <div className="chart">
        <h4>Cena 24 mies. z progami reguł <Tag>{chart.data?.currency ?? p.price_currency ?? "PLN"}</Tag></h4>
        {chart.error ? <div className="muted" style={{ fontSize: 12.5 }}>Nie udało się pobrać notowań: {chart.error}</div>
          : !chart.data ? <Skeleton h={120} />
          : <MiniPrice chart={chart.data} valuationMode={p.valuation_mode} price={p.price} />}
      </div>
    </div>
  );
}

const tick = new Intl.DateTimeFormat("pl-PL", { month: "short", year: "2-digit" });

/** 120 px price line with the 52-week high, rule thresholds and the average cost as reference lines,
 * buy / sell markers on the line. */
export function MiniPrice({ chart, valuationMode, price }: { chart: PositionChart; valuationMode: string; price: number | null }) {
  const c = chart.currency;
  if (valuationMode !== "market" || chart.series.length < 2) {
    return (
      <div className="muted" style={{ fontSize: 12.5, minHeight: 60 }}>
        {valuationMode === "cost" ? "Wycena po koszcie + odsetki: instrument bez notowań rynkowych, progi cenowe nie dotyczą."
          : valuationMode === "manual" ? "Wycena ręczna: brak notowań rynkowych."
          : "Za mało notowań, żeby narysować wykres. Uruchom reguły, żeby pobrać ceny."}
      </div>
    );
  }
  const data = chart.series.map((p) => ({ t: new Date(`${p.date}T12:00:00`).getTime(), y: p.close }));
  const at = (date: string) => {
    const t = new Date(`${date}T12:00:00`).getTime();
    return data.find((d) => d.t >= t) ?? data[data.length - 1];
  };
  const cost = chart.cost?.average ?? null;
  const levels = [...data.map((d) => d.y), ...(chart.high_52w != null ? [chart.high_52w] : []), ...chart.thresholds.map((t) => t.y), ...(cost != null ? [cost] : [])];
  const lo = Math.min(...levels), hi = Math.max(...levels);
  const pad = (hi - lo) * 0.08 || hi * 0.05;
  const muted = cssVar("--muted"), warn = cssVar("--warn"), nw = cssVar("--nw"), pos = cssVar("--pos"), neg = cssVar("--neg");
  const label = (v: number, color: string, position: "right" | "insideTopLeft" = "right") =>
    ({ value: v.toLocaleString("pl-PL", { minimumFractionDigits: 2, maximumFractionDigits: 2 }), position, fill: color, fontSize: 10 });
  const last = data[data.length - 1];
  const years = [...new Set(data.map((d) => new Date(d.t).getFullYear()))];
  const ticks = [data[0].t, ...years.slice(1).map((y) => data.find((d) => new Date(d.t).getFullYear() === y && new Date(d.t).getMonth() >= new Date(data[0].t).getMonth())?.t).filter((x): x is number => x != null)];
  return (
    <>
      <div style={{ height: 120 }}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 6, right: 46, bottom: 0, left: 0 }}>
            <XAxis dataKey="t" type="number" scale="time" domain={["dataMin", "dataMax"]} ticks={ticks} tickFormatter={(ms: number) => tick.format(new Date(ms))}
              tick={{ fontSize: 10, fill: muted }} axisLine={false} tickLine={false} height={16} />
            <YAxis hide domain={[lo - pad, hi + pad]} />
            <Tooltip
              contentStyle={{ background: cssVar("--card"), border: `1px solid ${cssVar("--border")}`, borderRadius: 8, fontSize: 12 }}
              labelStyle={{ color: muted }}
              labelFormatter={(ms) => dtFmt.format(new Date(ms as number))}
              formatter={(v) => [money(v as number, c), "Cena"] as [string, string]}
            />
            {chart.high_52w != null && <ReferenceLine y={chart.high_52w} stroke={muted} strokeWidth={1} label={label(chart.high_52w, muted, "insideTopLeft")} ifOverflow="extendDomain" />}
            {chart.thresholds.map((t) => <ReferenceLine key={t.rule_id} y={t.y} stroke={warn} strokeDasharray="4 3" strokeWidth={1} label={label(t.y, warn)} ifOverflow="extendDomain" />)}
            {cost != null && <ReferenceLine y={cost} stroke={muted} strokeDasharray="1 3" strokeWidth={1} label={label(cost, muted)} ifOverflow="extendDomain" />}
            <Line type="monotone" dataKey="y" stroke={nw} strokeWidth={2} dot={false} isAnimationActive={false} />
            {chart.markers.map((m, k) => {
              const pt = at(m.date);
              return <ReferenceDot key={k} x={pt.t} y={m.price ?? pt.y} r={3.5} fill={m.type === "sell" ? neg : pos} stroke="none" ifOverflow="extendDomain" />;
            })}
            <ReferenceDot x={last.t} y={last.y} r={3} fill={nw} stroke="none" />
          </LineChart>
        </ResponsiveContainer>
      </div>
      <div className="chart-legend">
        <span><i className="price" />cena · teraz {money(price ?? last.y, c)}</span>
        {chart.high_52w != null && <span><i />szczyt 52 tyg.</span>}
        {chart.thresholds.map((t) => (
          <span key={t.rule_id}><i className="dash" />próg {t.kind === "gain_from_cost" ? "+" : "-"}{Math.round(t.threshold * 100)} % {t.basis === "cost" ? "od kosztu" : ""} ({t.rule_id})</span>
        ))}
        {cost != null && <span><i className="cost" />śr. koszt</span>}
        {chart.markers.some((m) => m.type !== "sell") && <span><i className="buy" />zakupy</span>}
        {chart.markers.some((m) => m.type === "sell") && <span><i className="sell" />sprzedaże</span>}
      </div>
    </>
  );
}

export { txnType };
