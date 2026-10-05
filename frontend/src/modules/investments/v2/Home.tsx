// Inwestycje v2 (design/v2/inv-home.html, inv-review.html; ia-v2.md 2-4, 9): the page head, then the widget
// grid on thirds in reading order: hero, Sygnały (Szanse | Ryzyka) + Alerty, Wartość vs benchmark + Alokacja,
// Aktywa + Obserwowane, Obsunięcie + Wpłaty + Rachunki. The weekly review is a strip with Co się zmieniło above
// the grid; after 21+ days away a re-entry banner, the change log and Stan dziś come first. The review strip
// opens by itself on the profile's digest weekday until the review is marked done (decisions.md 7). Sub-pages:
// the alerts manager (`/alerts`), the decision journal (`/journal`) and the asset detail (`/assets/{id}`: a
// drawer over this grid, F6 owner decision 3; `?page=1` = "otwórz jako stronę"). A zero-start profile gets a
// light grid in the narrow frame (widgets appear when their data does).
//
// Profile scoping: the shell remounts the page per profile; every request takes the slug; remembered values
// (account filter, review note, review open, re-entry baseline) live under slug-scoped keys.
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError } from "../../../core/api";
import { useShell } from "../../../core/context";
import { errorText } from "../../../core/messages";
import { PRIVACY_PLAIN } from "../../../core/SetupPage";
import type { ModuleCtx } from "../../../core/types";
import { useAsync } from "../../../hooks";
import { Code, Notice, SetupSteps, type SetupStepItem, Seg, Skeleton, Tag, useToast } from "../../../ui";
import { Fact, Grid, type GridItem, Widget } from "../../../widgets";
import {
  type CommitResult, deleteReview, getProposals, getStrategy, patchInstrument, type Position, postReview, postRun, postStrategyInit, postStrategyReload,
  type Thesis,
} from "../api";
import { AccountDrawer, ImportDrawer, ProposalDrawer, ThesisDrawer, TxnDrawer, TxnsDrawer } from "../Drawers";
import { storedKey, useStored } from "../hooks";
import { accountLabel, dm, hm, isoDate, money, money0, pct, plural, pp, RUN_STATUS, WEEKDAYS, wdm } from "../labels";
import { runError } from "../logic";
import { makeUndo, undoMessage } from "../undo";
import { AlertsManager, AlertsWidget, type InstrumentChoice } from "./Alerts";
import { getAlerts, getDigestV2, getOverviewV2, getPerformance, getPositionsV2, getSignalsV2, getWatchlist, dropCache, type PerfPoint } from "./api";
import { AssetDrawer } from "./AssetDrawer";
import { AssetDetail, assetName } from "./AssetPage";
import { Journal } from "./Journal";
import { daysSince, instName, isDigestDay, nextWeekday, planForMonth, REENTRY_DAYS, reviewAutoOpen } from "./logic";
import { usePlannedDeposits } from "./Overview";
import { ContributionsWidget, DrawdownWidget, ValueChartWidget } from "./Perf";
import { AccountsWidget, AllocationWidget, AssetList } from "./Portfolio";
import { ChangeLog, ChangesWidget, ReentryBanner, ReviewStrip, StateToday } from "./Review";
import { type SignalsCtx, SignalsWidget } from "./Signals";
import { WatchlistWidget } from "./Watchlist";

type DrawerState =
  | { kind: "import"; account?: number | null }
  | { kind: "txn"; instrumentId?: number | string | null; type?: string }
  | { kind: "account" }
  | { kind: "thesis"; position: Position; thesis: Thesis | null }
  | { kind: "proposal"; id: number }
  | { kind: "txns"; position: Position };

