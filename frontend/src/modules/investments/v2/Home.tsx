// Inwestycje v2 (design/v2/inv-home.html, inv-review.html; ia-v2.md 2-4, 9; home v3: design/v3/home-v3/home-v3.md
// rev 2 + owner F8 Q17-Q19): the page head, then the widget grid on thirds: the hero (value, YTD, unrealized,
// drawdown, contributions), one split cell (main 2/3: Wartość vs benchmark, Alokacja with the Rachunki view,
// Aktywa with the Obserwowane tab; rail 1/3: Sygnały, Alerty), the research strip last. `Wszystkie` in Sygnały
// opens the signals dialog (local state, not in the URL). The weekly review is a strip with Co się zmieniło above
// the grid; after 21+ days away a re-entry banner, the change log and Stan dziś come first. The review strip
// opens by itself on the profile's digest weekday until the review is marked done (decisions.md 7). Sub-pages:
// the alerts manager (`/alerts`), the decision journal (`/journal`) and the asset detail (`/assets/{id}`: a
// drawer over this grid, F6 owner decision 3; `?page=1` = "otwórz jako stronę"). A zero-start profile gets a
// light grid in the narrow frame (widgets appear when their data does).
//
// Profile scoping: the shell remounts the page per profile; every request takes the slug; remembered values
// (account filter, review note, review open, re-entry baseline) live under slug-scoped keys.
import { INV_PROPOSAL_KINDS, moduleSyncLines } from "../../../core/connectors";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type InstState, InstStateContext } from "./instState";
import { healthOf, healthStale } from "./research/logic";
import type { HealthKey } from "./research/types";
import { ApiError } from "../../../core/api";
import { useShell } from "../../../core/context";
import { errorText, label } from "../../../core/messages";
import { AgentWidget } from "../../../core/AgentWidget";
import type { ModuleCtx } from "../../../core/types";
import { useAsync, useInFlight } from "../../../hooks";
import { addDays, localDay } from "../../../time";
import { Code, Notice, SetupSteps, type SetupStepItem, Seg, Skeleton, Tag, useToast } from "../../../ui";
import { Fact, Grid, type GridItem, Split, Widget } from "../../../widgets";
import {
  type CommitResult, deleteReview, getProposals, getStrategy, patchInstrument, type Position, postReview, postRun, postStrategyInit, postStrategyReload,
  type Thesis,
} from "../api";
import { AccountDrawer, ImportDrawer, ProposalDrawer, ThesisDrawer, TxnDrawer, TxnsDrawer } from "../Drawers";
import { storedKey, useStored } from "../hooks";
import { accountLabel, dm, hm, isGenericBucket, isoDate, money, money0, pct, plural, pp, WEEKDAYS, wdm } from "../labels";
import { runError } from "../logic";
import { makeUndo, UNDO_WINDOW_MS, undoMessage, undoSettled } from "../undo";
import { AlertsManager, AlertsWidget, type InstrumentChoice } from "./Alerts";
import type { Hint } from "../api";
import { accKey, dropInv, getAlerts, getDigestV2, getOverviewV2, getPerformance, getPositionsV2, getSignalsV2, getWatchlist, invKey, type PerfPoint } from "./api";
import { AssetDrawer } from "./AssetDrawer";
import { AssetDetail, assetName } from "./AssetPage";
import { Journal } from "./Journal";
import {
  benchmarkLabel, contributionFacts, daysSince, instName, isDigestDay, monthlyFlows, nextWeekday, planForMonth, reentryBaseline, reviewAutoOpen, signalLinkTarget, signalPlace, signalText,
  staleBenchmark,
} from "./logic";
import { usePlannedDeposits } from "./Overview";
import { ContributionsWidget, ValueChartWidget } from "./Perf";
import { AccountsWidget, type AllocView, AllocationWidget, AssetList } from "./Portfolio";
import { useResearchHome } from "./research";
import { ChangeLog, ChangesWidget, ReentryBanner, ReviewStrip, StateToday } from "./Review";
import { type SignalFilter, type SignalsCtx, SignalsDialog, SignalsRail } from "./Signals";
import { WatchlistWidget } from "./Watchlist";
import { readStored } from "../../../core/storage.ts";

type DrawerState =
  | { kind: "import"; account?: number | null }
  | { kind: "txn"; instrumentId?: number | string | null; type?: string }
  | { kind: "account" }
  | { kind: "thesis"; position: Position; thesis: Thesis | null }
  | { kind: "proposal"; id: number }
  | { kind: "txns"; position: Position };

const ss = {
  get: (k: string) => { try { return readStored(sessionStorage, k); } catch { return null; } },
  set: (k: string, v: string | null) => { try { if (v == null) sessionStorage.removeItem(k); else sessionStorage.setItem(k, v); } catch { /* ignore */ } },
};
const ls = {
  get: (k: string) => { try { return readStored(localStorage, k); } catch { return null; } },
  set: (k: string, v: string | null) => { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* ignore */ } },
};
const lastSeenKey = (slug: string) => `cashu.lastSeen.${slug}`;

