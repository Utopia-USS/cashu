// The investments Home screen hook (ab24ab6 v2/Home.tsx InvestmentsV2): every piece of UI state of the page (the
// account filter and chart range from the route, the allocation view, the assets tab, the open drawer, the
// review deck, the candidate row whose criteria are open), the reads (useInvestmentsHomeData), the deck's data
// (the hero badge and the rail need it) and the writes with their toasts. Navigation comes in as callbacks.
import { C } from "@cashu/i18n/core/common.strings";
import { S as UI } from "@cashu/i18n/core/ui.strings";
import { S as U } from "@cashu/i18n/investments/undo.strings";
import { S } from "@cashu/i18n/investments/v2/Home.strings";
import { useToast } from "@cashu/ui";
import { dm } from "@cashu/ui-logic/investments/labels";
import type { AccountRow, Position, Thesis } from "@cashu/ui-logic/investments/types";
import {
  type InstLike,
  instName,
  nextWeekday,
  type SignalFilter,
  signalText,
} from "@cashu/ui-logic/investments/v2/logic";
import { isMacroKey } from "@cashu/ui-logic/investments/v2/research/macro";
import { canonKey, isSegment } from "@cashu/ui-logic/investments/v2/research/segments";
import type { CardId } from "@cashu/ui-logic/investments/v2/reviewDeckLogic";
import type { PerfRange } from "@cashu/ui-logic/investments/v2/types";
import { startTransition, useEffect, useRef, useState } from "react";
import { useNarrowFrame } from "../../../shell/narrowFrame.js";
import { reviewSlotModel } from "../../review/deck/reviewSlotModel.js";
import {
  type DeckStats,
  useReviewDeckCommands,
  useReviewDeckData,
} from "../../review/deck/useReviewDeckData.js";
import type { SignalsDialogInput } from "../../signals/SignalsDialogScreen.js";
import type { SignalsSubPage } from "../../signals/SignalsPageScreen.js";
import { useDisplayClock } from "../../signals/useDisplayClock.js";
import { useUnwatch } from "../../signals/WatchlistScreens.js";
import type {
  AccountDrawerInput,
  ThesisDrawerInput,
  TxnDrawerInput,
  TxnsDrawerInput,
} from "../drawers/useInvestmentDrawers.js";
import { hasDataOf, headModel, heroModel, lightOf, startModel } from "./homeModel.js";
import { gidOf, legacyIdOf } from "./legacyWire.js";
import {
  alertsBriefProps,
  candidatesRailProps,
  signalsBriefProps,
  watchedOf,
} from "./railModel.js";
import { useInvestmentsHomeCommands, useInvestmentsHomeData } from "./useInvestmentsHomeData.js";
import type { AllocView } from "./widgets/allocationModel.js";
import type { AssetsTab } from "./widgets/assetListModel.js";
import { useHomeWidgetsState } from "./widgets/useHomeWidgetsState.js";

/** The one drawer over the Home (old Home.tsx DrawerState; the proposal drawer is the route's). */
type DrawerState =
  | { kind: "txn"; instrumentId?: number | string | null; type?: string }
  | { kind: "account" }
  | { kind: "thesis"; instrumentId: number | string; label: string; thesis: Thesis | null }
  | { kind: "txns"; position: Position };

/** The review undo stays next to the review button for the server's 15 minutes (old UNDO_WINDOW_MS). */
const UNDO_WINDOW_MS = 15 * 60 * 1000;

