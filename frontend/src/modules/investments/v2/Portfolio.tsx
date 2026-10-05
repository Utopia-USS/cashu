// Portfolio widgets of the investments home v2: Aktywa (compact asset list with 30-day sparklines, weekly
// change, weight bars, polarity flags and an alert ring; F-09), Alokacja (donut with 2 px gaps + rows, drift
// coloured only out of band; F-10) and Rachunki (accounts with snapshot facts; data warnings in the footer).
import { Fragment, useMemo, useState } from "react";
import { Donut, Spark } from "../../../charts";
import { Drawer, Pop, Seg, Tag } from "../../../ui";
import { FootFacts, Widget } from "../../../widgets";
import type { AccountRow, Allocation, Instrument, Overview, StrategyStatus } from "../api";
import {
  accountLabel, assetClass, bucketColor, bucketLabel, dm, money, money0, nAccountsInv, nBuckets, nInstruments, pct, pctTarget, plural, pp, region,
} from "../labels";
import { ClassifyCard, WarningsCard } from "../Rail";
import { warningItems } from "../logic";
import type { Alert, PositionV2, PositionsV2, SignalV2 } from "./api";
import { instName, isDecided, polarityOf, weekChange } from "./logic";

type Sort = "value" | "result" | "week";

export function AssetList({ data, accounts, signals, alerts, strategy, onOpen, onAddTxn, onClassify }: {
  data: PositionsV2;
  accounts: AccountRow[];
  signals: SignalV2[];
  alerts: Alert[];
  strategy: StrategyStatus | null;
  onOpen: (instrumentId: number | string) => void;
  onAddTxn: () => void;
  onClassify: (i: Instrument, patch: { asset_class: string; region: string | null; valuation_mode: string; tags: string[] }) => Promise<void>;
}) {
  const [split, setSplit] = useState<"total" | "account">("total");
  const [sort, setSort] = useState<Sort>("value");
  const [classify, setClassify] = useState<string | null>(null);
  const c = data.base_currency;
  const rows = useMemo(() => {
    const key = (p: PositionV2) => (sort === "value" ? p.value ?? 0 : sort === "result" ? p.unrealized_pct ?? -Infinity : weekChange(p.closes_30d) ?? -Infinity);
    return [...data.positions].sort((a, b) => key(b) - key(a));
  }, [data.positions, sort]);
  const used = new Set(data.positions.flatMap((p) => p.accounts.map((a) => a.account_id)));
  const cash = data.cash.reduce((s, x) => s + (x.amount_base ?? 0), 0);
  const cashAccounts = data.cash.filter((x) => x.amount !== 0).length;
  const maxW = Math.max(0.0001, ...data.positions.map((p) => p.weight ?? 0), data.total ? cash / data.total : 0);
  const accLabel = (id: number) => { const a = accounts.find((x) => x.id === id); return a ? accountLabel(a, accounts) : `rachunek ${id}`; };
  const flags = (id: string) => {
    const open = signals.filter((s) => String(s.instrument_id) === id && !isDecided(s) && !s.snoozed);
    const pols = [...new Set(open.map((s) => polarityOf(s)))];
    const ring = alerts.some((a) => String(a.instrument_id) === id && (a.status === "active" || a.status === "triggered"));
    return (
      <>
        {pols.map((p) => <span key={p} className={`flag ${p === "positive" ? "pos" : p === "negative" ? "neg" : "neu"}`} title={p === "positive" ? "szansa" : p === "negative" ? "ryzyko" : "sygnał"} aria-label={p === "positive" ? "szansa" : p === "negative" ? "ryzyko" : "sygnał"} />)}
        {ring && <span className="flag al" title="alert" aria-label="alert" />}
      </>
    );
  };
  const weightCell = (w: number | null) => (
    <td className="wcell"><span className="wbar" aria-hidden><i style={{ width: `${Math.round(((w ?? 0) / maxW) * 100)}%` }} /></span>{pct(w)}</td>
  );
  const resultCls = (v: number | null) => (v == null ? "" : v >= 0 ? "pos" : "neg");
  return (
    <Widget title="Aktywa" id="inv-assets" count={`${nInstruments(data.positions.length)} · ${nAccountsInv(used.size)}`}
      controls={
        <>
          <Seg quiet label="Podział" value={split} onChange={setSplit} items={[["Razem", "total"], ["Per rachunek", "account"]]} />
          <select value={sort} onChange={(e) => setSort(e.target.value as Sort)} aria-label="Sortowanie">
            <option value="value">sortuj: wartość</option>
            <option value="result">sortuj: wynik %</option>
            <option value="week">sortuj: tydzień</option>
          </select>
        </>
      }
      body="flush tight"
      footer={<><span>ceny zamknięcia · wynik od kosztu (FIFO)</span><span className="spacer" /><button className="lnk" onClick={onAddTxn}>+ transakcja</button></>}>
      <div className="scroll">
        <table>
          <thead>
            <tr><th>Instrument</th><th>30 dni</th><th className="num">Cena</th><th className="num">tydz.</th><th>Udział</th><th className="num">Wartość</th><th className="num">Wynik</th><th className="num">Wynik %</th></tr>
          </thead>
          <tbody>
            {rows.map((p) => {
              const id = String(p.instrument.id);
              const i = p.instrument;
              const wk = weekChange(p.closes_30d);
              const cost = p.valuation_mode === "cost";
              const sym = [instName(i) !== i.symbol ? i.symbol : null, i.mic, p.bucket ? bucketLabel(p.bucket) : i.needs_classification ? null : assetClass(i.asset_class)].filter(Boolean).join(" · ");
              const parts = split === "account" && p.accounts.length > 1 ? p.accounts : null;
              return (
                <Fragment key={id}>
                  <tr className="rowlink" onClick={(e) => { if (!(e.target as HTMLElement).closest("button, a, input, select, .pop")) onOpen(i.id); }}>
                    <td>
                      <span className="nm">
                        <button className="nm" onClick={() => onOpen(i.id)}>{instName(i)}</button>
                        {cost && <> <Tag>koszt + odsetki</Tag></>}
                        {flags(id)}
                        {i.needs_classification && (
                          <span className="menu-anchor" style={{ display: "inline-block", marginLeft: 6 }}>
                            <button className="tag warn" style={{ background: "transparent", cursor: "pointer", font: "inherit", fontSize: 11 }} aria-expanded={classify === id}
                              onClick={() => setClassify(classify === id ? null : id)}>sklasyfikuj</button>
                            <Pop open={classify === id} onClose={() => setClassify(null)} width={460} label="Klasyfikacja">
                              <ClassifyCard items={[i]} positions={data.positions} strategy={strategy} accounts={accounts} highlight={false} focusId={id}
                                onSave={async (inst, patch) => { await onClassify(inst, patch); setClassify(null); }} />
                            </Pop>
                          </span>
                        )}
                      </span>
                      <span className="sym">{split === "account" && p.accounts.length === 1 ? `${sym} · ${accLabel(p.accounts[0].account_id)}` : sym || assetClass(i.asset_class)}</span>
                    </td>
                    <td><Spark values={(p.closes_30d ?? []).map((x) => x.close)} tone={cost ? "" : undefined} label={`${i.label}: 30 dni`} /></td>
                    <td className="num">{p.price != null ? money(p.price, p.price_currency ?? c) : "-"}{p.is_stale && <> <span className="tag warn">{dm(p.price_date)}</span></>}</td>
                    <td className={`num ${cost || wk == null ? "muted" : wk >= 0 ? "pos" : "neg"}`}>{wk != null ? pct(wk, true) : "-"}</td>
                    {weightCell(p.weight)}
                    <td className="num">{money(p.value, c)}</td>
                    <td className={`num ${resultCls(p.unrealized)}`}>{money0(p.unrealized, c, true)}</td>
                    <td className={`num ${resultCls(p.unrealized_pct)}`}>{pct(p.unrealized_pct, true)}</td>
                  </tr>
                  {parts?.map((a) => (
                    <tr key={`${id}:${a.account_id}`} className="sum">
                      <td style={{ paddingLeft: 28 }}>{accLabel(a.account_id)}</td><td /><td /><td />
                      {weightCell(a.weight)}
                      <td className="num">{money(a.value, c)}</td>
                      <td className="num" /><td className={`num ${resultCls(a.unrealized_pct)}`}>{pct(a.unrealized_pct, true)}</td>
                    </tr>
                  ))}
                </Fragment>
              );
            })}
            {!rows.length && <tr><td colSpan={8} className="muted">Brak otwartych pozycji.</td></tr>}
            {data.cash.length > 0 && (
              <tr className="sum">
                <td>Gotówka · {nAccountsInv(cashAccounts)}</td><td /><td /><td />
                {weightCell(data.total ? cash / data.total : null)}
                <td className="num">{money(cash, c)}</td><td /><td />
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </Widget>
  );
}

// ---- allocation ----------------------------------------------------------------------------------------------

type AllocView = "buckets" | "classes" | "regions";

export function AllocationWidget({ alloc, strategy, filtered }: { alloc: Allocation; strategy: StrategyStatus | null; filtered: boolean }) {
  const [view, setView] = useState<AllocView>(alloc.has_strategy && alloc.buckets.length ? "buckets" : "classes");
  const order = alloc.buckets.map((b) => b.bucket_id);
  const out = alloc.buckets.filter((b) => b.out_of_band).length;
  const band = alloc.band?.absolute_band_pp ?? null;
  const rows = view === "buckets"
    ? [
      ...alloc.buckets.map((b) => ({ key: b.bucket_id, name: bucketLabel(b.bucket_id), color: bucketColor(b.bucket_id, order), w: b.weight, target: b.target as number | null, drift: b.drift_pp as number | null, out: !!b.out_of_band, value: b.value })),
      ...(alloc.unclassified && alloc.unclassified.value ? [{ key: "_none", name: "Bez koszyka", color: "var(--inv-other)", w: alloc.unclassified.weight, target: null, drift: null, out: false, value: alloc.unclassified.value }] : []),
    ]
    : (view === "classes" ? alloc.by_asset_class : alloc.by_region).map((s, k) => ({
      key: s.key, name: view === "classes" ? (s.key === "cash" ? "gotówka" : assetClass(s.key)) : region(s.key), color: `var(${["--inv-global", "--inv-pl", "--inv-bonds", "--inv-cash", "--inv-5", "--inv-6", "--inv-7", "--inv-other"][k % 8]})`,
      w: s.weight, target: null, drift: null, out: false, value: s.value,
    }));
  const worst = alloc.buckets.filter((b) => b.out_of_band).sort((a, b) => Math.abs(b.to_target) - Math.abs(a.to_target))[0];
  const totalK = alloc.total >= 1000 ? `${Math.round(alloc.total / 1000).toLocaleString("pl-PL")} tys.` : money0(alloc.total, alloc.base_currency);
  return (
    <Widget title="Alokacja" id="inv-alloc"
      tags={view === "buckets" && alloc.buckets.length ? (out ? <span className="tag warn">{out === 1 ? "1 poza pasmem" : `${out} poza pasmem`}</span> : <span className="tag pos">w paśmie</span>) : undefined}
      controls={<Seg quiet label="Podział alokacji" value={view} onChange={setView} items={[...(alloc.buckets.length ? [["Koszyki", "buckets"] as [string, AllocView]] : []), ["Klasy", "classes"], ["Regiony", "regions"]]} />}
      footer={view === "buckets" && alloc.buckets.length ? (
        <>
          <FootFacts items={[band != null && `pasmo ±${band} pp`, worst && <>do celu: <b>{money0(worst.to_target, alloc.base_currency, true)}</b> {bucketLabel(worst.bucket_id)}</>, filtered && "cel dotyczy całego portfela"]} />
          <span className="spacer" />{strategy?.version != null && <span>v{strategy.version}</span>}
        </>
      ) : <span>{alloc.has_strategy ? "udziały w wartości portfela" : "bez strategii: koszyki i cele po zapisaniu strategy.yaml"}</span>}>
      {!rows.length ? <div className="empty">Brak pozycji do podziału.</div> : (
        <div className="alloc">
          <Donut size={112} label={`Alokacja: ${rows.map((r) => `${r.name} ${pct(r.w)}`).join(", ")}`} segments={rows.map((r) => ({ value: Math.max(0, r.value), color: r.color }))}>
            <b>{totalK}</b><span>{view === "buckets" ? nBuckets(alloc.buckets.length) : plural(rows.length, "pozycja", "pozycje", "pozycji")}</span>
          </Donut>
          <div>
            <div className="arow head"><span /><span>{view === "buckets" ? "koszyk" : view === "classes" ? "klasa" : "region"}</span><span className="num">teraz</span><span className="num">{view === "buckets" ? "cel" : ""}</span><span className="num">{view === "buckets" ? "dryf" : ""}</span></div>
            {rows.map((r) => (
              <div className="arow" key={r.key}>
                <span className="sw" style={{ background: r.color }} />
                <span className="n" title={r.name}>{r.name}</span>
                <span className="num">{pct(r.w)}</span>
                <span className="num muted">{r.target != null ? pctTarget(r.target) : ""}</span>
                <span className={`num ${r.out ? "warn" : ""}`}>{r.drift != null ? pp(r.drift) : ""}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </Widget>
  );
}

// ---- accounts ------------------------------------------------------------------------------------------------

export function AccountsWidget({ overview, strategy, onAdd, onReconcile, onAlias, onSettings, today }: {
  overview: Overview;
  strategy: StrategyStatus | null;
  onAdd: () => void;
  onReconcile: (accountId: number | null) => void;
  onAlias: (instrumentId: string, yahoo: string) => Promise<void>;
  onSettings: () => void;
  today: string;
}) {
  const [open, setOpen] = useState(false);
  const accounts = overview.accounts;
  const c = overview.base_currency;
  const fr = overview.freshness;
  const labels = new Map<string, string>(fr.prices.stale.map((s) => [String(s.instrument_id), s.label]));
  const warnings = warningItems({ warnings: overview.warnings, labels, accounts, stale: fr.prices.stale, missingFx: fr.fx.missing, today });
  const inactive = strategy?.inactive_rules ?? [];
  const sub = (a: AccountRow): [string, boolean] => {
    const age = a.snapshot_date ? Math.round((Date.parse(today) - Date.parse(a.snapshot_date)) / 86400000) : null;
    const imp = a.last_import ? `import ${dm(a.last_import.at)}` : "bez importu";
    if (!a.snapshot_date) return [`bez snapshotu · ${imp}`, false];
    if (age != null && age > 14 && a.last_import) return [`snapshot ${dm(a.snapshot_date)} · uzgodnij`, true];
    return [`snapshot ${dm(a.snapshot_date)} · ${imp}`, false];
  };
  return (
    <Widget title="Rachunki" id="inv-accounts" controls={<button className="btn sm" onClick={onAdd}>+ Rachunek</button>} body="flush tight"
      footer={
        <>
          {fr.fx.newest_rate && <span>NBP {dm(fr.fx.newest_rate)}</span>}
          {fr.prices.stale.slice(0, 2).map((s) => <span key={s.instrument_id} className="warn">{s.label}: cena z {dm(s.price_date)}</span>)}
          {inactive.slice(0, 1).map((r) => (
            <span key={r.index} className="warn">reguła {r.rule_id ?? `#${r.index + 1}`} nieaktywna · <button className="lnk" style={{ fontSize: 12 }} onClick={onSettings}>napraw w Ustawieniach</button></span>
          ))}
          {strategy?.state === "invalid" && <span className="warn">błąd w strategii · <button className="lnk" style={{ fontSize: 12 }} onClick={onSettings}>Ustawienia</button></span>}
          {warnings.length > 0 && <><span className="spacer" /><button className="lnk" onClick={() => setOpen(true)}>ostrzeżenia danych ({warnings.length})</button></>}
        </>
      }>
      {!accounts.length ? <div className="empty">Brak rachunków maklerskich.</div> : (
        <table>
          <tbody>
            {accounts.map((a) => {
              const [text, warn] = sub(a);
              return (
                <tr key={a.id}>
                  <td><span className="nm">{accountLabel(a, accounts)}</span>
                    <span className={`sym ${warn ? "warn" : ""}`}>{warn ? <button className="lnk" style={{ fontSize: 11.5, color: "var(--warn)" }} onClick={() => onReconcile(a.id)}>{text}</button> : text}</span></td>
                  <td className="num">{a.value != null ? money0(a.value, c) : "-"}</td>
                  <td className="num muted">{a.share != null ? pct(a.share) : ""}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      <Drawer open={open} title="Ostrzeżenia danych" onClose={() => setOpen(false)} width={520}>
        <WarningsCard items={warnings} highlight={false} aliasHints={new Map()} onAlias={onAlias}
          onAction={(w) => { setOpen(false); onReconcile(w.key.startsWith("snap:") ? Number(w.key.slice(5)) : null); }} />
      </Drawer>
    </Widget>
  );
}
