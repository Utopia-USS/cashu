// Portfolio widgets of the investments home (home v3: design/v3/home-v3/home-v3.md 3-4): Aktywa with the tabs
// `Portfel | Obserwowane` (30-day sparklines, weekly change, weight bars, one signal glyph per instrument and the
// quiet bell / page markers; default sort by Wynik %), Alokacja with four views `Koszyki | Klasy | Regiony |
// Rachunki` (donut with 2 px gaps + rows, drift coloured only out of band, no footer; the data warnings behind
// `ostrzeżenia (n)` on Rachunki). The light grid keeps a small Rachunki widget over the same rows.
import { Fragment, useMemo, useState } from "react";
import { Donut, Spark } from "../../../charts";
import { Drawer, Pop, Seg } from "../../../ui";
import { FootFacts, Mark, Widget } from "../../../widgets";
import type { AccountRow, Instrument, Overview, StrategyStatus } from "../api";
import { accountLabel, assetClass, bucketColor, bucketLabel, dm, money, money0, nAccountsInv, nBuckets, pct, pctTarget, plural, pp, region } from "../labels";
import { ClassifyCard, WarningsCard } from "../Rail";
import { warningItems } from "../logic";
import type { Alert, PositionV2, PositionsV2, SignalV2, WatchItem } from "./api";
import { ClassifyButton, InstLabel } from "./InstLabel";
import { HintChip, mainHint } from "./hints";
import { accountSnapshot, alertFact, allocGeneric, instName, rowFlags, ruleKindLabel, STATE_LABEL, subLine, weekChange } from "./logic";
import { WatchTable } from "./Watchlist";

const FLAG_CLS: Record<string, string> = { positive: "pos", negative: "neg", neutral: "neu", mixed: "mix" };
const notesTitle = (n: number) => plural(n, "nowa notatka", "nowe notatki", "nowych notatek");

/** The markers after an instrument's name (home v3 Q4 / Q10 / Q14): one signal glyph, the bell, the page. */
export function RowMarks({ id, signals, alerts, unread }: { id: number | string; signals: SignalV2[]; alerts: Alert[]; unread: number }) {
  const f = rowFlags(id, signals, alerts, unread);
  return (
    <>
      {f.state && <span role="img" className={`flag ${FLAG_CLS[f.state]}`} title={STATE_LABEL[f.state]} aria-label={STATE_LABEL[f.state]} />}
      {f.alert && <Mark kind="alert" title={alertFact(f.alert)} />}
      {f.notes > 0 && <Mark kind="notes" title={notesTitle(f.notes)} />}
    </>
  );
}

type Sort = "value" | "result" | "week";

export type AssetsTab = "positions" | "watch";