export interface InvestmentsHomeOptions {
  /** The profile slug (the Start command line). */
  readonly slug: string;
  /** The account filter as a gid (route search `account`). */
  readonly account: string | null;
  /** ValueChartWidget's range (route search `period`). */
  readonly range: PerfRange;
  /** The review deck is open (route search `review=1`). */
  readonly review: boolean;
  readonly signalsOpen?: boolean;
  readonly signalFocusId?: string;
  onAccountPicked?(gid: string | null): void;
  onRangePicked?(range: PerfRange): void;
  onReviewOpened?(): void;
  onReviewClosed?(): void;
  /** The asset drawer over the Home (`assets/{gid}`), at a research note (`?note=`) when given. */
  openPage?(gid: string, note?: string): void;
  onSignalsPageOpened?(page: SignalsSubPage): void;
  onSignalsClosed?(): void;
  /** The research page in place of the grid (old sub-route `research?tab=`), a note opened in Notatki. */
  onResearchOpened?(tab?: string, note?: string): void;
  /** The research page of the route (old `research`): its `?tab=` and an opened note. */
  readonly research?: { tab?: string; note?: string | null } | null;
  /** The topic drawer over the Home (old `topics/<key>`): a segment key or a macro regime's `macro_<key>`. */
  readonly topic?: string | null;
  onTopicOpened?(key: string): void;
  onTopicClosed?(): void;
  onProposalOpened?(gid: string, onResumed: () => void): boolean;
  onSetupOpened?(): void;
  onSettingsOpened?(): void;
  /** The asset of the route (`assets/{gid}`): its drawer over the Home, or its page with `page`. */
  readonly instrument?: string;
  /** `?page=1`: the asset page replaces the grid (old Home.tsx:412). */
  readonly page?: boolean;
  /** `?note=`: a research note of the asset to open and highlight. */
  readonly noteGid?: string | null;
  /** Close the asset drawer / leave the page (back to `investments.portfolio`). */
  onAssetClosed?(): void;
  /** `otwórz jako stronę`: `assets/{gid}?page=1`. */
  onAssetPageOpened?(gid: string): void;
  /** `investments.watchlist` (old sub-route `watch`): Aktywa on the Obserwowane tab with the search open. */
  readonly watch?: boolean;
  /** The header tag's `?alloc=accounts&t=` (a new value per click): Alokacja on its Rachunki view. */
  readonly allocRequest?: number | null;
  /** The decision journal for one instrument (old `journal?instrument=id`). */
  onJournalOpened?(instrument: string): void;
}

