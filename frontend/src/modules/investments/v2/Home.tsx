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
import { INV_PROPOSAL_KINDS } from "../../../core/connectors";
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
import { Code, SetupSteps, type SetupStepItem, Seg, Skeleton, Tag, useToast } from "../../../ui";
import { Fact, Grid, type GridItem, Split, Widget } from "../../../widgets";
import {
  type CommitResult, deleteReview, getProposals, getStrategy, patchInstrument, type Position, postReview, postStrategyInit, postStrategyReload,
  type Thesis,
} from "../api";
import { AccountDrawer, ImportDrawer, ProposalDrawer, ThesisDrawer, TxnDrawer, TxnsDrawer } from "../Drawers";
import { storedKey, useStored } from "../hooks";
import { accountLabel, dm, hm, isGenericBucket, isoDate, money, money0, pct, pp, WEEKDAYS, wdm } from "../labels";
import { C } from "../../../common.strings.ts";
import { S } from "./Home.strings.ts";
import { runError } from "../logic";
import { makeUndo, UNDO_WINDOW_MS, undoMessage, undoSettled } from "../undo";
import { AlertsManager, AlertsWidget, type InstrumentChoice } from "./Alerts";
import type { Hint } from "../api";
import { accKey, dropInv, getAlerts, getDigestV2, getOverviewV2, getPerformance, getPositionsV2, getSignalsV2, getWatchlist, invKey, type PerfPoint } from "./api";
import { AssetDrawer } from "./AssetDrawer";
import { usePriceRefreshState } from "./priceRefresh";
import { useRunState } from "./runState";
import { AssetDetail, assetName } from "./AssetPage";
import { Journal } from "./Journal";
import {
  benchmarkLabel, contributionFacts, daysSince, instName, monthlyFlows, nextWeekday, planForMonth, signalLinkTarget, signalPlace, signalText,
  staleBenchmark,
} from "./logic";
import { usePlannedDeposits } from "./Overview";
import { ContributionsWidget, ValueChartWidget } from "./Perf";
import { AccountsWidget, type AllocView, AllocationWidget, AssetList } from "./Portfolio";
import { useResearchHome } from "./research";
import { canonKey, isSegment } from "./research/segments";
import { isMacroKey } from "./research/macro";
import { type DeckStats, ReviewButton, ReviewDeck, useReviewDeckData } from "./ReviewDeck";
import { type SignalFilter, type SignalsCtx, SignalsDialog, SignalsRail } from "./Signals";
import { WatchlistWidget } from "./Watchlist";
import { readStored } from "../../../core/storage.ts";

type DrawerState =
  | { kind: "import"; account?: number | null }
  | { kind: "txn"; instrumentId?: number | string | null; type?: string }
  | { kind: "account" }
  | { kind: "thesis"; instrumentId: number; label: string; thesis: Thesis | null }
  | { kind: "proposal"; id: number }
  | { kind: "txns"; position: Position };