/** Market change over the last 7 days: money without the flows in between, TWR ratio for the percent. */
function weekMove(points: PerfPoint[], asOf: string): { money: number; pct: number | null } | null {
  if (points.length < 2) return null;
  const from = addDays(asOf, -7);
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
  // The review note draft stays in this window only (it may hold amounts); an old localStorage copy is dropped.
  const [note, setNote] = useStored<string>(storedKey("reviewNote", slug), "", "session");
  useEffect(() => { try { localStorage.removeItem(storedKey("reviewNote", slug)); } catch { /* ignore */ } }, [slug]);
  const [nonce, setNonce] = useState(0);
  // After a write: every cached investments view is forgotten (other pages read fresh), this page re-reads and
  // keeps showing its data meanwhile (F7 PX4).
  const reload = useCallback(() => { dropInv(slug); setNonce((n) => n + 1); }, [slug]);
  const accountsFilter = filter == null ? null : [filter];
  const acc = accKey(accountsFilter);
  // Keyed (F7 PX4): a revisit shows the last data at once and refreshes it. A failed refresh keeps the data
  // (the list / null fallbacks are the views' own `?? []` / `?? null`).
  const ov = useAsync(() => getOverviewV2(slug, accountsFilter), [slug, filter, nonce], { key: invKey(slug, "overview", acc) });
  const pos = useAsync(() => getPositionsV2(slug, accountsFilter), [slug, filter, nonce], { key: invKey(slug, "positions", acc) });
  // Every account's positions while a filter is on (P1 review FE-2: the plan label's held form must not follow the filter).
  const allPos = useAsync(() => (filter == null ? Promise.resolve(null) : getPositionsV2(slug, null)), [slug, filter, nonce],
    { key: filter == null ? undefined : invKey(slug, "positions", accKey(null)) });
  const sig = useAsync(() => getSignalsV2(slug, "open"), [slug, nonce], { key: invKey(slug, "signals", "open") });
  const alertsQ = useAsync(() => getAlerts(slug, "all"), [slug, nonce], { key: invKey(slug, "alerts", "all") });
  const watchQ = useAsync(() => getWatchlist(slug), [slug, nonce], { key: invKey(slug, "watchlist") });
  const strat = useAsync(() => getStrategy(slug), [slug, nonce], { key: invKey(slug, "strategy") });
  const dig = useAsync(() => getDigestV2(slug), [slug, nonce], { key: invKey(slug, "digest", "") });
  const props = useAsync(() => getProposals(slug).then((l) => l.filter((x) => INV_PROPOSAL_KINDS.has(x.kind))), [slug, nonce], { key: invKey(slug, "proposals", "pending") });
  const planned = usePlannedDeposits(slug, nonce);
  const perf1y = useAsync(() => getPerformance(slug, "1y", accountsFilter), [slug, filter, nonce], { key: invKey(slug, "perf", "1y", acc) });
  const perfYtd = useAsync(() => getPerformance(slug, "ytd", accountsFilter), [slug, filter, nonce], { key: invKey(slug, "perf", "ytd", acc) });
  const perf1m = useAsync(() => getPerformance(slug, "1m", accountsFilter), [slug, filter, nonce], { key: invKey(slug, "perf", "1m", acc) });
  const [drawer, setDrawer] = useState<DrawerState | null>(null);
  // Alokacja's view (home v3 Q2): Home owns it so the stale-prices tag and the header tag (`?alloc=accounts`)
  // can land on Rachunki.
  const [allocView, setAllocView] = useState<AllocView | null>(() => (params.get("alloc") === "accounts" ? "accounts" : null));
  useEffect(() => { if (params.get("alloc") === "accounts") setAllocView("accounts"); }, [params]);
  // Unread research notes (home v3 Q10): the server's counts minus what this window marked read.
  const [readIds, setReadIds] = useState<Set<string>>(() => new Set());
  const shellStale = useRef(false);
  const [runBusy, setRunBusy] = useState(false);
  const [initBusy, setInitBusy] = useState(false);

  // A remembered filter that no longer names one of this profile's accounts falls back to all accounts.
  useEffect(() => {
    if (filter == null) return;
    // useAsync keeps the Polish label of a coded error (404 `not_found`), else the English detail.
    const gone = ov.error ? ov.error === label("error.not_found") || /brokerage account|account id/i.test(ov.error) : ov.data ? !ov.data.accounts.some((a) => a.id === filter) : false;
    if (gone) setFilter(null);
  }, [ov.error, ov.data]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- re-entry: compare the last visit on open, remember this visit when leaving -----------------------------
  // The pending baseline lives in localStorage until "Wszystko jasne" (F7 FE17): leaving the page, closing the
  // window or a new window keeps it, and the last-visit mark does not move while it is pending.
  const reentryKey = `cashu.inv.reentry.${slug}`;
  const [reentry, setReentry] = useState<string | null>(() => {
    const r = reentryBaseline(ls.get(reentryKey) ?? ss.get(reentryKey), ls.get(lastSeenKey(slug)), new Date().toISOString());
    if (r.baseline) { ls.set(reentryKey, r.baseline); ss.set(reentryKey, null); }
    return r.baseline;
  });
  useEffect(() => {
    const save = () => { if (!ls.get(reentryKey)) ls.set(lastSeenKey(slug), new Date().toISOString()); };
    const onHide = () => { if (document.visibilityState === "hidden") save(); };
    window.addEventListener("pagehide", save);
    document.addEventListener("visibilitychange", onHide);
    if (!ls.get(lastSeenKey(slug))) save();
    return () => { window.removeEventListener("pagehide", save); document.removeEventListener("visibilitychange", onHide); save(); };
  }, [slug]); // eslint-disable-line react-hooks/exhaustive-deps
  const reSince = reentry ? localDay(reentry) ?? reentry.slice(0, 10) : null;
  const reDigest = useAsync(() => (reSince ? getDigestV2(slug, reSince) : Promise.resolve(null)), [slug, reSince, nonce],
    { key: reSince ? invKey(slug, "digest", reSince) : undefined });
  const dismissReentry = () => { ls.set(reentryKey, null); ss.set(reentryKey, null); ls.set(lastSeenKey(slug), new Date().toISOString()); setReentry(null); };

  // ---- review strip ------------------------------------------------------------------------------------------
  const reviewKey = `cashu.inv.reviewOpen.${slug}`;
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
  // A list that never loaded reads as empty (as the old `.catch(() => [])` did); a failed refresh keeps the list.
  const alertsList = alertsQ.data ?? (alertsQ.error ? [] : null);
  const watchList = watchQ.data ?? (watchQ.error ? [] : null);
  const alerts = alertsList ?? [];
  const watch = watchList ?? [];
  const alertsById = useMemo(() => new Map(alerts.map((a) => [a.id, a])), [alerts]);

  // Held instruments (Portfel / Obserwowane scope of the signals, home v3 Q6): the positions in view plus what the
  // server marks as held anywhere (`held` on a signal, F8).
  const held = useMemo(() => {
    const out = new Set((positions?.positions ?? []).map((p) => String(p.instrument.id)));
    for (const s of sig.data ?? []) if (s.held === true && s.instrument_id != null) out.add(String(s.instrument_id));
    return out;
  }, [positions, sig.data]);
  // Signals scoped to the account filter: portfolio-wide ones, instruments held in the filtered accounts and
  // watched-only instruments (not account-bound). Without the server's `held`, an instrument counts as held
  // elsewhere unless it is on the watchlist.
  const signals = useMemo(() => {
    const inView = new Set((positions?.positions ?? []).map((p) => String(p.instrument.id)));
    const watched = new Set((watchQ.data ?? []).map((w) => String(w.instrument_id)));
    const heldAnywhere = (s: { instrument_id: number | null; held?: boolean | null }) => (typeof s.held === "boolean" ? s.held : !watched.has(String(s.instrument_id)));
    return (sig.data ?? []).filter((s) => filter == null || s.instrument_id == null || inView.has(String(s.instrument_id)) || !heldAnywhere(s));
  }, [sig.data, positions, filter, watchQ.data]);
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

  // The signals dialog (signals-rail.md 3): `Wszystkie` in the rail, review step 2, a notification link to a
  // signal outside the rail's rows. Local state; leaving the home view closes it.
  const [sigDialog, setSigDialog] = useState<{ filter: SignalFilter; focusId: number | null } | null>(null);
  useEffect(() => { setSigDialog(null); }, [route]);

  // A notification click opens `?signal=<id>` (F6 NT): an open signal is scrolled to and highlighted in the
  // Sygnały rail when it is one of its rows, else in the signals dialog (the account filter is dropped when it
  // hides it); a closed one opens its asset drawer (the timeline) or the journal; an unknown or foreign id
  // leaves just the home. Handled once per id.
  const signalParam = params.get("signal");
  const needHistory = !!signalParam && !!sig.data && !sig.data.some((s) => String(s.id) === signalParam);
  const sigHistory = useAsync(() => (needHistory ? getSignalsV2(slug, "all").catch(() => []) : Promise.resolve([])).then((list) => ({ for: signalParam, list })),
    [slug, needHistory, signalParam]);
  const [focusSignal, setFocusSignal] = useState<number | null>(null);
  const linkDone = useRef<string | null>(null);
  useEffect(() => {
    if (!signalParam || linkDone.current === signalParam || !sig.data || !positions) return;
    if (needHistory && (sigHistory.loading || sigHistory.data?.for !== signalParam)) return;
    linkDone.current = signalParam;
    const t = signalLinkTarget(signalParam, sig.data, needHistory ? sigHistory.data?.list ?? [] : []);
    if (!t) return;
    if (t.kind === "open") {
      const dropFilter = filter != null && !signals.some((s) => s.id === t.id);
      if (dropFilter) setFilter(null);
      if (signalPlace(t.id, dropFilter ? sig.data : signals, held) === "rail") setFocusSignal(t.id);
      else setSigDialog({ filter: "all", focusId: t.id });
    } else {
      toast(`Ten sygnał jest już zamknięty (${t.status === "expired" ? "wygasł" : t.status === "resolved" ? "rozwiązany" : t.status})`, 4000);
      if (t.kind === "asset") openAsset(t.instrumentId); else openJournal();
    }
  }, [signalParam, sig.data, positions, needHistory, sigHistory.data, sigHistory.loading]); // eslint-disable-line react-hooks/exhaustive-deps

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
      toast(status === "failed" ? `Synchronizacja nieudana${firstErr ? `: ${runError(firstErr)}` : ""}` : status === "partial" ? `Zsynchronizowano częściowo${firstErr ? ` · ${runError(firstErr)}` : ""}` : "Zsynchronizowano", 4000);
      // the connector lines (a stored proposal shows in the proposals reloaded below)
      for (const line of moduleSyncLines(r.connectors, (l) => l.connector_id ?? "Konektor")) toast(line.text, line.failed ? 7000 : 5000);
      reload();
    } catch (e) {
      toast(e instanceof ApiError && e.status === 409 ? "Synchronizacja już trwa (praca w tle)" : `Nie udało się zsynchronizować: ${errorText(e)}`, 4000);
    } finally { setRunBusy(false); }
  };
  const initStrategy = async () => {
    setInitBusy(true);
    try {
      await postStrategyInit(slug);
      await postStrategyReload(slug).catch(() => null);
      toast("Strategia z szablonu · uzupełnij strategy.yaml", 4000);
      reload();
    } catch (e) { toast(`Nie utworzono strategii: ${errorText(e)}`, 4000); } finally { setInitBusy(false); }
  };
  const classify = async (i: { id: number | string }, patch: { asset_class: string; region: string | null; valuation_mode: string; tags: string[] }) => {
    try { await patchInstrument(slug, i.id, patch); toast("Zapisano klasyfikację", 2500); reload(); }
    catch (e) { toast(`Nie zapisano: ${errorText(e)}`, 4000); throw e; }
  };
  const alias = async (instrumentId: string, yahoo: string) => {
    try { await patchInstrument(slug, instrumentId, { aliases: [{ namespace: "yahoo", value: yahoo }] }); toast("Zapisano alias · ceny przy następnym przebiegu reguł", 3000); reload(); }
    catch (e) { toast(`Nie zapisano aliasu: ${errorText(e)}`, 4000); throw e; }
  };
  const scrollTo = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
  const openReview = () => { setReviewOpen(true); setStep(0); started.current ??= Date.now(); window.scrollTo({ top: 0, behavior: "smooth" }); };
  // Review step 2 opens the signals dialog; closing it keeps the review (the strip's chip reopens it).
  const onStep = (k: number) => {
    setStep(k);
    if (k === 1) setSigDialog({ filter: "all", focusId: null });
    if (k === 2) document.getElementById("inv-review-note")?.focus();
  };
  // One review per click (F7 FE2): a double click on "Zamknij przegląd" must not store two reviews.
  const doneFlight = useInFlight();
  // The review undo also sits next to "Przegląd zrobiony" for the server's 15 minutes, not only in the toast
  // (F7 FE14: keyboard and screen-reader owners can reach it).
  const [reviewUndo, setReviewUndo] = useState<(() => void) | null>(null);
  useEffect(() => {
    if (!reviewUndo) return;
    const t = setTimeout(() => setReviewUndo(null), UNDO_WINDOW_MS);
    return () => clearTimeout(t);
  }, [reviewUndo]);
  const markDone = () => doneFlight.run(async () => {
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
          if (res !== "failed" && res !== "busy") setReviewUndo(null);
          if (undoSettled(res)) { setDoneLocal(null); setReviewOpen(true); setNote(text ?? ""); reload(); }
          if (msg) toast(msg, res === "failed" ? 8000 : 3000, res === "failed" ? { label: "Cofnij", onClick: retry } : undefined);
        });
      };
      setReviewUndo(u ? () => retry : null);
      toast(`Przegląd zapisany · następny ${dm(nextWeekday(today, weekday))}`, 10000, u ? { label: "Cofnij", onClick: retry } : undefined);
    } catch (e) {
      toast(e instanceof ApiError && e.status === 404 ? "Serwer nie obsługuje przeglądów: zaktualizuj aplikację." : `Nie zapisano przeglądu: ${errorText(e)}`, 5000);
    }
  });

  const names = new Map((positions?.positions ?? []).map((p) => [Number(p.instrument.id), instName(p.instrument)] as [number, string]));
  for (const w of watch) if (w.instrument) names.set(w.instrument_id, instName(w.instrument));
  // Research layer (F6, v2/research): strip, review block, research view, note links; nothing before the first run.
  const research = useResearchHome({
    slug, nonce, today, privacy: ctx.profile.mcp_privacy, positions: positions?.positions ?? [], watch, strategyVersion: strategy?.version ?? null, digest,
    go, openAsset: (id, noteId) => goKeep(`assets/${id}${noteId != null ? `?note=${noteId}` : ""}`), onSettings: () => ctx.go({ kind: "settings", section: "agent" }), onChanged: reload,
  });
  // The tile's marks (P1, design/v3/plan-badges): thesis health from the cached research summary, stale research,
  // held instruments (the plan label's form); one provider for every label under this page.
  // Held = unfiltered positions + the server's `held` (signals, summary rows, watchlist rows); unknown (null, the held
  // form) while the unfiltered positions load.
  const allPositions = filter == null ? positions : allPos.data;
  const instState = useMemo<InstState>(() => {
    const health = new Map<string, HealthKey>();
    const pre = new Set<string>();
    for (const x of research.summary?.instruments ?? []) {
      health.set(String(x.instrument_id), healthOf(x, today));
      if (x.health_predates_thesis) pre.add(String(x.instrument_id));
    }
    let heldIds: Set<string> | null = null;
    if (allPositions) {
      heldIds = new Set(allPositions.positions.map((p) => String(p.instrument.id)));
      for (const s of sig.data ?? []) if (s.held === true && s.instrument_id != null) heldIds.add(String(s.instrument_id));
      for (const x of research.summary?.instruments ?? []) if (x.held === true) heldIds.add(String(x.instrument_id));
      for (const w of watchQ.data ?? []) if (w.held) heldIds.add(String(w.instrument_id));
    }
    const hints = new Map<string, Hint[]>();
    for (const w of watchQ.data ?? []) if (w.hints?.length) hints.set(String(w.instrument_id), w.hints);
    for (const p of (allPositions ?? positions)?.positions ?? []) if (p.hints) hints.set(String(p.instrument.id), p.hints);
    return { health, stale: health.size > 0 && healthStale(research.runs ?? [], today), held: heldIds, pre, hints };
  }, [research.summary, research.runs, today, allPositions, positions, sig.data, watchQ.data]);
  const provide = (node: ReactNode) => <InstStateContext.Provider value={instState}>{node}</InstStateContext.Provider>;
  const lastRun = overview?.kpis.last_run ?? null;
  const lastRunAt = lastRun && lastRun.status !== "failed" ? lastRun.finished_at ?? lastRun.started_at ?? null : null;
  const unreadOf = (id: number | string): number => {
    if (readIds.has(String(id))) return 0;
    const p = positions?.positions.find((x) => String(x.instrument.id) === String(id));
    const w = watch.find((x) => String(x.instrument_id) === String(id));
    const summaryN = research.summary?.instruments.find((x) => String(x.instrument_id) === String(id))?.unread;
    return p?.research_unread ?? w?.research_unread ?? summaryN ?? 0;
  };
  const markRead = (id: number | string) => setReadIds((cur) => (cur.has(String(id)) ? cur : new Set(cur).add(String(id))));
  const signalsCtx: SignalsCtx = {
    slug, positions: positions?.positions ?? [], buckets: overview?.allocation.buckets ?? [], total: overview?.allocation.total ?? 0, base,
    accounts, today, contributionDay: strategy?.facts?.contributions?.day_of_month ?? null, alertsById, onChanged: reload, held, watch, lastRunAt, onResearchRead: markRead,
    onOpenAsset: (id) => openAsset(id),
    researchOn: research.ran, researchEffect: research.effect,
    onOpenNote: (id, noteId, theme) => (id != null ? goKeep(`assets/${id}${noteId != null ? `?note=${noteId}` : ""}`) : go(theme ? `research?theme=${encodeURIComponent(theme)}` : "research")),
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
    return provide(
      <>
        <AlertsManager slug={slug} instruments={instruments} buckets={(strategy?.facts?.buckets ?? overview.allocation.buckets.map((b) => b.bucket_id)).filter(isGenericBucket)}
          digestWeekday={weekday} onBack={() => go()} initial={params} onChanged={reload} />
        {drawers}
      </>
    );
  }
  if (route === "research") return provide(<>{research.page(params, () => go())}{drawers}</>);
  if (route === "journal") {
    return provide(
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
    return provide(
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
  const last = overview.kpis.last_run;
  const runAt = last ? (last.finished_at ?? last.started_at) : null;
  const runDay = runAt ? (localDay(runAt) === today ? "dziś" : dm(runAt)) : null;
  const lastReview = doneLocal ?? digest?.last_review?.done_at ?? null;
  const head = (
    <div className="pagehead">
      <h2 className="ph">Inwestycje</h2>
      {accounts.length > 1 && (
        <Seg<number | null> quiet label="Rachunek" value={filter} onChange={setFilter}
          items={[["Wszystkie", null], ...accounts.map((a) => [accountLabel(a, accounts), a.id] as [string, number])]} />
      )}
      {hasData && (fr.prices.newest_bar ? <Tag title="Najnowsze notowanie w bazie">ceny {wdm(fr.prices.newest_bar)}</Tag> : <Tag>brak notowań</Tag>)}
      {stale > 0 && <button className="tag warn" style={{ background: "transparent", cursor: "pointer", font: "inherit", fontSize: 11 }}
        title={fr.prices.stale.map((s) => `${s.label}: ${s.price_date ? `ostatnie notowanie ${dm(s.price_date)}` : "brak notowań"}`).join("\n")}
        onClick={() => { setAllocView("accounts"); setTimeout(() => scrollTo(light ? "inv-accounts" : "inv-alloc"), 30); }}>{stale === 1 ? "1 nieaktualna" : `${stale} nieaktualne`}</button>}
      {/* The run status shows only when it is not ok (home v3 Q7); a failed run keeps its Notice. */}
      {hasData && last?.status === "partial" && <span className="tag warn" title={last.errors[0] ? runError(last.errors[0]) : undefined}>reguły częściowo</span>}
      {hasData && !last && <span className="tag">reguły jeszcze nie działały</span>}
      <span className="spacer" />
      <button className="btn ghost" onClick={run} disabled={runBusy || !hasData}
        title={`Ceny, wycena, reguły i alerty${last && runAt ? ` · ostatni przebieg ${runDay} ${hm(runAt)} · ${last.status === "ok" ? "ok" : last.status === "partial" ? "częściowo" : "błąd"}` : ""}`}>{runBusy ? "Synchronizuję…" : "↻ Synchronizuj"}</button>
      <button className="btn" onClick={() => setDrawer({ kind: "import", account: filter })}>Import</button>
      {!hasData ? <button className="btn" onClick={() => setDrawer({ kind: "txn" })}>Dodaj transakcję</button> : reviewOpen ? (
        <button className="btn" onClick={() => setReviewOpen(false)}>Zamknij przegląd</button>
      ) : (
        <button className={`btn ${due && !light ? "primary" : ""}`} onClick={openReview} title={`Przegląd tygodnia${lastReview ? ` · ostatni ${dm(lastReview)}` : ""}`}>
          {doneLocal && !due ? `Przegląd zrobiony ${dm(doneLocal)}` : `Przegląd tygodnia · ${isDigestDay(today, weekday) ? "dziś" : WEEKDAYS[weekday] ?? weekday}`}
        </button>
      )}
      {hasData && !reviewOpen && doneLocal && !due && reviewUndo && <button className="lnk" style={{ fontSize: 12 }} onClick={reviewUndo}>cofnij</button>}
    </div>
  );

  if (!hasData) {
    return <>{head}<Start accounts={accounts} strategy={strategy ?? null} hasTxn={positions.positions.length > 0} initBusy={initBusy}
      onAddAccount={() => setDrawer({ kind: "account" })} onInitStrategy={initStrategy} onAddTxn={() => setDrawer({ kind: "txn" })}
      onImport={() => setDrawer({ kind: "import", account: filter })} />{assetDrawer}{drawers}</>;
  }

  // ---- hero (home v3 Q7 + Q19): value | Od początku roku | Wynik niezrealizowany | Obsunięcie | Wpłaty ---------------
  const k = overview.kpis;
  const ytd = perfYtd.data;
  const ybStale = staleBenchmark(ytd?.benchmark);
  const yb = ytd?.benchmark?.status === "ok" && !ybStale ? ytd.benchmark : null;
  const week = perf1m.data ? weekMove(perf1m.data.points, perf1m.data.as_of) : null;
  const ddPts = perf1y.data?.points ?? [];
  const ddNow = ddPts.length ? ddPts[ddPts.length - 1].drawdown : null;
  const ddMax = perf1y.data?.summary?.max_drawdown?.depth ?? null;
  const planAmount = strategy?.facts?.contributions?.monthly_amount ?? null;
  const plan = planAmount != null ? { amount: planAmount, day: strategy?.facts?.contributions?.day_of_month ?? null } : null;
  const contrib = contributionFacts({
    months: monthlyFlows(ddPts, today, 12), deposits: ytd?.summary?.deposits ?? null, plan,
    firstDeposit: ddPts.find((p) => (p.flow ?? 0) > 0)?.date ?? null, today,
  });
  const hero = (
    <section className="w hero" aria-label="Wartość portfela">
      <div className="h1">
        <div className="l">Wartość portfela</div>
        <div className="v">{money(k.value.total, base)}</div>
        {week && <div className="d"><span className={week.money >= 0 ? "pos" : "neg"}>{money(week.money, base, true)}{week.pct != null ? ` (${pct(week.pct, true)})` : ""}</span> w tym tygodniu</div>}
      </div>
      <div className="hf">
        <Fact label="Od początku roku" value={ytd?.summary?.twr != null ? pct(ytd.summary.twr, true) : "-"} title={ybStale?.title}
          detail={ybStale ? ybStale.label : yb?.twr != null ? <>{benchmarkLabel(yb)} {pct(yb.twr, true)}{yb.excess_twr != null && <> · <span className={yb.excess_twr >= 0 ? "pos" : "neg"}>{pp(yb.excess_twr * 100)}</span></>}</> : ytd === null ? "brak historii" : undefined} />
        <Fact label="Wynik niezrealizowany" value={money0(k.unrealized.amount, base, true)} detail={k.unrealized.pct != null ? `${pct(k.unrealized.pct, true)} od kosztu` : "koszt nieznany"} />
        {/* The light grid keeps its Wpłaty widget: no duplicate facts there. */}
        {!light && ddNow != null && <Fact label="Obsunięcie" value={pct(ddNow)} detail={ddMax != null ? `maks. ${pct(ddMax)}` : undefined} title="Od szczytu, 12 mies." />}
        {!light && perf1y.data !== undefined && <Fact label="Wpłaty" value={contrib.deposits != null ? money0(contrib.deposits, base) : "-"} title="W tym roku"
          detail={contrib.planYtd != null ? `plan ${money0(contrib.planYtd, base)}${contrib.missed ? ` · ${contrib.missed} mies. bez wpłaty` : ""}` : "bez planu w strategii"} />}
      </div>
    </section>
  );

  // ---- grid ----------------------------------------------------------------------------------------------------
  const budgetOn = ctx.profile.modules.some((m) => m.id === "budget" && m.enabled);
  // Named by the signal's own title (instrument, bucket label, rule message), never the strategy's rule id (FE-A A6).
  const expired = (digest?.signals.resolved ?? []).filter((s) => s.status === "expired").map((s) => ({ title: s.instrument_label ?? signalText(s).title }));
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
    items.push({ id: "review", span: 3, node: <ReviewStrip digest={digest} step={step} onStep={onStep} decided={decided} total={signals.length} note={note} onNote={setNote} onDone={markDone} busy={doneFlight.busy} researchRan={research.ranInPeriod} /> });
    items.push({ id: "changes", span: 3, node: <ChangesWidget digest={digest} perf={perf1y.data} alerts={alerts} proposals={props.data ?? []} accounts={accounts} names={names}
      onSignals={() => onStep(1)} onProposal={(id) => setDrawer({ kind: "proposal", id })} onJournal={() => openJournal()} research={research.changesRow} /> });
    const rr = research.review(digest.since);
    if (rr) items.push(rr);
  }
  if (!reviewOpen && !reentry) items.push({ id: "hero", span: 3, node: hero });
  if (last?.status === "failed") {
    items.push({ id: "failed", span: 3, node: <Notice tone="neg" style={{ margin: 0 }}>Przebieg reguł nieudany{last.errors[0] ? `: ${runError(last.errors[0])}` : ""}. Sygnały z poprzedniego przebiegu.</Notice> });
  }
  const wSignals: GridItem = { id: "signals", span: 1, node: <SignalsRail signals={sig.data ? signals : null} ctx={signalsCtx} hl={reviewOpen && step === 1} focusId={focusSignal}
    paused={!!sigDialog} onAll={(focusId) => setSigDialog({ filter: "all", focusId: focusId ?? null })} /> };
  const wAlerts: GridItem = { id: "alerts", span: 1, node: <AlertsWidget slug={slug} alerts={alertsList} near={strategy?.facts?.alerts ?? null} onManage={() => go("alerts")} onNew={() => go("alerts?new=1")} onChanged={reload} /> };
  const wValue: GridItem = { id: "value", span: 2, node: <ValueChartWidget slug={slug} accounts={accountsFilter} nonce={nonce} initial={perf1y.loading ? undefined : perf1y.data} /> };
  const wAlloc: GridItem = { id: "alloc", span: 1, node: <AllocationWidget overview={overview} strategy={strategy ?? null} filtered={filter != null} wide today={today}
    view={allocView} onView={setAllocView} onAdd={() => setDrawer({ kind: "account" })} onReconcile={(id) => setDrawer({ kind: "import", account: id })} onAlias={alias}
    onSettings={() => ctx.go({ kind: "settings", section: "agent" })} /> };
  const wAssets: GridItem = { id: "assets", span: 2, node: <AssetList data={positions} accounts={accounts} signals={signals} alerts={alerts} strategy={strategy ?? null}
    onOpen={(id) => openAsset(id)} onAddTxn={() => setDrawer({ kind: "txn" })} onClassify={classify} slug={slug} watch={watchList}
    initialTab={route === "watch" ? "watch" : undefined} autoAdd={route === "watch"} onWatchChanged={reload} unread={unreadOf} /> };
  const wWatch: GridItem = { id: "watch", span: 1, node: <WatchlistWidget slug={slug} items={watchList} onChanged={reload} onOpen={(id) => openAsset(id)} autoAdd={route === "watch"} /> };
  const wContrib = (span: 1 | 2): GridItem => ({ id: "contrib", span, node: <ContributionsWidget perf={perf1y.loading ? undefined : perf1y.data} ytd={perfYtd.loading ? undefined : perfYtd.data} plan={plan ?? fallbackPlan()} today={today} fromBudget={budgetOn} /> });
  const wAccounts: GridItem = { id: "accounts", span: 1, node: <AccountsWidget overview={overview} strategy={strategy ?? null} today={today} onAdd={() => setDrawer({ kind: "account" })}
    onReconcile={(id) => setDrawer({ kind: "import", account: id })} onAlias={alias} onSettings={() => ctx.go({ kind: "settings", section: "agent" })} /> };
  if (light) {
    items.push(wContrib(2), wAccounts);
    if (watch.length || route === "watch") items.push(wWatch);
  } else {
    // Q13 / Q19: the research strip last; Obsunięcie and Wpłaty live in the hero, Rachunki in Alokacja,
    // Obserwowane in Aktywa.
    const split: GridItem = { id: "split", span: 3, node: <Split main={[wValue, wAlloc, wAssets]} rail={[wSignals, wAlerts]} /> };
    items.push(split);
    if (research.strip) items.push(research.strip);
  }
  return provide(
    <>
      {head}
      <Grid items={items.filter(Boolean) as GridItem[]} />
      {sigDialog && !light && (
        <SignalsDialog signals={signals} ctx={signalsCtx} filter={sigDialog.filter} focusId={sigDialog.focusId} review={reviewOpen} expired={expired}
          onHistory={() => openJournal()} onClose={() => setSigDialog(null)} />
      )}
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
            onDone={(ok, v) => { if (ok) shellStale.current = true; close(); toast(ok ? `Zatwierdzono propozycję${v ? ` · strategia v${v}` : ""}` : "Odrzucono propozycję", 3000); reload(); }} />
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
  const { slug, go } = useShell();
  const hasAccount = accounts.length > 0;
  const hasStrategy = !!strategy && strategy.state !== "missing";
  const weekday = strategy?.facts?.notifications.digest_weekday ?? "sunday";
  const steps: SetupStepItem[] = [
    {
      key: "account", status: hasAccount ? "done" : "on", title: "Rachunek maklerski",
      hint: hasAccount ? accounts.map((a) => `${accountLabel(a, accounts)} · ${a.currency}`).join(" · ") : "Broker + opakowanie (zwykłe, IKE, IKZE)",
      actions: <button className={`btn ${hasAccount ? "" : "primary"}`} onClick={onAddAccount}>{hasAccount ? "Dodaj kolejny" : "Dodaj rachunek"}</button>,
    },
    {
      key: "strategy", status: hasStrategy ? "done" : hasAccount ? "on" : "todo", title: "Strategia",
      tag: hasStrategy ? <Tag tone="pos">{strategy!.version != null ? `v${strategy!.version}` : "zapisana"}</Tag> : <Tag tone="info">zalecane</Tag>,
      hint: hasStrategy ? undefined : <><code>strategy.yaml</code> albo wywiad w Claude Code: <code>/investments-setup</code></>,
      actions: hasStrategy ? undefined : (
        <>
          <button className={`btn ${hasAccount ? "primary" : ""}`} onClick={onInitStrategy} disabled={initBusy}>{initBusy ? "Tworzę…" : "Utwórz z szablonu"}</button>
          <button className="btn" onClick={() => go({ kind: "setup", module: "investments" })}>Instrukcja Claude Code</button>
        </>
      ),
    },
    {
      key: "txn", status: hasTxn ? "done" : hasStrategy ? "on" : "todo", title: "Pierwsza wpłata lub zakup",
      hint: "Ręcznie albo import pliku od brokera.",
      actions: hasAccount ? <><button className="btn" onClick={onAddTxn}>Dodaj transakcję</button><button className="btn" onClick={onImport}>Import</button></> : undefined,
    },
    { key: "review", status: "todo", title: "Pierwszy przegląd", hint: `${(WEEKDAYS[weekday] ?? weekday).replace(/^./, (m) => m.toUpperCase())} · raz w tygodniu` },
  ];
  return (
    <Grid items={[
      {
        id: "start", span: 2, node: (
          <Widget title="Pierwsze kroki" body="tight">
            <SetupSteps steps={steps} />
            {!hasAccount && <Code cmd={`cashu --profile ${slug} invest accounts add "XTB IKE" --broker xtb --wrapper ike`} />}
          </Widget>
        ),
      },
      { id: "privacy", span: 1, node: <AgentWidget /> },
    ]} />
  );
}