export function AssetList({ data, accounts, signals, alerts, strategy, onOpen, onAddTxn, onClassify, slug, watch, initialTab, autoAdd, onWatchChanged, unread }: {
  data: PositionsV2;
  accounts: AccountRow[];
  signals: SignalV2[];
  alerts: Alert[];
  strategy: StrategyStatus | null;
  onOpen: (instrumentId: number | string) => void;
  onAddTxn: () => void;
  onClassify: (i: Instrument, patch: { asset_class: string; region: string | null; valuation_mode: string; tags: string[] }) => Promise<void>;
  slug: string;
  /** The watchlist (null while loading): the `Obserwowane` tab. */
  watch: WatchItem[] | null;
  initialTab?: AssetsTab;
  /** Open the add row on the Obserwowane tab (the minimal view's "obserwuj instrument"). */
  autoAdd?: boolean;
  onWatchChanged: () => void;
  /** Unread research notes of an instrument (the page marker). */
  unread: (instrumentId: number | string) => number;
}) {
  const [tab, setTab] = useState<AssetsTab>(initialTab ?? "positions");
  const [adding, setAdding] = useState(!!autoAdd);
  const [split, setSplit] = useState<"total" | "account">("total");
  const [sort, setSort] = useState<Sort>("result");
  const [classify, setClassify] = useState<string | null>(null);
  const c = data.base_currency;
  const rows = useMemo(() => {
    const key = (p: PositionV2) => (sort === "value" ? p.value ?? 0 : sort === "result" ? p.unrealized_pct ?? -Infinity : weekChange(p.closes_30d) ?? -Infinity);
    return [...data.positions].sort((a, b) => key(b) - key(a));
  }, [data.positions, sort]);
  const cash = data.cash.reduce((s, x) => s + (x.amount_base ?? 0), 0);
  const cashAccounts = data.cash.filter((x) => x.amount !== 0).length;
  const maxW = Math.max(0.0001, ...data.positions.map((p) => p.weight ?? 0), data.total ? cash / data.total : 0);
  const accLabel = (id: number) => { const a = accounts.find((x) => x.id === id); return a ? accountLabel(a, accounts) : `rachunek ${id}`; };
  const marks = (id: number | string) => <RowMarks id={id} signals={signals} alerts={alerts} unread={unread(id)} />;
  const weightCell = (w: number | null) => (
    <td className="wcell"><span className="wbar" aria-hidden><i style={{ width: `${Math.round(((w ?? 0) / maxW) * 100)}%` }} /></span>{pct(w)}</td>
  );
  const resultCls = (v: number | null) => (v == null ? "" : v >= 0 ? "pos" : "neg");
  const watchList = watch ?? [];
  const watchAlerts = watchList.reduce((a, w) => a + w.alerts.live, 0);
  const tabs = (
    <Seg<AssetsTab> quiet label="Zakres" value={tab} onChange={setTab}
      items={[[`Portfel ${data.positions.length}`, "positions"], [`Obserwowane ${watchList.length}`, "watch"]]} />
  );
  return (
    <Widget title="Aktywa" id="inv-assets" tags={tabs}
      controls={tab === "positions" ? (
        <>
          <Seg quiet label="Podział" value={split} onChange={setSplit} items={[["Razem", "total"], ["Per rachunek", "account"]]} />
          <select value={sort} onChange={(e) => setSort(e.target.value as Sort)} aria-label="Sortowanie">
            <option value="result">wynik %</option>
            <option value="value">wartość</option>
            <option value="week">tydzień</option>
          </select>
        </>
      ) : <button className="btn sm" onClick={() => setAdding((v) => !v)} aria-expanded={adding}>+ Dodaj</button>}
      body="flush tight"
      footer={tab === "positions"
        ? <><span className="spacer" /><button className="lnk" onClick={onAddTxn}>+ transakcja</button></>
        : <><FootFacts items={[<><b>{watchAlerts}</b> {plural(watchAlerts, "alert", "alerty", "alertów").replace(/^\d+ /, "")}</>]} /><span className="spacer" /></>}>
      {tab === "watch" ? (
        <WatchTable slug={slug} items={watch} wide adding={adding} onAdding={setAdding} onChanged={onWatchChanged} onOpen={(id) => onOpen(id)}
          flags={(w) => marks(w.instrument_id)} />
      ) : (
        <div className="scroll">
          <table>
            <thead>
              <tr><th className="c-inst">Instrument</th><th className="c-hint">Strategia</th><th className="c-spark">30 dni</th><th className="num">Cena</th><th className="num">tydz.</th><th>Udział</th><th className="num">Wartość</th><th className="num c-abs" title="Od kosztu (FIFO), ceny zamknięcia">Wynik</th><th className="num">Wynik %</th></tr>
            </thead>
            <tbody>
              {rows.map((p) => {
                const id = String(p.instrument.id);
                const i = p.instrument;
                const wk = weekChange(p.closes_30d);
                const cost = p.valuation_mode === "cost";
                const parts = split === "account" && p.accounts.length > 1 ? p.accounts : null;
                const hint = mainHint(p.hints, true);
                return (
                  <Fragment key={id}>
                    <tr className="rowlink" onClick={(e) => { if (!(e.target as HTMLElement).closest("button, a, input, select, .pop")) onOpen(i.id); }}>
                      <td className="c-inst">
                        <InstLabel inst={i} onOpen={onOpen} accounts={p.accounts.map((a) => accLabel(a.account_id))} stale={p.is_stale ? p.price_date : null}
                          badges={marks(id)} sub={subLine({ cost, split, accounts: p.accounts, accLabel })} hints={p.hints}
                          action={i.needs_classification && (
                            <span className="menu-anchor">
                              <ClassifyButton name={instName(i)} expanded={classify === id} onClick={() => setClassify(classify === id ? null : id)} />
                              <Pop portal open={classify === id} onClose={() => setClassify(null)} width={460} label="Klasyfikacja">
                                <ClassifyCard items={[i]} positions={data.positions} strategy={strategy} accounts={accounts} highlight={false} focusId={id}
                                  onSave={async (inst, patch) => { await onClassify(inst, patch); setClassify(null); }} />
                              </Pop>
                            </span>
                          )} />
                      </td>
                      <td className="c-hint">{hint && <HintChip hint={hint} held />}</td>
                      <td className="c-spark"><Spark values={(p.closes_30d ?? []).map((x) => x.close)} tone={cost ? "" : undefined} label={`${i.label}: 30 dni`} /></td>
                      <td className="num">{p.price != null ? money(p.price, p.price_currency ?? c) : "-"}{p.is_stale && <> <span className="tag warn">{dm(p.price_date)}</span></>}</td>
                      <td className={`num ${cost || wk == null ? "muted" : wk >= 0 ? "pos" : "neg"}`}>{wk != null ? pct(wk, true) : "-"}</td>
                      {weightCell(p.weight)}
                      <td className="num">{money(p.value, c)}</td>
                      <td className={`num c-abs ${resultCls(p.unrealized)}`}>{money0(p.unrealized, c, true)}</td>
                      <td className={`num ${resultCls(p.unrealized_pct)}`}>{pct(p.unrealized_pct, true)}</td>
                    </tr>
                    {parts?.map((a) => (
                      <tr key={`${id}:${a.account_id}`} className="sum">
                        <td style={{ paddingLeft: 28 }}>{accLabel(a.account_id)}</td><td className="c-hint" /><td className="c-spark" /><td /><td />
                        {weightCell(a.weight)}
                        <td className="num">{money(a.value, c)}</td>
                        <td className="num c-abs" /><td className={`num ${resultCls(a.unrealized_pct)}`}>{pct(a.unrealized_pct, true)}</td>
                      </tr>
                    ))}
                  </Fragment>
                );
              })}
              {!rows.length && <tr><td colSpan={9} className="muted">Brak otwartych pozycji.</td></tr>}
              {data.cash.length > 0 && (
                <tr className="sum">
                  <td>Gotówka · {nAccountsInv(cashAccounts)}</td><td className="c-hint" /><td className="c-spark" /><td /><td />
                  {weightCell(data.total ? cash / data.total : null)}
                  <td className="num">{money(cash, c)}</td><td className="c-abs" /><td />
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </Widget>
  );
}

// ---- allocation ----------------------------------------------------------------------------------------------

export type AllocView = "buckets" | "classes" | "regions" | "accounts";
const PALETTE = ["--inv-global", "--inv-pl", "--inv-bonds", "--inv-cash", "--inv-5", "--inv-6", "--inv-7", "--inv-other"];
const totalK = (total: number, currency: string) => (total >= 1000 ? `${Math.round(total / 1000).toLocaleString("pl-PL")} tys.` : money0(total, currency));

/** The data warnings of the overview (stale prices, FX, snapshots, inactive rules, an invalid strategy): the
 * `ostrzeżenia (n)` link (its title lists the facts) and the drawer with the fixes. */
function DataWarnings({ overview, strategy, today, onReconcile, onAlias, onSettings }: {
  overview: Overview; strategy: StrategyStatus | null; today: string;
  onReconcile: (accountId: number | null) => void; onAlias: (instrumentId: string, yahoo: string) => Promise<void>; onSettings: () => void;
}) {
  const [open, setOpen] = useState(false);
  const fr = overview.freshness;
  const labels = new Map<string, string>(fr.prices.stale.map((s) => [String(s.instrument_id), s.label]));
  const warnings = warningItems({ warnings: overview.warnings, labels, accounts: overview.accounts, stale: fr.prices.stale, missingFx: fr.fx.missing, today });
  const inactive = strategy?.inactive_rules ?? [];
  const invalid = strategy?.state === "invalid";
  const n = warnings.length + (inactive.length ? 1 : 0) + (invalid ? 1 : 0);
  if (!n) return null;
  // Rule kinds, never the strategy's rule ids (FE-A A6).
  const title = [fr.fx.newest_rate ? `NBP ${dm(fr.fx.newest_rate)}` : null, ...fr.prices.stale.slice(0, 2).map((s) => `${s.label}: cena z ${dm(s.price_date)}`),
    inactive.length ? plural(inactive.length, "reguła nieaktywna", "reguły nieaktywne", "reguł nieaktywnych") : null, invalid ? "błąd w strategii" : null].filter(Boolean).join(" · ");
  return (
    <>
      <button className="lnk" title={title} onClick={() => setOpen(true)}>ostrzeżenia ({n})</button>
      <Drawer open={open} title="Ostrzeżenia danych" onClose={() => setOpen(false)} width={520}>
        {(inactive.length > 0 || invalid) && (
          <div className="muted" style={{ fontSize: 12.5, marginBottom: 10, display: "grid", gap: 4 }}>
            {inactive.length > 0 && <span className="warn" title={inactive.map((r) => ruleKindLabel(r.kind)).join(", ")}>{plural(inactive.length, "reguła nieaktywna", "reguły nieaktywne", "reguł nieaktywnych")} · <button className="lnk" style={{ fontSize: 12.5 }} onClick={() => { setOpen(false); onSettings(); }}>napraw w Ustawieniach</button></span>}
            {invalid && <span className="warn">błąd w strategii · <button className="lnk" style={{ fontSize: 12.5 }} onClick={() => { setOpen(false); onSettings(); }}>Ustawienia</button></span>}
          </div>
        )}
        {warnings.length > 0 && (
          <WarningsCard items={warnings} highlight={false} aliasHints={new Map()} onAlias={onAlias}
            onAction={(w) => { setOpen(false); onReconcile(w.key.startsWith("snap:") ? Number(w.key.slice(5)) : null); }} />
        )}
      </Drawer>
    </>
  );
}

/** The accounts as allocation rows (Alokacja `Rachunki`, the light grid's Rachunki widget): donut by account,
 * `rachunek | teraz | wartość | snapshot`; a stale snapshot reads `15.09 · uzgodnij` (the import drawer). */
export function AccountsRows({ overview, today, wide, onReconcile }: { overview: Overview; today: string; wide?: boolean; onReconcile: (accountId: number | null) => void }) {
  const accounts = overview.accounts;
  const c = overview.base_currency;
  if (!accounts.length) return <div className="empty">Brak rachunków maklerskich.</div>;
  const total = accounts.reduce((s, a) => s + Math.max(0, a.value ?? 0), 0);
  const rows = accounts.map((a, k) => ({ a, color: `var(${PALETTE[k % 8]})`, snap: accountSnapshot(a, today) }));
  return (
    <div className={`alloc ${wide ? "wide" : ""} acc`}>
      <Donut size={wide ? 128 : 112} label={`Rachunki: ${rows.map((r) => `${accountLabel(r.a, accounts)} ${pct(r.a.share ?? null)}`).join(", ")}`}
        segments={rows.map((r) => ({ value: Math.max(0, r.a.value ?? 0), color: r.color }))}>
        <b>{totalK(total, c)}</b><span>{nAccountsInv(accounts.length)}</span>
      </Donut>
      <div>
        <div className="arow head"><span /><span>rachunek</span><span className="num">teraz</span><span className="num">wartość</span><span className="num c-snap">snapshot</span></div>
        {rows.map(({ a, color, snap }) => (
          <div className="arow" key={a.id} title={snap.title}>
            <span className="sw" style={{ background: color }} />
            <span className="n">{accountLabel(a, accounts)}</span>
            <span className="num">{a.share != null ? pct(a.share) : ""}</span>
            <span className="num">{a.value != null ? money0(a.value, c) : "-"}</span>
            <span className="num c-snap snap">{snap.warn ? <button className="lnk" onClick={() => onReconcile(a.id)}>{snap.cell} · uzgodnij</button> : snap.cell}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function AllocationWidget({ overview, strategy, filtered, wide, today, view: chosenView, onView, onAdd, onReconcile, onAlias, onSettings }: {
  overview: Overview; strategy: StrategyStatus | null; filtered: boolean;
  /** At 2/3 of the grid: donut 128 px + koszyk | teraz | cel | dryf | wartość | do celu. */
  wide?: boolean;
  today: string;
  /** Controlled view; null = the default (Koszyki for a generic allocation with a strategy, else Klasy). */
  view: AllocView | null;
  onView: (v: AllocView) => void;
  onAdd: () => void;
  onReconcile: (accountId: number | null) => void;
  onAlias: (instrumentId: string, yahoo: string) => Promise<void>;
  onSettings: () => void;
}) {
  const alloc = overview.allocation;
  // F7-generic: targets, drift and `Koszyki` only for a generic allocation; the owner's own buckets stay with the
  // agent, the widget then offers Klasy / Regiony (default Klasy).
  const generic = allocGeneric(alloc);
  const chosen: AllocView = chosenView ?? (alloc.has_strategy && generic ? "buckets" : "classes");
  const view: AllocView = chosen === "buckets" && !generic ? "classes" : chosen;
  const order = alloc.buckets.map((b) => b.bucket_id);
  const out = alloc.buckets.filter((b) => b.out_of_band).length;
  const band = alloc.band?.absolute_band_pp ?? null;
  const bandTitle = band != null ? `pasmo ±${band} pp` : undefined;
  const rows = view === "buckets"
    ? [
      ...alloc.buckets.map((b) => ({ key: b.bucket_id, name: bucketLabel(b.bucket_id) ?? "", color: bucketColor(b.bucket_id, order), w: b.weight, target: b.target as number | null, drift: b.drift_pp as number | null, out: !!b.out_of_band, value: b.value, toTarget: b.to_target as number | null })),
      ...(alloc.unclassified && alloc.unclassified.value ? [{ key: "_none", name: "Bez koszyka", color: "var(--inv-other)", w: alloc.unclassified.weight, target: null, drift: null, out: false, value: alloc.unclassified.value, toTarget: null }] : []),
    ]
    : view === "accounts" ? [] : (view === "classes" ? alloc.by_asset_class : alloc.by_region).map((s, k) => ({
      key: s.key, name: view === "classes" ? (s.key === "cash" ? "gotówka" : assetClass(s.key)) : region(s.key), color: `var(${PALETTE[k % 8]})`,
      w: s.weight, target: null, drift: null, out: false, value: s.value, toTarget: null as number | null,
    }));
  const items: [string, AllocView][] = [...(generic ? [["Koszyki", "buckets"] as [string, AllocView]] : []), ["Klasy", "classes"], ["Regiony", "regions"], ["Rachunki", "accounts"]];
  return (
    <Widget title="Alokacja" id="inv-alloc"
      tags={view === "buckets" ? (out ? <span className="tag warn" title={bandTitle}>{out === 1 ? "1 poza pasmem" : `${out} poza pasmem`}</span> : <span className="tag pos" title={bandTitle}>w paśmie</span>) : undefined}
      controls={
        <>
          <Seg quiet label="Podział alokacji" value={view} onChange={onView} items={items} />
          {view === "accounts" && (
            <>
              <DataWarnings overview={overview} strategy={strategy} today={today} onReconcile={onReconcile} onAlias={onAlias} onSettings={onSettings} />
              <button className="btn sm" onClick={onAdd}>+ Rachunek</button>
            </>
          )}
        </>
      }>
      {view === "accounts" ? <AccountsRows overview={overview} today={today} wide={wide} onReconcile={onReconcile} /> : !rows.length ? <div className="empty">Brak pozycji.</div> : (
        <div className={`alloc ${wide ? "wide" : ""}`}>
          <Donut size={wide ? 128 : 112} label={`Alokacja: ${rows.map((r) => `${r.name} ${pct(r.w)}`).join(", ")}`} segments={rows.map((r) => ({ value: Math.max(0, r.value), color: r.color }))}>
            <b>{totalK(alloc.total, alloc.base_currency)}</b><span>{view === "buckets" ? nBuckets(alloc.buckets.length) : plural(rows.length, "pozycja", "pozycje", "pozycji")}</span>
          </Donut>
          <div>
            <div className="arow head"><span /><span>{view === "buckets" ? "koszyk" : view === "classes" ? "klasa" : "region"}</span><span className="num">teraz</span>
              <span className="num" title={view === "buckets" && filtered ? "cel dotyczy całego portfela" : undefined}>{view === "buckets" ? "cel" : ""}</span>
              <span className="num" title={view === "buckets" ? bandTitle : undefined}>{view === "buckets" ? "dryf" : ""}</span>
              {wide && <><span className="num c-val">wartość</span><span className="num c-to">{view === "buckets" ? "do celu" : ""}</span></>}</div>
            {rows.map((r) => (
              <div className="arow" key={r.key}>
                <span className="sw" style={{ background: r.color }} />
                <span className="n" title={r.name}>{r.name}</span>
                <span className="num">{pct(r.w)}</span>
                <span className="num muted">{r.target != null ? pctTarget(r.target) : ""}</span>
                <span className={`num ${r.out ? "warn" : ""}`}>{r.drift != null ? pp(r.drift) : ""}</span>
                {wide && <><span className="num c-val">{money0(r.value, alloc.base_currency)}</span><span className="num c-to">{r.toTarget != null ? money0(r.toTarget, alloc.base_currency, true) : ""}</span></>}
              </div>
            ))}
          </div>
        </div>
      )}
    </Widget>
  );
}

/** Rachunki on the light grid (a zero-start profile without an allocation widget): the same rows, the same
 * `ostrzeżenia (n)` control, no footer. */
export function AccountsWidget({ overview, strategy, onAdd, onReconcile, onAlias, onSettings, today }: {
  overview: Overview; strategy: StrategyStatus | null; onAdd: () => void; onReconcile: (accountId: number | null) => void;
  onAlias: (instrumentId: string, yahoo: string) => Promise<void>; onSettings: () => void; today: string;
}) {
  return (
    <Widget title="Rachunki" id="inv-accounts" body="tight"
      controls={<><DataWarnings overview={overview} strategy={strategy} today={today} onReconcile={onReconcile} onAlias={onAlias} onSettings={onSettings} />
        <button className="btn sm" onClick={onAdd}>+ Rachunek</button></>}>
      <AccountsRows overview={overview} today={today} onReconcile={onReconcile} />
    </Widget>
  );
}

