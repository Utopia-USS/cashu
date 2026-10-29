// Portfolio widgets of the investments home (home v3: design/v3/home-v3/home-v3.md 3-4): Aktywa with the tabs
// `Portfel | Obserwowane` (30-day sparklines, weekly change, weight bars, one signal glyph per instrument and the
// quiet bell / page markers; default sort by Wynik %), Alokacja with four views `Koszyki | Klasy | Regiony |
// Rachunki` (donut with 2 px gaps + rows, drift coloured only out of band, no footer; the data warnings behind
// `ostrzeżenia (n)` on Rachunki). The light grid keeps a small Rachunki widget over the same rows.
import { Fragment, useId, useMemo, useRef, useState } from "react";
import { Donut, Spark } from "../../../charts";
import { Drawer, Pop, Seg } from "../../../ui";
import { FootFacts, Mark, Widget } from "../../../widgets";
import { hideAmount } from "../../../incognito";
import type { AccountRow, Instrument, Overview, StrategyStatus } from "../api";
import { accountLabel, assetClass, bucketColor, bucketGenitive, bucketLabel, dm, money, money0, nAccountsInv, nBuckets, pct, pctTarget, pp, region } from "../labels";
import { ClassifyCard, WarningsCard } from "../Rail";
import { warningItems } from "../logic";
import type { Alert, PositionV2, PositionsV2, SignalV2, WatchItem } from "./api";
import { ClassifyButton, HoverCard, InstLabel, useHoverCard, useTouch } from "./InstLabel";
import { HintChip, mainHint } from "./hints";
import { accountSnapshot, alertFact, allocGeneric, instName, rowFlags, ruleKindLabel, STATE_LABEL, subLine, weekChange } from "./logic";
import { WatchTable } from "./Watchlist";
import { S } from "./Portfolio.strings.ts";