const ss = {
  get: (k: string) => { try { return sessionStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string | null) => { try { if (v == null) sessionStorage.removeItem(k); else sessionStorage.setItem(k, v); } catch { /* ignore */ } },
};
const ls = {
  get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
};
const lastSeenKey = (slug: string) => `finanse.lastSeen.${slug}`;

/** Market change over the last 7 days: money without the flows in between, TWR ratio for the percent. */
function weekMove(points: PerfPoint[], asOf: string): { money: number; pct: number | null } | null {
  if (points.length < 2) return null;
  const from = new Date(new Date(`${asOf}T12:00:00`).getTime() - 7 * 86400000).toISOString().slice(0, 10);
  let k = 0;
  for (let i = 0; i < points.length; i++) if (points[i].date <= from) k = i;
  const a = points[k], b = points[points.length - 1];
  if (a.value == null || b.value == null || a === b) return null;
  const flows = points.slice(k + 1).reduce((s, p) => s + (p.flow ?? 0), 0);
  const ratio = a.twr != null && b.twr != null ? (1 + b.twr) / (1 + a.twr) - 1 : null;
  return { money: b.value - a.value - flows, pct: ratio };
}

export function InvestmentsV2({ ctx }: { ctx: ModuleCtx }) {
  const slug = ctx.slug;
  const toast = useToast();
  const { setNarrow } = useShell();
  const [route, query] = (ctx.sub ?? "").split("?");
  const params = useMemo(() => new URLSearchParams(query ?? ""), [query]);
  const go = useCallback((sub?: string) => ctx.go({ kind: "tab", tab: "investments.portfolio", sub }), [ctx]);
  // The asset drawer opens over the grid: the route changes (deep link) but the page under it keeps its
  // scroll position (the shell scrolls to the top on every navigation).
  const goKeep = useCallback((sub?: string) => {
    const y = window.scrollY;
    go(sub);
    requestAnimationFrame(() => window.scrollTo({ top: y }));
  }, [go]);
  const assetRoute = /^assets\/(\d+)$/.exec(route ?? "");
  const assetId = assetRoute ? Number(assetRoute[1]) : null;
  const assetPage = assetId != null && params.get("page") === "1";
  const openAsset = useCallback((id: number | string) => goKeep(`assets/${id}`), [goKeep]);
  const openJournal = useCallback((instrument?: number | string | null) => go(instrument != null ? `journal?instrument=${instrument}` : "journal"), [go]);

  const [filter, setFilter] = useStored<number | null>(storedKey("filter", slug), null);
  const [note, setNote] = useStored<string>(storedKey("reviewNote", slug), "");
  const [nonce, setNonce] = useState(0);
  const reload = useCallback(() => { dropCache(); setNonce((n) => n + 1); }, []);
  const accountsFilter = filter == null ? null : [filter];
  const ov = useAsync(() => getOverviewV2(slug, accountsFilter), [slug, filter, nonce]);
  const pos = useAsync(() => getPositionsV2(slug, accountsFilter), [slug, filter, nonce]);
  const sig = useAsync(() => getSignalsV2(slug, "open"), [slug, nonce]);
  const alertsQ = useAsync(() => getAlerts(slug).catch(() => []), [slug, nonce]);
  const watchQ = useAsync(() => getWatchlist(slug).catch(() => []), [slug, nonce]);
  const strat = useAsync(() => getStrategy(slug).catch(() => null), [slug, nonce]);
  const dig = useAsync(() => getDigestV2(slug).catch(() => null), [slug, nonce]);
  const props = useAsync(() => getProposals(slug).catch(() => []), [slug, nonce]);
  const planned = usePlannedDeposits(slug, nonce);
  const perf1y = useAsync(() => getPerformance(slug, "1y", accountsFilter).catch(() => null), [slug, filter, nonce]);
  const perfYtd = useAsync(() => getPerformance(slug, "ytd", accountsFilter).catch(() => null), [slug, filter, nonce]);
  const perf1m = useAsync(() => getPerformance(slug, "1m", accountsFilter).catch(() => null), [slug, filter, nonce]);
  const [drawer, setDrawer] = useState<DrawerState | null>(null);
  const shellStale = useRef(false);
  const [runBusy, setRunBusy] = useState(false);
  const [initBusy, setInitBusy] = useState(false);

  // A remembered filter that no longer names one of this profile's accounts falls back to all accounts.
  useEffect(() => {
    if (filter == null) return;
    const gone = ov.error ? /brokerage account|account id/i.test(ov.error) : ov.data ? !ov.data.accounts.some((a) => a.id === filter) : false;
    if (gone) setFilter(null);
  }, [ov.error, ov.data]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- re-entry: compare the last visit on open, remember this visit when leaving -----------------------------
  const reentryKey = `finanse.inv.reentry.${slug}`;
  const [reentry, setReentry] = useState<string | null>(() => {
    const kept = ss.get(reentryKey);
    if (kept) return kept;
    const prev = ls.get(lastSeenKey(slug));
    if (prev && daysSince(prev, new Date().toISOString()) >= REENTRY_DAYS) { ss.set(reentryKey, prev); return prev; }
    return null;
  });
  useEffect(() => {
    const save = () => ls.set(lastSeenKey(slug), new Date().toISOString());
    const onHide = () => { if (document.visibilityState === "hidden") save(); };
    window.addEventListener("pagehide", save);
    document.addEventListener("visibilitychange", onHide);
    if (!ls.get(lastSeenKey(slug))) save();
    return () => { window.removeEventListener("pagehide", save); document.removeEventListener("visibilitychange", onHide); save(); };
  }, [slug]);
  const reDigest = useAsync(() => (reentry ? getDigestV2(slug, reentry.slice(0, 10)).catch(() => null) : Promise.resolve(null)), [slug, reentry, nonce]);
  const dismissReentry = () => { ss.set(reentryKey, null); ls.set(lastSeenKey(slug), new Date().toISOString()); setReentry(null); };

  // ---- review strip ------------------------------------------------------------------------------------------
  const reviewKey = `finanse.inv.reviewOpen.${slug}`;
  const [reviewOpen, setReviewOpenState] = useState(() => ss.get(reviewKey) === "1" || params.get("review") === "1");
  const setReviewOpen = (v: boolean) => { setReviewOpenState(v); ss.set(reviewKey, v ? "1" : "0"); };
  const [step, setStep] = useState(0);
  const started = useRef<number | null>(null);
  const [doneLocal, setDoneLocal] = useState<string | null>(null);
  useEffect(() => { if (params.get("review") === "1") { setReviewOpen(true); started.current ??= Date.now(); } }, [params]); // eslint-disable-line react-hooks/exhaustive-deps

  const overview = ov.data;
  const positions = pos.data;
  const accounts = overview?.accounts ?? [];
  const today = overview?.as_of ?? isoDate(new Date());
  const base = overview?.base_currency ?? ctx.profile.base_currency;
  const strategy = strat.data;
  const digest = dig.data;
  const weekday = digest?.digest_weekday ?? strategy?.facts?.notifications.digest_weekday ?? "sunday";
  const due = doneLocal ? false : !!digest?.review_due;
  const hasData = !!positions && (positions.positions.length > 0 || positions.cash.some((c) => c.amount !== 0));
  const alerts = alertsQ.data ?? [];
  const watch = watchQ.data ?? [];
  const alertsById = useMemo(() => new Map(alerts.map((a) => [a.id, a])), [alerts]);

  // Signals scoped to the account filter (instrument signals of instruments held there; portfolio-wide stay).
  const signals = useMemo(() => {
    const held = new Set((positions?.positions ?? []).map((p) => String(p.instrument.id)));
    return (sig.data ?? []).filter((s) => filter == null || s.instrument_id == null || held.has(String(s.instrument_id)));
  }, [sig.data, positions, filter]);
  const decided = signals.filter((s) => s.decisions.length).length;

  // Minimal profile density (ia-v2.md 9): widgets appear when their data does.
  const historyMonths = perf1y.data?.points.length ? daysSince(perf1y.data.points[0].date, today) / 30.4 : 0;
  const light = !!positions && positions.positions.length <= 1 && !signals.length && !alerts.length && historyMonths < 6 && !(overview?.allocation.buckets.length);
  // Narrow frame: the light grid (also under its asset drawer) and the asset detail as a page.
  const homeLike = !route || route === "watch" || (assetId != null && !assetPage);
  useEffect(() => {
    setNarrow((light && homeLike) || assetPage);
    return () => setNarrow(false);
  }, [light, homeLike, assetPage, setNarrow]);

  // decisions.md 7: on the digest weekday the review strip opens by itself until the review is marked done.
  // Closing it keeps it closed for this visit (session); the next visit that day opens it again.
  useEffect(() => {
    if (!reviewAutoOpen({ due, light, hasData, today: isoDate(new Date()), weekday, explicit: ss.get(reviewKey) })) return;
    setReviewOpen(true);
    started.current ??= Date.now();
  }, [due, light, hasData, weekday]); // eslint-disable-line react-hooks/exhaustive-deps

  const instruments: InstrumentChoice[] = useMemo(() => {
    const out: InstrumentChoice[] = (positions?.positions ?? []).map((p) => ({
      id: Number(p.instrument.id), label: instName(p.instrument), symbol: p.instrument.symbol, venue: p.instrument.mic, currency: p.price_currency ?? p.instrument.currency, price: p.price, held: true,
    }));
    for (const w of watch) {
      if (!out.some((o) => o.id === w.instrument_id) && w.instrument) {
        out.push({ id: w.instrument_id, label: instName(w.instrument), symbol: w.instrument.symbol, venue: w.instrument.mic, currency: w.price?.currency ?? w.instrument.currency, price: w.price?.close ?? null, held: false });
      }
    }
    return out;
  }, [positions, watch]);

  // ---- actions -------------------------------------------------------------------------------------------------
  const run = async () => {
    setRunBusy(true);
    try {
      const r = await postRun(slug);
      const p = r.profiles?.[0];
      const status = p?.status ?? "ok";
      const firstErr = p?.errors?.[0] ?? r.market_errors?.[0] ?? r.market_error ?? "";
      toast(status === "failed" ? `Przebieg reguł nieudany${firstErr ? `: ${runError(firstErr)}` : ""}` : status === "partial" ? `Reguły przeliczone częściowo${firstErr ? ` · ${runError(firstErr)}` : ""}` : "Reguły przeliczone", 4000);
      reload();
    } catch (e) {
      toast(e instanceof ApiError && e.status === 409 ? "Reguły już działają (praca w tle)" : `Nie udało się uruchomić reguł: ${errorText(e)}`, 4000);
    } finally { setRunBusy(false); }
  };
  const initStrategy = async () => {
    setInitBusy(true);
    try {
      await postStrategyInit(slug);
      await postStrategyReload(slug).catch(() => null);
      toast("Utworzono strategię z szablonu · uzupełnij strategy.yaml albo poproś agenta o propozycję", 4000);
      reload();
    } catch (e) { toast(`Nie utworzono strategii: ${errorText(e)}`, 4000); } finally { setInitBusy(false); }
  };
  const classify = async (i: { id: number | string }, patch: { asset_class: string; region: string | null; valuation_mode: string; tags: string[] }) => {
    try { await patchInstrument(slug, i.id, patch); toast("Zapisano klasyfikację · alokacja przeliczona", 2500); reload(); }
    catch (e) { toast(`Nie zapisano: ${errorText(e)}`, 4000); throw e; }
  };
  const alias = async (instrumentId: string, yahoo: string) => {
    try { await patchInstrument(slug, instrumentId, { aliases: [{ namespace: "yahoo", value: yahoo }] }); toast("Zapisano alias · ceny przy następnym przebiegu reguł", 3000); reload(); }
    catch (e) { toast(`Nie zapisano aliasu: ${errorText(e)}`, 4000); throw e; }
  };
  const scrollTo = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
  const openReview = () => { setReviewOpen(true); setStep(0); started.current ??= Date.now(); window.scrollTo({ top: 0, behavior: "smooth" }); };
  const onStep = (k: number) => {
    setStep(k);
    if (k === 1) setTimeout(() => scrollTo("inv-signals"), 30);
    if (k === 2) document.getElementById("inv-review-note")?.focus();
  };
  const markDone = async () => {
    const minutes = started.current ? Math.max(1, Math.round((Date.now() - started.current) / 60000)) : null;
    const text = note.trim() || null;
    try {
      const rv = await postReview(slug, text, { open_signals: signals.length, decided, ...(minutes ? { minutes } : {}) });
      setReviewOpen(false);
      setDoneLocal(rv.done_at ?? new Date().toISOString());
      setNote("");
      started.current = null;
      reload();
      const u = rv.id != null ? makeUndo(Date.now(), () => deleteReview(slug, rv.id!)) : null;
      const retry = () => {
        if (!u) return;
        void u.undo().then((res) => {
          const msg = undoMessage(res, "przegląd");
          if (res === "done") { setDoneLocal(null); setReviewOpen(true); setNote(text ?? ""); reload(); }
          if (msg) toast(msg, res === "failed" ? 8000 : 3000, res === "failed" ? { label: "Cofnij", onClick: retry } : undefined);
        });
      };
      toast(`Przegląd zapisany · następny ${dm(nextWeekday(today, weekday))}`, 10000, u ? { label: "Cofnij", onClick: retry } : undefined);
    } catch (e) {
      toast(e instanceof ApiError && e.status === 404 ? "Serwer nie zapisuje jeszcze przeglądów (brak /reviews)." : `Nie zapisano przeglądu: ${errorText(e)}`, 5000);
    }
  };

  const names = new Map((positions?.positions ?? []).map((p) => [Number(p.instrument.id), instName(p.instrument)] as [number, string]));
  for (const w of watch) if (w.instrument) names.set(w.instrument_id, instName(w.instrument));
  const signalsCtx: SignalsCtx = {
    slug, positions: positions?.positions ?? [], buckets: overview?.allocation.buckets ?? [], total: overview?.allocation.total ?? 0, base,
    accounts, today, contributionDay: strategy?.facts?.contributions?.day_of_month ?? null, alertsById, onChanged: reload,
    onOpenAsset: (id) => openAsset(id),
  };

  // ---- render --------------------------------------------------------------------------------------------------
  const err = ov.error || pos.error;
  if (err && !overview) return <div className="err">Błąd: {err}</div>;
  if (!overview || !positions) {
    return (
      <>
        <div className="pagehead"><h2 className="ph">Inwestycje</h2><Skeleton w={320} h={26} /><span className="spacer" /><Skeleton w={260} h={26} /></div>
        <div className="g3"><div className="gi s3"><Skeleton h={92} r={12} /></div><div className="gi s2"><Skeleton h={260} r={12} /></div><div className="gi s1"><Skeleton h={260} r={12} /></div></div>
      </>
    );
  }
  const drawers = renderDrawer();

  if (route === "alerts") {
    return (
      <>
        <AlertsManager slug={slug} instruments={instruments} buckets={strategy?.facts?.buckets ?? overview.allocation.buckets.map((b) => b.bucket_id)}
          digestWeekday={weekday} onBack={() => go()} initial={params} onChanged={reload} />
        {drawers}
      </>
    );
  }
  if (route === "journal") {
    return (
      <>
        <Journal slug={slug} instruments={instruments} accounts={accounts} initialInstrument={params.get("instrument")} onBack={() => go()}
          onOpenAsset={(id) => go(`assets/${id}`)} onChanged={reload} />
        {drawers}
      </>
    );
  }
  const assetDetail = (id: number, mode: "drawer" | "page") => (
    <AssetDetail key={id} id={id} ctx={signalsCtx} positions={positions.positions} alerts={alerts} watch={watch} mode={mode} noteId={params.get("note")}
      onNewAlert={() => go(`alerts?new=1&instrument=${id}`)}
      onAddTxn={() => setDrawer({ kind: "txn", instrumentId: id })}
      onTxns={(p) => setDrawer({ kind: "txns", position: p })}
      onThesis={(p, t) => setDrawer({ kind: "thesis", position: p, thesis: t })}
      onJournal={() => openJournal(id)}
      onAlerts={() => go(`alerts?instrument=${id}`)}
      onAlertsChanged={reload} />
  );
  if (assetId != null && assetPage) {
    const nm = assetName(assetId, positions.positions, watch);
    return (
      <>
        <nav className="crumb" aria-label="Ścieżka"><button onClick={() => go()}>Inwestycje</button> › <button onClick={() => go()}>Aktywa</button> › <span>{nm}</span>
          <span style={{ flex: 1 }} /><button className="lnk" onClick={() => go(`assets/${assetId}`)}>otwórz w panelu</button></nav>
        {assetDetail(assetId, "page")}
        {drawers}
      </>
    );
  }
  const assetDrawer = assetId != null && (
    <AssetDrawer name={assetName(assetId, positions.positions, watch)} onClose={() => goKeep()} onPage={() => go(`assets/${assetId}?page=1`)}
      onCrumb={(where) => { goKeep(); if (where === "assets") setTimeout(() => scrollTo("inv-assets"), 60); }}>
      {assetDetail(assetId, "drawer")}
    </AssetDrawer>
  );

  const fr = overview.freshness;
  const stale = fr.prices.stale_count;
  const head = (
    <div className="pagehead">
      <h2 className="ph">Inwestycje</h2>
      {accounts.length > 1 && (
        <Seg<number | null> quiet label="Rachunek" value={filter} onChange={setFilter}
          items={[["Wszystkie", null], ...accounts.map((a) => [accountLabel(a, accounts), a.id] as [string, number])]} />
      )}
      {hasData && (fr.prices.newest_bar ? <Tag title="Najnowsze notowanie w bazie">ceny {wdm(fr.prices.newest_bar)}</Tag> : <Tag>brak notowań - uruchom reguły</Tag>)}
      {stale > 0 && <button className="tag warn" style={{ background: "transparent", cursor: "pointer", font: "inherit", fontSize: 11 }}
        title={fr.prices.stale.map((s) => `${s.label}: ${s.price_date ? `ostatnie notowanie ${dm(s.price_date)}` : "brak notowań"}`).join("\n")}
        onClick={() => scrollTo("inv-accounts")}>{stale === 1 ? "1 nieaktualna" : `${stale} nieaktualne`}</button>}
      <span className="spacer" />
      <button className="btn ghost" onClick={run} disabled={runBusy || !hasData} title="Wycena, alokacja, reguły i alerty teraz (wspólna blokada z pracą w tle)">{runBusy ? "Uruchamiam…" : "Uruchom reguły"}</button>
      <button className="btn" onClick={() => setDrawer({ kind: "import", account: filter })}>Import</button>
      {!hasData ? <button className="btn" onClick={() => setDrawer({ kind: "txn" })}>Dodaj transakcję</button> : reviewOpen ? (
        <button className="btn" onClick={() => setReviewOpen(false)}>Zamknij tryb przeglądu</button>
      ) : (
        <button className={`btn ${due && !light ? "primary" : ""}`} onClick={openReview} title="Przegląd tygodnia">
          {doneLocal && !due ? `Przegląd zrobiony ${dm(doneLocal)}` : `Przegląd tygodnia · ${isDigestDay(today, weekday) ? "dziś" : WEEKDAYS[weekday] ?? weekday}`}
        </button>
      )}
    </div>
  );

  if (!hasData) {
    return <>{head}<Start accounts={accounts} strategy={strategy ?? null} hasTxn={positions.positions.length > 0} initBusy={initBusy}
      onAddAccount={() => setDrawer({ kind: "account" })} onInitStrategy={initStrategy} onAddTxn={() => setDrawer({ kind: "txn" })}
      onImport={() => setDrawer({ kind: "import", account: filter })} />{assetDrawer}{drawers}</>;
  }

  // ---- hero --------------------------------------------------------------------------------------------------
  const k = overview.kpis;
  const ytd = perfYtd.data;
  const yb = ytd?.benchmark?.status === "ok" ? ytd.benchmark : null;
  const week = perf1m.data ? weekMove(perf1m.data.points, perf1m.data.as_of) : null;
  const ddPts = perf1y.data?.points ?? [];
  const ddNow = ddPts.length ? ddPts[ddPts.length - 1].drawdown : null;
  let peak: string | null = null;
  for (const p of ddPts) if (p.drawdown != null && p.drawdown >= -1e-9) peak = p.date;
  const ac = k.alerts;
  const alertsLive = ac ? ac.active + ac.triggered : alerts.filter((a) => a.status === "active" || a.status === "triggered").length;
  const agentAlerts = alerts.filter((a) => a.source === "agent" && (a.status === "active" || a.status === "triggered")).length;
  const last = k.last_run;
  const runAt = last ? (last.finished_at ?? last.started_at) : null;
  const runDay = runAt ? (isoDate(new Date(runAt)) === today ? "dziś" : dm(runAt)) : null;
  const cashTarget = strategy?.facts?.targets?.cash;
  const lastReview = doneLocal ?? digest?.last_review?.done_at ?? null;
  const hero = (
    <section className="w hero" aria-label="Wartość portfela">
      <div className="h1">
        <div className="l">Wartość portfela</div>
        <div className="v">{money(k.value.total, base)}</div>
        {week && <div className="d"><span className={week.money >= 0 ? "pos" : "neg"}>{money(week.money, base, true)}{week.pct != null ? ` (${pct(week.pct, true)})` : ""}</span> w tym tygodniu</div>}
      </div>
      <div className="hf">
        <Fact label="Od początku roku" value={ytd?.summary?.twr != null ? pct(ytd.summary.twr, true) : "-"}
          detail={yb?.twr != null ? <>{yb.id ?? "benchmark"} {pct(yb.twr, true)}{yb.excess_twr != null && <> · <span className={yb.excess_twr >= 0 ? "pos" : "neg"}>{pp(yb.excess_twr * 100)}</span></>}</> : ytd === null ? "brak historii" : undefined} />
        <Fact label="Wynik niezrealizowany" value={money0(k.unrealized.amount, base, true)} detail={k.unrealized.pct != null ? `${pct(k.unrealized.pct, true)} od kosztu` : "koszt nieznany"} />
        <Fact label="Gotówka" value={pct(k.cash.weight)} detail={`${money0(k.cash.amount, base)}${cashTarget != null ? ` · cel ${Math.round(cashTarget * 100)} %` : ""}`} />
        {ddNow != null && <Fact label="Od szczytu" value={pct(ddNow)} detail={peak ? `szczyt ${dm(peak)}` : undefined} />}
        {!(light && !alertsLive) && <Fact label="Alerty" value={alertsLive} detail={<>{ac?.triggered ? <span className="neg">{plural(ac.triggered, "wyzwolony", "wyzwolone", "wyzwolonych")}</span> : "bez wyzwoleń"}{agentAlerts ? ` · ${agentAlerts} od agenta` : ""}</>} />}
      </div>
      <div className="hr">
        {last ? <span className={`tag solid ${last.status === "ok" ? "pos" : last.status === "failed" ? "neg" : "warn"}`} title={last.errors[0] ? runError(last.errors[0]) : undefined}>
          reguły: {runDay} {hm(runAt)} · {last.status === "ok" ? "ok" : RUN_STATUS[last.status] ?? last.status}</span> : <span className="tag">reguły jeszcze nie działały</span>}
        <div className="meta">{[strategy?.version != null ? `strategia v${strategy.version}` : "bez strategii", lastReview ? `ostatni przegląd ${dm(lastReview)}` : null].filter(Boolean).join(" · ")}</div>
      </div>
    </section>
  );

  // ---- grid ----------------------------------------------------------------------------------------------------
  const planAmount = strategy?.facts?.contributions?.monthly_amount ?? null;
  const plan = planAmount != null ? { amount: planAmount, day: strategy?.facts?.contributions?.day_of_month ?? null } : null;
  const budgetOn = ctx.profile.modules.some((m) => m.id === "budget" && m.enabled);
  const expired = (digest?.signals.resolved ?? []).filter((s) => s.status === "expired").map((s) => ({ title: s.instrument_label ?? s.rule_id }));
  const items: (GridItem | false)[] = [];
  if (reentry) {
    const days = daysSince(reentry, new Date().toISOString());
    items.push({ id: "reentry", span: 3, node: <ReentryBanner since={reentry} days={days} digest={reDigest.data} perf={perf1y.data} alerts={alerts} proposals={props.data ?? []}
      depositPlan={!!plan} onDismiss={dismissReentry} onReview={() => { scrollTo("inv-changelog"); if (due) openReview(); }} /> });
    items.push({ id: "changelog", span: 2, node: <ChangeLog since={reentry} digest={reDigest.data} alerts={alerts} proposals={props.data ?? []} accounts={accounts} today={today} names={names}
      onJournal={() => openJournal()} /> });
    items.push({ id: "today", span: 1, node: <StateToday since={reentry} total={k.value.total} base={base} ytd={ytd} perf={perf1y.data} signals={signals}
      reviewText={due ? "dziś" : WEEKDAYS[weekday] ?? weekday} onSignals={() => scrollTo("inv-signals")} /> });
  }
  if (reviewOpen && digest) {
    items.push({ id: "review", span: 3, node: <ReviewStrip digest={digest} step={step} onStep={onStep} decided={decided} total={signals.length} note={note} onNote={setNote} onDone={markDone} /> });
    items.push({ id: "changes", span: 3, node: <ChangesWidget digest={digest} perf={perf1y.data} alerts={alerts} proposals={props.data ?? []} accounts={accounts} names={names}
      onSignals={() => onStep(1)} onProposal={(id) => setDrawer({ kind: "proposal", id })} onJournal={() => openJournal()} /> });
  }
  if (!reviewOpen && !reentry) items.push({ id: "hero", span: 3, node: hero });
  if (last?.status === "failed") {
    items.push({ id: "failed", span: 3, node: <Notice tone="neg" style={{ margin: 0 }}>Ostatni przebieg reguł się nie udał{last.errors[0] ? `: ${runError(last.errors[0])}` : ""}. Sygnały poniżej pochodzą z wcześniejszego przebiegu.</Notice> });
  }
  const wSignals: GridItem = { id: "signals", span: 2, node: <SignalsWidget signals={sig.data ? signals : null} ctx={signalsCtx} hl={reviewOpen && step === 1} review={reviewOpen} expired={expired} onHistory={() => openJournal()} /> };
  const wAlerts: GridItem = { id: "alerts", span: 1, node: <AlertsWidget slug={slug} alerts={alertsQ.data} onManage={() => go("alerts")} onNew={() => go("alerts?new=1")} onChanged={reload} /> };
  const wValue: GridItem = { id: "value", span: 2, node: <ValueChartWidget slug={slug} accounts={accountsFilter} initial={perf1y.loading ? undefined : perf1y.data} /> };
  const wAlloc: GridItem = { id: "alloc", span: 1, node: <AllocationWidget alloc={overview.allocation} strategy={strategy ?? null} filtered={filter != null} /> };
  const wAssets: GridItem = { id: "assets", span: 2, node: <AssetList data={positions} accounts={accounts} signals={signals} alerts={alerts} strategy={strategy ?? null}
    onOpen={(id) => openAsset(id)} onAddTxn={() => setDrawer({ kind: "txn" })} onClassify={classify} /> };
  const wWatch: GridItem = { id: "watch", span: 1, node: <WatchlistWidget slug={slug} items={watchQ.data} onChanged={reload} onOpen={(id) => openAsset(id)} autoAdd={route === "watch"} /> };
  const wDd: GridItem = { id: "dd", span: 1, node: <DrawdownWidget perf={perf1y.loading ? undefined : perf1y.data} /> };
  const wContrib = (span: 1 | 2): GridItem => ({ id: "contrib", span, node: <ContributionsWidget perf={perf1y.loading ? undefined : perf1y.data} ytd={perfYtd.loading ? undefined : perfYtd.data} plan={plan ?? fallbackPlan()} today={today} fromBudget={budgetOn} /> });
  const wAccounts: GridItem = { id: "accounts", span: 1, node: <AccountsWidget overview={overview} strategy={strategy ?? null} today={today} onAdd={() => setDrawer({ kind: "account" })}
    onReconcile={(id) => setDrawer({ kind: "import", account: id })} onAlias={alias} onSettings={() => ctx.go({ kind: "settings", section: "agent" })} /> };
  if (light) {
    items.push(wContrib(2), wAccounts);
    if (watch.length || route === "watch") items.push(wWatch);
  } else {
    items.push(wSignals, wAlerts, wValue, wAlloc, wAssets, wWatch, wDd, wContrib(1), wAccounts);
  }
  return (
    <>
      {head}
      <Grid items={items.filter(Boolean) as GridItem[]} />
      {assetDrawer}
      {drawers}
    </>
  );

  /** Light profile without a strategy plan: the last deposit as the plan (the minimal view does the same). */
  function fallbackPlan() {
    const flows = (perf1y.data?.points ?? []).filter((p) => (p.flow ?? 0) > 0);
    const lastFlow = flows[flows.length - 1];
    const local = planForMonth(planned.list, today.slice(0, 7));
    if (local) return { amount: local.amount, day: Number(local.planned_date.slice(8, 10)) };
    return lastFlow ? { amount: lastFlow.flow!, day: Number(lastFlow.date.slice(8, 10)) } : null;
  }

  function renderDrawer(): ReactNode {
    if (!drawer) return null;
    const close = () => {
      setDrawer(null);
      if (shellStale.current) { shellStale.current = false; ctx.refresh(); }
    };
    const list = positions?.positions ?? [];
    switch (drawer.kind) {
      case "import":
        return (
          <ImportDrawer slug={slug} accounts={accounts} initialAccount={drawer.account ?? null} onClose={close}
            onDone={(r: CommitResult) => { toast(`Zaimportowano ${r.inserted} transakcji${r.planned_booked?.length ? ` · ${plural(r.planned_booked.length, "plan wpłaty zaksięgowany", "plany wpłat zaksięgowane", "planów wpłat zaksięgowanych")}` : ""}`, 3500); shellStale.current = true; reload(); }}
            onAddAccount={() => setDrawer({ kind: "account" })} onManual={() => setDrawer({ kind: "txn" })}
            onClassify={() => { close(); setTimeout(() => scrollTo("inv-assets"), 50); }} />
        );
      case "txn":
        return (
          <TxnDrawer slug={slug} accounts={accounts} positions={list} preset={{ instrumentId: drawer.instrumentId ?? null, type: drawer.type, accountId: filter }}
            onClose={close} onSaved={(w) => { shellStale.current = true; close(); toast(w.length ? `Zapisano transakcję · uwaga: ${w[0]}` : "Zapisano transakcję", w.length ? 5000 : 2500); reload(); }} />
        );
      case "account":
        return <AccountDrawer slug={slug} onClose={close} onSaved={(a) => { shellStale.current = true; close(); toast(`Dodano rachunek ${a.name}`, 2500); reload(); }} />;
      case "thesis":
        return <ThesisDrawer slug={slug} position={drawer.position} thesis={drawer.thesis} onClose={close} onSaved={() => { close(); toast("Zapisano tezę", 2000); reload(); }} />;
      case "proposal":
        return (
          <ProposalDrawer slug={slug} id={drawer.id} version={strategy?.version ?? null} onClose={close} onChanged={reload}
            onDone={(ok, v) => { close(); toast(ok ? `Zatwierdzono propozycję${v ? ` · strategia v${v}` : ""}` : "Odrzucono propozycję", 3000); reload(); }} />
        );
      case "txns":
        return <TxnsDrawer slug={slug} position={drawer.position} accounts={accounts} onClose={close} onAdd={() => setDrawer({ kind: "txn", instrumentId: drawer.position.instrument.id })} />;
    }
  }
}

/** First steps of an empty portfolio (strategy first, purchases later); no ghost panels. */
function Start({ accounts, strategy, hasTxn, initBusy, onAddAccount, onInitStrategy, onAddTxn, onImport }: {
  accounts: { id: number; name: string; broker?: string; broker_name?: string; wrapper?: string; currency: string }[];
  strategy: { state: string; version: number | null; facts?: { notifications: { digest_weekday: string } } | null } | null;
  hasTxn: boolean; initBusy: boolean; onAddAccount: () => void; onInitStrategy: () => void; onAddTxn: () => void; onImport: () => void;
}) {
  const { profile, slug, go } = useShell();
  const hasAccount = accounts.length > 0;
  const hasStrategy = !!strategy && strategy.state !== "missing";
  const weekday = strategy?.facts?.notifications.digest_weekday ?? "sunday";
  const steps: SetupStepItem[] = [
    {
      key: "account", status: hasAccount ? "done" : "on", title: "Rachunek maklerski",
      hint: hasAccount ? accounts.map((a) => `${accountLabel(a, accounts)} · ${a.currency}`).join(" · ") : "Jeden broker + jedno opakowanie (zwykłe, IKE, IKZE).",
      actions: <button className={`btn ${hasAccount ? "" : "primary"}`} onClick={onAddAccount}>{hasAccount ? "Dodaj kolejny" : "Dodaj rachunek"}</button>,
    },
    {
      key: "strategy", status: hasStrategy ? "done" : hasAccount ? "on" : "todo", title: "Strategia",
      tag: hasStrategy ? <Tag tone="pos">{strategy!.version != null ? `v${strategy!.version}` : "zapisana"}</Tag> : <Tag tone="info">zalecane teraz</Tag>,
      hint: hasStrategy ? "Koszyki i cele pojawią się w alokacji od pierwszej wyceny." : <>Cel, horyzont, koszyki i reguły w <code>strategy.yaml</code>; najprościej wywiad w Claude Code: <code>/investments-setup</code>.</>,
      actions: hasStrategy ? undefined : (
        <>
          <button className={`btn ${hasAccount ? "primary" : ""}`} onClick={onInitStrategy} disabled={initBusy}>{initBusy ? "Tworzę…" : "Utwórz z szablonu"}</button>
          <button className="btn" onClick={() => go({ kind: "setup", module: "investments" })}>Instrukcja Claude Code</button>
        </>
      ),
    },
    {
      key: "txn", status: hasTxn ? "done" : hasStrategy ? "on" : "todo", title: "Pierwsza wpłata lub zakup",
      hint: "Ręcznie albo import pliku od brokera (format finanse lub CSV z mapowaniem kolumn).",
      actions: hasAccount ? <><button className="btn" onClick={onAddTxn}>Dodaj transakcję</button><button className="btn" onClick={onImport}>Import</button></> : undefined,
    },
    { key: "review", status: "todo", title: "Pierwszy przegląd", hint: `${(WEEKDAYS[weekday] ?? weekday).replace(/^./, (m) => m.toUpperCase())} · raz w tygodniu albo rzadziej; aplikacja nie przypomina poza podsumowaniem.` },
  ];
  return (
    <Grid items={[
      {
        id: "start", span: 2, node: (
          <Widget title="Pierwsze kroki" body="tight" footer={<span>portfel jest pusty: zacznij od strategii, nie od zakupów</span>}>
            <SetupSteps steps={steps} />
            {!hasAccount && <Code cmd={`finanse --profile ${slug} invest accounts add "XTB IKE" --broker xtb --wrapper ike`} />}
          </Widget>
        ),
      },
      {
        id: "privacy", span: 1, node: (
          <Widget title="Agent AI" body="tight" footer={<button className="lnk" onClick={() => go({ kind: "settings", section: "agent" })}>Ustawienia</button>}>
            <div style={{ fontSize: 13 }}>{PRIVACY_PLAIN[profile.mcp_privacy] ?? PRIVACY_PLAIN.strict}</div>
          </Widget>
        ),
      },
    ]} />
  );
}