export function useInvestmentsHomeScreen(o: InvestmentsHomeOptions) {
  const toast = useToast();
  const filter = legacyIdOf(o.account);
  const data = useInvestmentsHomeData({ filter, chartRange: o.range });
  const commands = useInvestmentsHomeCommands(data);
  const deckCommands = useReviewDeckCommands();
  const widgets = useHomeWidgetsState({ adding: !!o.watch });
  const displayNow = useDisplayClock(data.today);
  // The signals dialog (old Home.tsx sigDialog): the rail's `Wszystkie`, the route's `signals=1` and a
  // notification (its signal focused) open it.
  const [sigDialog, setSigDialog] = useState<{
    filter: SignalFilter;
    focusId: string | number | null;
  } | null>(null);
  // The route flag opens it too (closing it clears the flag).
  const dialog =
    sigDialog ??
    (o.signalsOpen ? { filter: "all" as const, focusId: o.signalFocusId ?? null } : null);

  // Alokacja's view (home v3 Q2): the page owns it so the stale-prices tag can land on Rachunki.
  // The header tag (`?alloc=accounts`) lands on Rachunki, again on every click (a new `t`).
  const [allocView, setAllocView] = useState<AllocView | null>(
    o.allocRequest != null ? "accounts" : null,
  );
  const [allocSeen, setAllocSeen] = useState(o.allocRequest ?? null);
  if ((o.allocRequest ?? null) !== allocSeen) {
    setAllocSeen(o.allocRequest ?? null);
    if (o.allocRequest != null) setAllocView("accounts");
  }
  const [assetTab, setAssetTab] = useState<AssetsTab>(o.watch ? "watch" : "positions");
  const [drawer, setDrawer] = useState<DrawerState | null>(null);
  // A proposal opened from a deck card lies over the Home (route drawer): the deck hides meanwhile.
  const [proposalOpen, setProposalOpen] = useState(false);
  const [why, setWhy] = useState<number | null>(null);
  // The review note draft stays in this window only (it may hold amounts).
  const [note, setNote] = useState("");
  const [doneLocal, setDoneLocal] = useState<string | null>(null);
  const [reviewUndo, setReviewUndo] = useState<(() => void) | null>(null);
  const [saving, setSaving] = useState(false);
  const started = useRef<number | null>(null);
  useEffect(() => {
    if (o.review) started.current ??= Date.now();
  }, [o.review]);
  useEffect(() => {
    if (!reviewUndo) return;
    const t = setTimeout(() => setReviewUndo(null), UNDO_WINDOW_MS);
    return () => clearTimeout(t);
  }, [reviewUndo]);

  const overview = data.ov.data;
  const positions = data.pos.data;
  const accounts = (overview?.accounts ?? []) as AccountRow[];
  const today = overview?.as_of ?? data.today;
  const base = overview?.base_currency ?? "PLN";
  const strategy = data.strat.data;
  const digest = data.dig.data;
  const weekday =
    digest?.digest_weekday ?? strategy?.facts?.notifications.digest_weekday ?? "sunday";
  const due = doneLocal ? false : !!digest?.review_due;
  const hasData = hasDataOf(positions);
  const watch = data.watchQ.data ?? [];
  // The watch row's X with the undo (re-add), old removeWatchWithUndo.
  const unwatch = useUnwatch(watch);
  // A list that never loaded reads as empty (as the old `.catch(() => [])` did).
  const alertsList = data.alertsQ.data ?? (data.alertsQ.error ? [] : null);

  const names = new Map<number, string>();
  const insts = new Map<number, InstLike>();
  for (const p of positions?.positions ?? []) {
    names.set(Number(p.instrument.id), instName(p.instrument));
    insts.set(Number(p.instrument.id), p.instrument);
  }
  for (const w of watch)
    if (w.instrument) {
      names.set(w.instrument_id, instName(w.instrument));
      insts.set(w.instrument_id, w.instrument);
    }
  const deckData = useReviewDeckData({
    digest,
    perfWeek: data.perf1m.data,
    perfYear: data.perf1y.data,
    signals: data.signals,
    proposals: data.props.data ?? [],
    names,
    open: o.review,
  });

  // Minimal profile density (Home.tsx:204-205): the light grid in the narrow frame (also under its asset drawer
  // and on the watch route); the asset page asks for the frame through its route.
  const light = lightOf({
    positions,
    signals: data.signals.length,
    alerts: (alertsList ?? []).length,
    perf1y: data.perf1y.data,
    overview,
    today,
  });
  const homeLike = !o.research && !o.topic && !(o.instrument && o.page);
  useNarrowFrame(light && homeLike);

  // ---- navigation ------------------------------------------------------------------------------------------
  const openAsset = (id: number | string, noteId?: number | string | null) => {
    const gid = gidOf(id);
    if (gid !== null) o.openPage?.(gid, gidOf(noteId) ?? undefined);
  };
  // Old ctx.onOpenNote: the asset at the note, a topic (or macro) note's signal the topic drawer, else the
  // research page.
  const openNote = (instrument: string | null, note: string | null, segment: string | null) => {
    if (instrument) o.openPage?.(instrument, note ?? undefined);
    else if (segment && (isSegment(segment) || isMacroKey(segment)))
      o.onTopicOpened?.(isMacroKey(segment) ? segment : (canonKey(segment) ?? segment));
    else o.onResearchOpened?.();
  };
  const openReview = () => {
    started.current ??= Date.now();
    o.onReviewOpened?.();
  };
  const scrollTo = (id: string) =>
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });

  // ---- writes ----------------------------------------------------------------------------------------------
  const initStrategy = async () => {
    const failure = await commands.initStrategy();
    toast(failure === null ? S.strategyFromTemplate : S.strategyFailed(failure), 4000);
  };
  /** "Zamknij przegląd" (Home.tsx markDone): save, close the deck, toast with undo, keep the slot's undo link. */
  const markDone = async (input: { deck: DeckStats; skipped: { id: CardId; why: string }[] }) => {
    if (saving) return;
    setSaving(true);
    const text = note.trim();
    try {
      const r = await deckCommands.markDone({ ...input, notes: note, startedAt: started.current });
      if ("error" in r) {
        toast(S.reviewFailed(r.error), 5000);
        return;
      }
      o.onReviewClosed?.();
      setDoneLocal(r.done_at);
      setNote("");
      started.current = null;
      const retry = () => {
        void deckCommands.undoReview(r.id).then((failure) => {
          if (failure === null) {
            setReviewUndo(null);
            setDoneLocal(null);
            setNote(text);
            openReview();
            toast(U.done(S.reviewNoun), 3000);
          } else toast(U.failed(S.reviewNoun), 8000, { label: C.undo, onClick: retry });
        });
      };
      setReviewUndo(() => retry);
      toast(S.reviewSaved(dm(digest?.review?.next_on ?? nextWeekday(today, weekday))), 10000, {
        label: C.undo,
        onClick: retry,
      });
    } finally {
      setSaving(false);
    }
  };

  // ---- drawers (Home.tsx renderDrawer) ----------------------------------------------------------------------
  const close = () => setDrawer(null);
  const list = positions?.positions ?? [];
  const txnDrawer: TxnDrawerInput | null =
    drawer?.kind === "txn"
      ? {
          accounts,
          positions: list,
          preset: {
            instrumentId: drawer.instrumentId ?? null,
            type: drawer.type,
            accountId: filter,
          },
          today: data.today,
          onClose: close,
          onSaved: (w) => {
            close();
            toast(w[0] ? S.txnSavedWarn(w[0]) : S.txnSaved, w.length ? 5000 : 2500);
          },
        }
      : null;
  const accountDrawer: AccountDrawerInput | null =
    drawer?.kind === "account"
      ? {
          onClose: close,
          onSaved: (a) => {
            close();
            toast(S.accountAdded(a.name), 2500);
          },
        }
      : null;
  const thesisDrawer: ThesisDrawerInput | null =
    drawer?.kind === "thesis"
      ? {
          instrumentId: drawer.instrumentId,
          label: drawer.label,
          thesis: drawer.thesis,
          onClose: close,
          onSaved: () => {
            close();
            toast(S.thesisSaved, 2000);
          },
        }
      : null;
  const txnsDrawer: TxnsDrawerInput | null =
    drawer?.kind === "txns"
      ? {
          position: drawer.position,
          accounts,
          onClose: close,
          onAdd: () => setDrawer({ kind: "txn", instrumentId: drawer.position.instrument.id }),
        }
      : null;

  // ---- models ----------------------------------------------------------------------------------------------
  const err = data.ov.error || data.pos.error;
  const phase: "error" | "start" | "home" =
    !overview || !positions ? "error" : hasData ? "home" : "start";
  const head = overview
    ? headModel({ overview, filter, hasData, today, running: data.running })
    : null;
  const reviewSlot =
    hasData && digest
      ? reviewSlotModel({
          name: digest.review?.name ?? null,
          due,
          count: deckData.live.cards.length,
          decide: deckData.live.decide,
          last: doneLocal ?? digest.last_review?.done_at ?? null,
          next: digest.review?.next_on ?? null,
          onOpen: openReview,
          onUndo: doneLocal && !due && reviewUndo ? reviewUndo : null,
        })
      : null;

  return {
    phase,
    error: err ? String(err) : "",
    data,
    head,
    onAccount: (id: number | null) =>
      startTransition(() => o.onAccountPicked?.(id == null ? null : gidOf(id))),
    onStale: () => {
      setAllocView("accounts");
      setTimeout(() => scrollTo(light ? "inv-accounts" : "inv-alloc"), 30);
    },
    onAddTxn: () => setDrawer({ kind: "txn" }),
    onAddAccount: () => setDrawer({ kind: "account" }),
    hero:
      phase === "home" && overview
        ? heroModel({
            overview,
            base,
            today,
            perf1y: data.perf1y.data,
            perfYtd: data.perfYtd.data,
            perf1m: data.perf1m.data,
            strategy,
            light,
          })
        : null,
    light,
    reviewSlot,
    start:
      phase === "start"
        ? startModel({
            slug: o.slug,
            accounts,
            strategy: strategy ?? null,
            hasTxn: (positions?.positions.length ?? 0) > 0,
            initBusy: commands.initBusy,
            onAddAccount: () => setDrawer({ kind: "account" }),
            onInitStrategy: () => void initStrategy(),
            onGuide: () => o.onSetupOpened?.(),
            onAddTxn: () => setDrawer({ kind: "txn" }),
          })
        : null,
    onCopy: (command: string) => {
      void navigator.clipboard?.writeText(command).then(() => toast(UI.copied, 1500));
    },
    onSettings: () => o.onSettingsOpened?.(),
    // ---- the rail ----
    signals: signalsBriefProps({
      items: deckData.live.rail,
      total: data.signals.length,
      loading: !data.sig.data || !deckData.ready,
      lastReviewAt: doneLocal ?? digest?.last_review?.done_at ?? null,
      insts,
      onOpenAsset: openAsset,
      onAll: () => setSigDialog({ filter: "all", focusId: null }),
    }),
    alerts: alertsBriefProps({
      alerts: alertsList,
      near: strategy?.facts?.alerts ?? null,
      sinceAt: digest?.since_at ?? null,
      onManage: () => o.onSignalsPageOpened?.("alerts"),
    }),
    candidates: data.research.ran
      ? candidatesRailProps({
          candidates: data.research.candidates,
          watched: watchedOf(watch),
          why,
          busy: commands.research.busy,
          now: Date.parse(displayNow),
          onWhy: setWhy,
          onWatch: (n) =>
            void commands.research.watch(n).then((failure) => failure && toast(failure, 4000)),
          onDismiss: (n) =>
            void commands.research.dismiss(n).then((failure) => failure && toast(failure, 4000)),
          onAll: () => o.onResearchOpened?.("candidates"),
        })
      : null,
    // Named by the signal's own title, never the strategy's rule id (old Home.tsx:516, FE-A A6).
    // The light grid shows no signals dialog (old Home.tsx:551 `!light`).
    signalsDialog:
      dialog && !light
        ? ({
            data,
            filter: dialog.filter,
            focusId: dialog.focusId,
            review: o.review,
            expired: (digest?.signals.resolved ?? [])
              .filter((x) => x.status === "expired")
              .map((x) => ({ title: x.instrument_label ?? signalText(x).title })),
            onHistory: () => o.onSignalsPageOpened?.("journal"),
            onClose: () => {
              setSigDialog(null);
              if (o.signalsOpen) o.onSignalsClosed?.();
            },
            onOpenAsset: (gid: string) => o.openPage?.(gid),
            onOpenNote: openNote,
          } satisfies SignalsDialogInput)
        : null,
    // ---- widgets ui (H2) ----
    widgets,
    unwatch,
    range: o.range,
    onRange: (range: PerfRange) => startTransition(() => o.onRangePicked?.(range)),
    allocView,
    setAllocView,
    assetTab,
    setAssetTab,
    filtered: filter != null,
    openAsset: (id: number | string) => openAsset(id),
    openPage: (gid: string) => o.openPage?.(gid),
    research: {
      onOpenAsset: (id: number, noteId?: number) => openAsset(id, noteId),
      onOpenTopic: (key: string) => o.onTopicOpened?.(key),
      onOpenResearch: (query?: string) =>
        o.onResearchOpened?.(query?.startsWith("tab=") ? query.slice(4) : undefined),
    },
    // ---- the research page (old route `research`) and the topic drawer (`topics/<key>`) ----
    researchPage: o.research
      ? {
          slug: o.slug,
          initialTab: o.research.tab,
          initialNote: legacyIdOf(o.research.note),
          onBack: () => o.onAssetClosed?.(),
          onOpenAsset: (id: number, noteId?: number) => openAsset(id, noteId),
          onOpenTopic: (key: string) => o.onTopicOpened?.(key),
          onSettings: () => o.onSettingsOpened?.(),
        }
      : null,
    topicDrawer:
      o.topic && !o.instrument && !o.research
        ? {
            topic: o.topic,
            onClose: () => o.onTopicClosed?.(),
            onCrumb: (where: "home" | "section") => {
              o.onTopicClosed?.();
              if (where === "section") setTimeout(() => scrollTo("inv-research"), 60);
            },
            onOpenAsset: (id: number) => openAsset(id),
          }
        : null,
    // ---- the review deck (R) ----
    deck:
      o.review && digest && hasData
        ? {
            data: deckData,
            digest,
            perfWeek: data.perf1m.data,
            busy: saving || deckCommands.busy,
            suspended: drawer != null || proposalOpen,
            note,
            onNote: setNote,
            onClose: () => o.onReviewClosed?.(),
            onDone: (input: { deck: DeckStats; skipped: { id: CardId; why: string }[] }) =>
              void markDone(input),
            onOpenProposal: (id: number) => {
              const gid = gidOf(id);
              if (gid !== null && o.onProposalOpened?.(gid, () => setProposalOpen(false)))
                setProposalOpen(true);
            },
          }
        : null,
    txnDrawer,
    accountDrawer,
    thesisDrawer,
    txnsDrawer,
    // ---- the asset detail (Home.tsx:402-427): the drawer over the grid or the page in its place ----
    asset: o.instrument
      ? {
          instrument: o.instrument,
          page: !!o.page,
          noteGid: o.noteGid ?? null,
          filter,
          actions: {
            onAlerts: () => o.onSignalsPageOpened?.("alerts"),
            onJournal: (instrument: string) => o.onJournalOpened?.(instrument),
            onAddTxn: (instrumentId: number) => setDrawer({ kind: "txn", instrumentId }),
            onTxns: (position: Position) => setDrawer({ kind: "txns", position }),
            onThesis: (inst: { id: number; label: string }, thesis: Thesis | null) =>
              setDrawer({ kind: "thesis", instrumentId: inst.id, label: inst.label, thesis }),
            onOpenNote: openNote,
          },
          onClose: () => o.onAssetClosed?.(),
          onPage: () => o.onAssetPageOpened?.(o.instrument ?? ""),
          onPanel: () => o.openPage?.(o.instrument ?? ""),
          onCrumb: (where: "home" | "assets") => {
            o.onAssetClosed?.();
            if (where === "assets") setTimeout(() => scrollTo("inv-assets"), 60);
          },
        }
      : null,
  };
}