const ss = {
  get: (k: string) => { try { return readStored(sessionStorage, k); } catch { return null; } },
  set: (k: string, v: string | null) => { try { if (v == null) sessionStorage.removeItem(k); else sessionStorage.setItem(k, v); } catch { /* ignore */ } },
};

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
  // P9: a topic (or a macro regime) opens in the same drawer panel (`topics/<key>`), never the research page.
  const topicRoute = /^topics\/([a-z0-9_]+)$/.exec(route ?? "");
  const topicKey = topicRoute ? topicRoute[1] : null;
  const openTopic = useCallback((key: string) => goKeep(`topics/${encodeURIComponent(key)}`), [goKeep]);
  const openJournal = useCallback((instrument?: number | string | null) => go(instrument != null ? `journal?instrument=${instrument}` : "journal"), [go]);

  const [filter, setFilter] = useStored<number | null>(storedKey("filter", slug), null);
  // The review note draft stays in this window only (it may hold amounts); an old localStorage copy is dropped.
  const [note, setNote] = useStored<string>(storedKey("reviewNote", slug), "", "session");
  useEffect(() => { try { localStorage.removeItem(storedKey("reviewNote", slug)); } catch { /* ignore */ } }, [slug]);
  const [nonce, setNonce] = useState(0);
  const priceRefresh = usePriceRefreshState(slug); // P10: driven by the header tag, re-reads land through revalidate
  const runState = useRunState(slug); // P10: the automatic daily check (no button), from the pushed run events
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
  const [initBusy, setInitBusy] = useState(false);

  // A remembered filter that no longer names one of this profile's accounts falls back to all accounts.
  useEffect(() => {
    if (filter == null) return;
    // useAsync keeps the Polish label of a coded error (404 `not_found`), else the English detail.
    const gone = ov.error ? ov.error === label("error.not_found") || /brokerage account|account id/i.test(ov.error) : ov.data ? !ov.data.accounts.some((a) => a.id === filter) : false;
    if (gone) setFilter(null);
  }, [ov.error, ov.data]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- review strip ------------------------------------------------------------------------------------------
  const reviewKey = `cashu.inv.reviewOpen.${slug}`;
  const [reviewOpen, setReviewOpenState] = useState(() => ss.get(reviewKey) === "1" || params.get("review") === "1");
  const setReviewOpen = (v: boolean) => { setReviewOpenState(v); ss.set(reviewKey, v ? "1" : "0"); };
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
      toast(S.signalClosed(t.status), 4000);
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
  const initStrategy = async () => {
    setInitBusy(true);
    try {
      await postStrategyInit(slug);
      await postStrategyReload(slug).catch(() => null);
      toast(S.strategyFromTemplate, 4000);
      reload();
    } catch (e) { toast(S.strategyFailed(errorText(e)), 4000); } finally { setInitBusy(false); }
  };
  const classify = async (i: { id: number | string }, patch: { asset_class: string; region: string | null; valuation_mode: string; tags: string[] }) => {
    try { await patchInstrument(slug, i.id, patch); toast(S.classificationSaved, 2500); reload(); }
    catch (e) { toast(S.saveFailed(errorText(e)), 4000); throw e; }
  };
  const alias = async (instrumentId: string, yahoo: string) => {
    try { await patchInstrument(slug, instrumentId, { aliases: [{ namespace: "yahoo", value: yahoo }] }); toast(S.aliasSaved, 3000); reload(); }
    catch (e) { toast(S.aliasFailed(errorText(e)), 4000); throw e; }
  };
  const scrollTo = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
  const openReview = () => { setReviewOpen(true); started.current ??= Date.now(); };
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
  // The deck's cards, verdicts and the agenda for the research agent go with the review (stats.deck; MCP
  // research_context.owner_review).
  const markDone = (deck?: DeckStats) => doneFlight.run(async () => {
    const minutes = started.current ? Math.max(1, Math.round((Date.now() - started.current) / 60000)) : null;
    const text = note.trim() || null;
    try {
      const rv = await postReview(slug, text, { open_signals: signals.length, decided, ...(minutes ? { minutes } : {}), ...(deck ? { deck } : {}) });
      setReviewOpen(false);
      setDoneLocal(rv.done_at ?? new Date().toISOString());
      setNote("");
      started.current = null;
      reload();
      const u = rv.id != null ? makeUndo(Date.now(), () => deleteReview(slug, rv.id!)) : null;
      const retry = () => {
        if (!u) return;
        void u.undo().then((res) => {
          const msg = undoMessage(res, S.reviewNoun);
          if (res !== "failed" && res !== "busy") setReviewUndo(null);
          if (undoSettled(res)) { setDoneLocal(null); setReviewOpen(true); setNote(text ?? ""); reload(); }
          if (msg) toast(msg, res === "failed" ? 8000 : 3000, res === "failed" ? { label: C.undo, onClick: retry } : undefined);
        });
      };
      setReviewUndo(u ? () => retry : null);
      toast(S.reviewSaved(dm(digest?.review?.next_on ?? nextWeekday(today, weekday))), 10000, u ? { label: C.undo, onClick: retry } : undefined);
    } catch (e) {
      toast(e instanceof ApiError && e.status === 404 ? S.reviewsUnsupported : S.reviewFailed(errorText(e)), 5000);
    }
  });

  const names = new Map((positions?.positions ?? []).map((p) => [Number(p.instrument.id), instName(p.instrument)] as [number, string]));
  for (const w of watch) if (w.instrument) names.set(w.instrument_id, instName(w.instrument));
  // The review deck's data (cards counted on the hero's review button; the calendar only once it is open).
  const deckData = useReviewDeckData({
    slug, nonce, digest, perfWeek: perf1m.loading ? undefined : perf1m.data, perfYear: perf1y.loading ? undefined : perf1y.data,
    signals, proposals: props.data ?? [], names, open: reviewOpen,
  });
  // Research layer (F6, v2/research): strip, review block, research view, note links; nothing before the first run.
  const research = useResearchHome({
    slug, nonce, today, privacy: ctx.profile.mcp_privacy, positions: positions?.positions ?? [], watch, strategyVersion: strategy?.version ?? null, digest,
    go, openAsset: (id, noteId) => goKeep(`assets/${id}${noteId != null ? `?note=${noteId}` : ""}`), openTopic, onSettings: () => ctx.go({ kind: "settings", section: "agent" }), onChanged: reload,
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
    // A segment (or macro) note's signal opens the topic drawer (P9); an old theme signal the plain research page.
    onOpenNote: (id, noteId, segment) => (id != null ? goKeep(`assets/${id}${noteId != null ? `?note=${noteId}` : ""}`)
      : segment && (isSegment(segment) || isMacroKey(segment)) ? openTopic(isMacroKey(segment) ? segment : canonKey(segment)!) : go("research")),
  };

  // ---- render --------------------------------------------------------------------------------------------------
  const err = ov.error || pos.error;
  if (err && !overview) return <div className="err">{S.error(String(err))}</div>;
  if (!overview || !positions) {
    return (
      <>
        <div className="pagehead"><h2 className="ph">{S.investments}</h2><Skeleton w={320} h={26} /><span className="spacer" /><Skeleton w={260} h={26} /></div>
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
      onThesis={(inst, t) => setDrawer({ kind: "thesis", instrumentId: inst.id, label: inst.label, thesis: t })}
      onJournal={() => openJournal(id)}
      onAlerts={() => go(`alerts?instrument=${id}`)}
      onAlertsChanged={reload} />
  );
  if (assetId != null && assetPage) {
    const nm = assetName(slug, assetId, positions.positions, watch);
    return provide(
      <>
        <nav className="crumb" aria-label={S.breadcrumb}><button onClick={() => go()}>{S.investments}</button> › <button onClick={() => go()}>{S.assets}</button> › <span>{nm}</span>
          <span style={{ flex: 1 }} /><button className="lnk" onClick={() => go(`assets/${assetId}`)}>{S.openInPanel}</button></nav>
        {assetDetail(assetId, "page")}
        {drawers}
      </>
    );
  }
  const assetDrawer = assetId != null && (
    <AssetDrawer name={assetName(slug, assetId, positions.positions, watch)} onClose={() => goKeep()} onPage={() => go(`assets/${assetId}?page=1`)}
      onCrumb={(where) => { goKeep(); if (where === "assets") setTimeout(() => scrollTo("inv-assets"), 60); }}>
      {assetDetail(assetId, "drawer")}
    </AssetDrawer>
  ) || (topicKey != null && (
    <AssetDrawer {...research.topicCrumb(topicKey)} onClose={() => goKeep()}
      onCrumb={(where) => { goKeep(); if (where === "assets") setTimeout(() => scrollTo("inv-research"), 60); }}>
      {research.topic(topicKey)}
    </AssetDrawer>
  ));

  const fr = overview.freshness;
  const stale = fr.prices.stale_count;
  const last = overview.kpis.last_run;
  const runAt = last ? (last.finished_at ?? last.started_at) : null;
  const runDay = runAt ? (localDay(runAt) === today ? S.today : dm(runAt)) : null;
  const head = (
    <div className="pagehead">
      <h2 className="ph">{S.investments}</h2>
      {accounts.length > 1 && (
        <Seg<number | null> quiet label={S.account} value={filter} onChange={setFilter}
          items={[[S.all, null], ...accounts.map((a) => [accountLabel(a, accounts), a.id] as [string, number])]} />
      )}
      {hasData && (priceRefresh.running ? <Tag>{S.refreshingPrices}</Tag>
        : fr.prices.newest_bar ? <Tag title={S.newestQuote}>{S.prices(wdm(fr.prices.newest_bar))}</Tag> : <Tag>{S.noQuotes}</Tag>)}
      {stale > 0 && <button className="tag warn" style={{ background: "transparent", cursor: "pointer", font: "inherit", fontSize: 11 }}
        title={fr.prices.stale.map((s) => `${s.label}: ${s.price_date ? S.lastQuote(dm(s.price_date)) : S.noQuotes}`).join("\n")}
        onClick={() => { setAllocView("accounts"); setTimeout(() => scrollTo(light ? "inv-accounts" : "inv-alloc"), 30); }}>{S.staleCount(stale)}</button>}
      {/* The daily check runs on its own (P10): its state shows only when it runs or is not ok (home v3 Q7). */}
      {hasData && (runState.running ? <Tag title={S.runTitle}>{S.rulesRunning}</Tag>
        : last?.status === "partial" ? <span className="tag warn" title={`${runDay} ${hm(runAt!)}${last.errors[0] ? ` · ${runError(last.errors[0])}` : ""}`}>{S.rulesPartial}</span>
        : last?.status === "failed" ? <span className="tag warn" title={`${runDay} ${hm(runAt!)}${last.errors[0] ? ` · ${runError(last.errors[0])}` : ""}${S.previousRunSignals}`}>{S.rulesFailed}</span>
        : !last ? <span className="tag">{S.rulesNeverRan}</span> : null)}
      <span className="spacer" />
      <button className="btn" onClick={() => setDrawer({ kind: "import", account: filter })}>{S.import}</button>
      {!hasData && <button className="btn" onClick={() => setDrawer({ kind: "txn" })}>{S.addTxn}</button>}
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
  // The review's only entry: a round button at the hero's right, the deck's card count as a badge while due;
  // "cofnij" next to it for the server's undo window.
  const reviewSlot = hasData && digest ? (
    <div className="rv-slot">
      {doneLocal && !due && reviewUndo && <button className="lnk" style={{ fontSize: 12 }} onClick={reviewUndo}>{S.undoLower}</button>}
      <ReviewButton name={digest.review?.name ?? S.weeklyReview} due={due} count={deckData.live.cards.length}
        last={doneLocal ?? digest.last_review?.done_at ?? null} next={digest.review?.next_on ?? null} onOpen={openReview} />
    </div>
  ) : null;
  const hero = (
    <section className="w hero" aria-label={S.portfolioValue}>
      <div className="h1">
        <div className="l">{S.portfolioValue}</div>
        <div className="v">{money(k.value.total, base)}</div>
        {week && <div className="d"><span className={week.money >= 0 ? "pos" : "neg"}>{money(week.money, base, true)}{week.pct != null ? ` (${pct(week.pct, true)})` : ""}</span>{S.thisWeek}</div>}
      </div>
      <div className="hf">
        <Fact label={S.ytd} value={ytd?.summary?.twr != null ? pct(ytd.summary.twr, true) : "-"} title={ybStale?.title}
          detail={ybStale ? ybStale.label : yb?.twr != null ? <>{benchmarkLabel(yb)} {pct(yb.twr, true)}{yb.excess_twr != null && <> · <span className={yb.excess_twr >= 0 ? "pos" : "neg"}>{pp(yb.excess_twr * 100)}</span></>}</> : ytd === null ? S.noHistory : undefined} />
        <Fact label={S.unrealized} value={money0(k.unrealized.amount, base, true)} detail={k.unrealized.pct != null ? S.vsCost(pct(k.unrealized.pct, true)) : S.costUnknown} />
        {/* The light grid keeps its Wpłaty widget: no duplicate facts there. */}
        {!light && ddNow != null && <Fact label={S.drawdown} value={pct(ddNow)} detail={ddMax != null ? S.max(pct(ddMax)) : undefined} title={S.drawdownTitle} />}
        {!light && perf1y.data !== undefined && <Fact label={S.contributions} value={contrib.deposits != null ? money0(contrib.deposits, base) : "-"} title={S.thisYear}
          detail={contrib.planYtd != null ? `${S.plan(money0(contrib.planYtd, base))}${contrib.missed ? S.missedMonths(contrib.missed) : ""}` : S.noPlan} />}
      </div>
      {reviewSlot}
    </section>
  );

  // ---- grid ----------------------------------------------------------------------------------------------------
  const budgetOn = ctx.profile.modules.some((m) => m.id === "budget" && m.enabled);
  // Named by the signal's own title (instrument, bucket label, rule message), never the strategy's rule id (FE-A A6).
  const expired = (digest?.signals.resolved ?? []).filter((s) => s.status === "expired").map((s) => ({ title: s.instrument_label ?? signalText(s).title }));
  const items: (GridItem | false)[] = [];
  items.push({ id: "hero", span: 3, node: hero });
  const wSignals: GridItem = { id: "signals", span: 1, node: <SignalsRail signals={sig.data ? signals : null} ctx={signalsCtx} hl={false} focusId={focusSignal}
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
    const split: GridItem = { id: "split", span: 3, node: <Split main={[wValue, wAlloc, wAssets]} rail={[wSignals, wAlerts, ...(research.candidates ? [research.candidates] : [])]} /> };
    items.push(split);
    if (research.strip) items.push(research.strip);
  }
  return provide(
    <>
      {head}
      <Grid items={items.filter(Boolean) as GridItem[]} />
      {reviewOpen && digest && hasData && (
        <ReviewDeck slug={slug} data={deckData} digest={digest} perfWeek={perf1m.loading ? undefined : perf1m.data} busy={doneFlight.busy} suspended={drawer != null} note={note} onNote={setNote}
          onClose={() => setReviewOpen(false)} onDone={markDone} onChanged={reload} onOpenProposal={(id) => setDrawer({ kind: "proposal", id })} />
      )}
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
            onDone={(r: CommitResult) => { toast(S.imported(r.inserted, r.planned_booked?.length ?? 0), 3500); shellStale.current = true; reload(); }}
            onAddAccount={() => setDrawer({ kind: "account" })} onManual={() => setDrawer({ kind: "txn" })}
            onClassify={() => { close(); setTimeout(() => scrollTo("inv-assets"), 50); }} />
        );
      case "txn":
        return (
          <TxnDrawer slug={slug} accounts={accounts} positions={list} preset={{ instrumentId: drawer.instrumentId ?? null, type: drawer.type, accountId: filter }}
            onClose={close} onSaved={(w) => { shellStale.current = true; close(); toast(w.length ? S.txnSavedWarn(w[0]) : S.txnSaved, w.length ? 5000 : 2500); reload(); }} />
        );
      case "account":
        return <AccountDrawer slug={slug} onClose={close} onSaved={(a) => { shellStale.current = true; close(); toast(S.accountAdded(a.name), 2500); reload(); }} />;
      case "thesis":
        return <ThesisDrawer slug={slug} instrumentId={drawer.instrumentId} label={drawer.label} thesis={drawer.thesis} onClose={close} onSaved={() => { close(); toast(S.thesisSaved, 2000); reload(); }} />;
      case "proposal":
        return (
          <ProposalDrawer slug={slug} id={drawer.id} version={strategy?.version ?? null} onClose={close} onChanged={reload}
            onDone={(ok, v) => { if (ok) shellStale.current = true; close(); toast(ok ? S.proposalApproved(v) : S.proposalRejected, 3000); reload(); }} />
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
      key: "account", status: hasAccount ? "done" : "on", title: S.brokerageAccount,
      hint: hasAccount ? accounts.map((a) => `${accountLabel(a, accounts)} · ${a.currency}`).join(" · ") : S.brokerWrapper,
      actions: <button className={`btn ${hasAccount ? "" : "primary"}`} onClick={onAddAccount}>{hasAccount ? S.addAnother : S.addAccount}</button>,
    },
    {
      key: "strategy", status: hasStrategy ? "done" : hasAccount ? "on" : "todo", title: S.strategy,
      tag: hasStrategy ? <Tag tone="pos">{strategy!.version != null ? `v${strategy!.version}` : S.saved}</Tag> : <Tag tone="info">{S.recommended}</Tag>,
      hint: hasStrategy ? undefined : <><code>strategy.yaml</code>{S.orInterview}<code>/investments-setup</code></>,
      actions: hasStrategy ? undefined : (
        <>
          <button className={`btn ${hasAccount ? "primary" : ""}`} onClick={onInitStrategy} disabled={initBusy}>{initBusy ? S.creating : S.fromTemplate}</button>
          <button className="btn" onClick={() => go({ kind: "setup", module: "investments" })}>{S.claudeGuide}</button>
        </>
      ),
    },
    {
      key: "txn", status: hasTxn ? "done" : hasStrategy ? "on" : "todo", title: S.firstTxn,
      hint: S.firstTxnHint,
      actions: hasAccount ? <><button className="btn" onClick={onAddTxn}>{S.addTxn}</button><button className="btn" onClick={onImport}>{S.import}</button></> : undefined,
    },
    { key: "review", status: "todo", title: S.firstReview, hint: S.weekly((WEEKDAYS[weekday] ?? weekday).replace(/^./, (m) => m.toUpperCase())) },
  ];
  return (
    <Grid items={[
      {
        id: "start", span: 2, node: (
          <Widget title={S.firstSteps} body="tight">
            <SetupSteps steps={steps} />
            {!hasAccount && <Code cmd={`cashu --profile ${slug} invest accounts add "XTB IKE" --broker xtb --wrapper ike`} />}
          </Widget>
        ),
      },
      { id: "privacy", span: 1, node: <AgentWidget /> },
    ]} />
  );
}