const FLAG_CLS: Record<string, string> = { positive: "pos", negative: "neg", neutral: "neu", mixed: "mix" };
const notesTitle = (n: number) => S.newNotes(n);

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
  const accLabel = (id: number) => { const a = accounts.find((x) => x.id === id); return a ? accountLabel(a, accounts) : S.account(id); };
  const marks = (id: number | string) => <RowMarks id={id} signals={signals} alerts={alerts} unread={unread(id)} />;
  const weightCell = (w: number | null) => (
    <td className="wcell"><span className="wbar" aria-hidden><i style={{ width: `${Math.round(((w ?? 0) / maxW) * 100)}%` }} /></span>{pct(w)}</td>
  );
  const resultCls = (v: number | null) => (v == null ? "" : v >= 0 ? "pos" : "neg");
  const watchList = watch ?? [];
  const watchAlerts = watchList.reduce((a, w) => a + w.alerts.live, 0);
  const tabs = (
    <Seg<AssetsTab> quiet label={S.scope} value={tab} onChange={setTab}
      items={[[S.tabPortfolio(data.positions.length), "positions"], [S.tabWatch(watchList.length), "watch"]]} />
  );
  return (
    <Widget title={S.assets} id="inv-assets" tags={tabs}
      controls={tab === "positions" ? (
        <>
          <Seg quiet label={S.split} value={split} onChange={setSplit} items={[[S.total, "total"], [S.perAccount, "account"]]} />
          <select value={sort} onChange={(e) => setSort(e.target.value as Sort)} aria-label={S.sorting}>
            <option value="result">{S.sortResult}</option>
            <option value="value">{S.sortValue}</option>
            <option value="week">{S.sortWeek}</option>
          </select>
        </>
      ) : <button className="btn sm" onClick={() => setAdding((v) => !v)} aria-expanded={adding}>{S.add}</button>}
      body="flush tight"
      footer={tab === "positions"
        ? <><span className="spacer" /><button className="lnk" onClick={onAddTxn}>{S.addTxn}</button></>
        : <><FootFacts items={[<><b>{watchAlerts}</b> {S.alertsWord(watchAlerts)}</>]} /><span className="spacer" /></>}>
      {tab === "watch" ? (
        <WatchTable slug={slug} items={watch} wide adding={adding} onAdding={setAdding} onChanged={onWatchChanged} onOpen={(id) => onOpen(id)}
          flags={(w) => marks(w.instrument_id)} />
      ) : (
        <div className="scroll">
          <table>
            <thead>
              <tr><th className="c-inst">Instrument</th><th className="c-hint">{S.colStrategy}</th><th className="c-spark">{S.col30d}</th><th className="num">{S.colPrice}</th><th className="num">{S.colWeek}</th><th>{S.colWeight}</th><th className="num">{S.colValue}</th><th className="num c-abs" title={S.colResultTitle}>{S.colResult}</th><th className="num">{S.colResultPct}</th></tr>
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
                              <Pop portal open={classify === id} onClose={() => setClassify(null)} width={460} label={S.classification}>
                                <ClassifyCard items={[i]} positions={data.positions} strategy={strategy} accounts={accounts} highlight={false} focusId={id}
                                  onSave={async (inst, patch) => { await onClassify(inst, patch); setClassify(null); }} />
                              </Pop>
                            </span>
                          )} />
                      </td>
                      <td className="c-hint">{hint && <HintChip hint={hint} held />}</td>
                      <td className="c-spark"><Spark values={(p.closes_30d ?? []).map((x) => x.close)} tone={cost ? "" : undefined} label={S.spark30d(i.label)} /></td>
                      <td className="num">{p.price != null ? money(p.price, p.price_currency ?? c) : "-"}{p.is_stale && <> <span className="tag warn">{dm(p.price_date)}</span></>}</td>
                      <td className={`num ${cost || wk == null ? "muted" : wk >= 0 ? "pos" : "neg"}`}>{wk != null ? pct(wk, true) : "-"}</td>
                      {weightCell(p.weight)}
                      <td className="num">{money(p.value, c)}</td>
                      <td className={`num c-abs ${resultCls(p.unrealized)}`}>{money0(p.unrealized, c, true)}</td>
                      <GainCell pct={p.unrealized_pct} gain={p.unrealized} cost={p.cost} c={c} />
                    </tr>
                    {parts?.map((a) => (
                      <tr key={`${id}:${a.account_id}`} className="sum">
                        <td style={{ paddingLeft: 28 }}>{accLabel(a.account_id)}</td><td className="c-hint" /><td className="c-spark" /><td /><td />
                        {weightCell(a.weight)}
                        <td className="num">{money(a.value, c)}</td>
                        <td className="num c-abs" /><GainCell pct={a.unrealized_pct} gain={a.value != null && a.cost != null ? a.value - a.cost : null} cost={a.cost} c={c} />
                      </tr>
                    ))}
                  </Fragment>
                );
              })}
              {!rows.length && <tr><td colSpan={9} className="muted">{S.noPositions}</td></tr>}
              {data.cash.length > 0 && (
                <tr className="sum">
                  <td>{S.cash} · {nAccountsInv(cashAccounts)}</td><td className="c-hint" /><td className="c-spark" /><td /><td />
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
const totalK = (total: number, currency: string) => (total >= 1000 ? hideAmount(S.thousands(Math.round(total / 1000))) : money0(total, currency));

/** Aktywa `Wynik %` cell: hovering it opens the instrument-card style card with the gain in money and the cost
 * (the Wynik column is hidden when the main column is narrow); without hover a one-line `title`. */
function GainCell({ pct: ratio, gain, cost, c }: { pct: number | null; gain: number | null; cost: number | null; c: string }) {
  const ref = useRef<HTMLTableCellElement>(null);
  const id = useId();
  const touch = useTouch();
  const hover = useHoverCard(ref, gain != null && !touch);
  const label = gain != null && gain < 0 ? S.loss : S.gain;
  const tone = ratio == null ? "" : ratio >= 0 ? "pos" : "neg";
  return (
    <td ref={ref} className={`num ${tone}`} title={touch && gain != null ? `${label} ${money(gain, c, true)}` : undefined}
      aria-describedby={hover.open ? id : undefined} {...hover.handlers}>
      {pct(ratio, true)}
      {hover.open && ref.current && (
        <HoverCard anchor={ref.current} id={id} className="gain">
          <div className="kvl">
            <span className="k">{label}</span><span className={`tnum ${gain != null && gain < 0 ? "neg" : "pos"}`}>{money(gain, c, true)}</span>
            {cost != null && <><span className="k">{S.cost}</span><span className="tnum">{money(cost, c)}</span></>}
          </div>
        </HoverCard>
      )}
    </td>
  );
}

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
  const title = [fr.fx.newest_rate ? `NBP ${dm(fr.fx.newest_rate)}` : null, ...fr.prices.stale.slice(0, 2).map((s) => S.priceFrom(s.label, dm(s.price_date))),
    inactive.length ? S.inactiveRules(inactive.length) : null, invalid ? S.strategyError : null].filter(Boolean).join(" · ");
  return (
    <>
      <button className="lnk" title={title} onClick={() => setOpen(true)}>{S.warnings(n)}</button>
      <Drawer open={open} title={S.dataWarnings} onClose={() => setOpen(false)} width={520}>
        {(inactive.length > 0 || invalid) && (
          <div className="muted" style={{ fontSize: 12.5, marginBottom: 10, display: "grid", gap: 4 }}>
            {inactive.length > 0 && <span className="warn" title={inactive.map((r) => ruleKindLabel(r.kind)).join(", ")}>{S.inactiveRules(inactive.length)} · <button className="lnk" style={{ fontSize: 12.5 }} onClick={() => { setOpen(false); onSettings(); }}>{S.fixInSettings}</button></span>}
            {invalid && <span className="warn">{S.strategyError} · <button className="lnk" style={{ fontSize: 12.5 }} onClick={() => { setOpen(false); onSettings(); }}>{S.settings}</button></span>}
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
  if (!accounts.length) return <div className="empty">{S.noAccounts}</div>;
  const total = accounts.reduce((s, a) => s + Math.max(0, a.value ?? 0), 0);
  const rows = accounts.map((a, k) => ({ a, color: `var(${PALETTE[k % 8]})`, snap: accountSnapshot(a, today) }));
  return (
    <div className={`alloc ${wide ? "wide" : ""} acc`}>
      <Donut size={wide ? 128 : 112} label={S.accountsDonut(rows.map((r) => `${accountLabel(r.a, accounts)} ${pct(r.a.share ?? null)}`).join(", "))}
        segments={rows.map((r) => ({ value: Math.max(0, r.a.value ?? 0), color: r.color }))}>
        <b>{totalK(total, c)}</b><span>{nAccountsInv(accounts.length)}</span>
      </Donut>
      <div>
        <div className="arow head"><span /><span>{S.colAccount}</span><span className="num">{S.colNow}</span><span className="num">{S.colValueLc}</span><span className="num c-snap">{S.colSnapshot}</span></div>
        {rows.map(({ a, color, snap }) => (
          <div className="arow" key={a.id} title={snap.title}>
            <span className="sw" style={{ background: color }} />
            <span className="n">{accountLabel(a, accounts)}</span>
            <span className="num">{a.share != null ? pct(a.share) : ""}</span>
            <span className="num">{a.value != null ? money0(a.value, c) : "-"}</span>
            <span className="num c-snap snap">{snap.warn ? <button className="lnk" onClick={() => onReconcile(a.id)}>{snap.cell} · {S.reconcile}</button> : snap.cell}</span>
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
  const bandTitle = band != null ? S.band(band) : undefined;
  const belowTarget = [...alloc.buckets].filter((b) => b.drift_pp < 0).sort((a, b) => a.drift_pp - b.drift_pp)[0];
  const aboveTarget = [...alloc.buckets].filter((b) => b.drift_pp > 0).sort((a, b) => b.drift_pp - a.drift_pp)[0];
  const priority = belowTarget ?? aboveTarget;
  const priorityBucket = priority ? bucketGenitive(priority.bucket_id) : null;
  const priorityText = priority && priorityBucket
    ? priority.drift_pp < 0
      ? S.priorityGrow(priorityBucket, pp(priority.drift_pp))
      : S.priorityHold(priorityBucket, pp(priority.drift_pp))
    : S.priorityKeep;
  const rows = view === "buckets"
    ? [
      ...alloc.buckets.map((b) => ({ key: b.bucket_id, name: bucketLabel(b.bucket_id) ?? "", color: bucketColor(b.bucket_id, order), w: b.weight, target: b.target as number | null, drift: b.drift_pp as number | null, out: !!b.out_of_band, value: b.value, toTarget: b.to_target as number | null })),
      ...(alloc.unclassified && alloc.unclassified.value ? [{ key: "_none", name: S.noBucket, color: "var(--inv-other)", w: alloc.unclassified.weight, target: null, drift: null, out: false, value: alloc.unclassified.value, toTarget: null }] : []),
    ]
    : view === "accounts" ? [] : (view === "classes" ? alloc.by_asset_class : alloc.by_region).map((s, k) => ({
      key: s.key, name: view === "classes" ? (s.key === "cash" ? S.cashLc : assetClass(s.key)) : region(s.key), color: `var(${PALETTE[k % 8]})`,
      w: s.weight, target: null, drift: null, out: false, value: s.value, toTarget: null as number | null,
    }));
  const items: [string, AllocView][] = [...(generic ? [[S.viewBuckets, "buckets"] as [string, AllocView]] : []), [S.viewClasses, "classes"], [S.viewRegions, "regions"], [S.viewAccounts, "accounts"]];
  return (
    <Widget title={S.allocation} id="inv-alloc"
      tags={view === "buckets" ? (out ? <span className="tag warn" title={bandTitle}>{S.outOfBand(out)}</span> : <span className="tag pos" title={bandTitle}>{S.inBand}</span>) : undefined}
      controls={
        <>
          <Seg quiet label={S.allocSplit} value={view} onChange={onView} items={items} />
          {view === "accounts" && (
            <>
              <DataWarnings overview={overview} strategy={strategy} today={today} onReconcile={onReconcile} onAlias={onAlias} onSettings={onSettings} />
              <button className="btn sm" onClick={onAdd}>{S.addAccount}</button>
            </>
          )}
        </>
      }>
      {view === "accounts" ? <AccountsRows overview={overview} today={today} wide={wide} onReconcile={onReconcile} /> : !rows.length ? <div className="empty">{S.noPositionsShort}</div> : (
        <div className={`alloc ${wide ? "wide" : ""}`}>
          <Donut size={wide ? 128 : 112} label={S.allocDonut(rows.map((r) => `${r.name} ${pct(r.w)}`).join(", "))} segments={rows.map((r) => ({ value: Math.max(0, r.value), color: r.color }))}>
            <b>{totalK(alloc.total, alloc.base_currency)}</b><span>{view === "buckets" ? nBuckets(alloc.buckets.length) : S.positions(rows.length)}</span>
          </Donut>
          <div>
            <div className="arow head"><span /><span>{view === "buckets" ? S.colBucket : view === "classes" ? S.colClass : S.colRegion}</span><span className="num">{S.colNow}</span>
              <span className="num" title={view === "buckets" && filtered ? S.targetWholeTitle : undefined}>{view === "buckets" ? S.colTarget : ""}</span>
              <span className="num" title={view === "buckets" ? bandTitle : undefined}>{view === "buckets" ? S.colDrift : ""}</span>
              {wide && <><span className="num c-val">{S.colValueLc}</span><span className="num c-to">{view === "buckets" ? S.colToTarget : ""}</span></>}</div>
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
          {view === "buckets" && (
            <div className={`portfolio-priority ${priority?.out_of_band ? "warn" : ""}`}>
              <b>{S.priority}</b><span>{priorityText}</span>
            </div>
          )}
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
    <Widget title={S.viewAccounts} id="inv-accounts" body="tight"
      controls={<><DataWarnings overview={overview} strategy={strategy} today={today} onReconcile={onReconcile} onAlias={onAlias} onSettings={onSettings} />
        <button className="btn sm" onClick={onAdd}>{S.addAccount}</button></>}>
      <AccountsRows overview={overview} today={today} onReconcile={onReconcile} />
    </Widget>
  );
}
