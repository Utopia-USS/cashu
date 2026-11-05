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
import type { AccountRow, CommitResult, Position, Thesis } from "@cashu/ui-logic/investments/types";
import { type InstLike, instName, nextWeekday } from "@cashu/ui-logic/investments/v2/logic";
import type { CardId } from "@cashu/ui-logic/investments/v2/reviewDeckLogic";
import type { PerfRange } from "@cashu/ui-logic/investments/v2/types";
import { startTransition, useEffect, useRef, useState } from "react";
import { reviewSlotModel } from "../../review/deck/reviewSlotModel.js";
import {
  type DeckStats,
  useReviewDeckCommands,
  useReviewDeckData,
} from "../../review/deck/useReviewDeckData.js";
import { type SignalsPageKind, useSignalsScreen } from "../../signals/useSignalsScreen.js";
import type {
  AccountDrawerInput,
  ThesisDrawerInput,
  TxnDrawerInput,
  TxnsDrawerInput,
} from "../drawers/useInvestmentDrawers.js";
import { hasDataOf, headModel, heroModel, startModel } from "./homeModel.js";
import { gidOf, legacyIdOf } from "./legacyWire.js";
import {
  alertsBriefProps,
  candidatesRailProps,
  signalsBriefProps,
  watchedOf,
} from "./railModel.js";
import type { ImportDrawerInput } from "./useImportDrawer.js";
import { useInvestmentsHomeCommands, useInvestmentsHomeData } from "./useInvestmentsHomeData.js";
import type { AllocView } from "./widgets/allocationModel.js";
import type { AssetsTab } from "./widgets/assetListModel.js";
import { useHomeWidgetsState } from "./widgets/useHomeWidgetsState.js";

/** The one drawer over the Home (old Home.tsx DrawerState; the proposal drawer is the route's). */
type DrawerState =
  | { kind: "import"; account?: number | null }
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
  openPage?(gid: string): void;
  onSignalsPageOpened?(page: SignalsPageKind, newAlert?: boolean): void;
  onSignalsClosed?(): void;
  onResearchOpened?(tab?: string, topic?: string, note?: string): void;
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
  /** The alerts manager for one instrument (old `alerts?instrument=id`, `&new=1` for a new alert). */
  onAlertsOpened?(instrument: string, newAlert: boolean): void;
  /** The decision journal for one instrument (old `journal?instrument=id`). */
  onJournalOpened?(instrument: string): void;
}

export function useInvestmentsHomeScreen(o: InvestmentsHomeOptions) {
  const toast = useToast();
  const filter = legacyIdOf(o.account);
  const data = useInvestmentsHomeData({ filter, chartRange: o.range });
  const commands = useInvestmentsHomeCommands(data);
  const deckCommands = useReviewDeckCommands();
  const widgets = useHomeWidgetsState();
  const signalsScreen = useSignalsScreen({
    initialSignal: o.signalFocusId,
    onOpenAsset: o.openPage,
    onOpenReview: o.onReviewOpened,
    onOpenPage: o.onSignalsPageOpened,
    onClose: o.onSignalsClosed,
    onOpenNote: (note) => o.onResearchOpened?.(undefined, undefined, note ?? undefined),
  });
  const { setDialogOpen } = signalsScreen;
  useEffect(() => {
    if (o.signalsOpen) setDialogOpen(true);
  }, [o.signalsOpen, setDialogOpen]);

  // Alokacja's view (home v3 Q2): the page owns it so the stale-prices tag can land on Rachunki.
  const [allocView, setAllocView] = useState<AllocView | null>(null);
  const [assetTab, setAssetTab] = useState<AssetsTab>("positions");
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

  // ---- navigation ------------------------------------------------------------------------------------------
  const openAsset = (id: number | string) => {
    const gid = gidOf(id);
    if (gid !== null) o.openPage?.(gid);
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
  const importDrawer: ImportDrawerInput | null =
    drawer?.kind === "import"
      ? {
          accounts,
          initialAccount: drawer.account ?? null,
          commands,
          onClose: close,
          onDone: (r: CommitResult) =>
            toast(S.imported(r.inserted, r.planned_booked?.length ?? 0), 3500),
          onAddAccount: () => setDrawer({ kind: "account" }),
          onManual: () => setDrawer({ kind: "txn" }),
          onClassify: () => {
            close();
            setTimeout(() => scrollTo("inv-assets"), 50);
          },
        }
      : null;
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
  const head = overview ? headModel({ overview, filter, hasData, today }) : null;
  const reviewSlot =
    hasData && digest
      ? reviewSlotModel({
          name: digest.review?.name ?? null,
          due,
          count: deckData.live.cards.length,
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
      setTimeout(() => scrollTo("inv-alloc"), 30);
    },
    onImport: () => setDrawer({ kind: "import", account: filter }),
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
          })
        : null,
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
            onImport: () => setDrawer({ kind: "import", account: filter }),
          })
        : null,
    onCopy: (command: string) => {
      void navigator.clipboard?.writeText(command).then(() => toast(UI.copied, 1500));
    },
    onSettings: () => o.onSettingsOpened?.(),
    // ---- the rail ----
    signals: signalsBriefProps({
      items: deckData.live.rail,
      deck: deckData.live.decide,
      rest: deckData.live.railRest,
      total: data.signals.length,
      loading: !data.sig.data || !deckData.ready,
      reviewDue: due,
      reviewName: digest?.review?.name ?? S.weeklyReview,
      lastReviewAt: doneLocal ?? digest?.last_review?.done_at ?? null,
      nextOn: digest?.review?.next_on ?? null,
      insts,
      onOpenAsset: openAsset,
      onOpenReview: openReview,
      onAll: () => setDialogOpen(true),
    }),
    alerts: alertsBriefProps({
      alerts: alertsList,
      near: strategy?.facts?.alerts ?? null,
      sinceAt: digest?.since_at ?? null,
      onManage: () => o.onSignalsPageOpened?.("alerts"),
      onNew: () => o.onSignalsPageOpened?.("alerts", true),
    }),
    candidates: data.research.ran
      ? candidatesRailProps({
          candidates: data.research.candidates,
          watched: watchedOf(watch),
          why,
          busy: commands.research.busy,
          now: Date.parse(signalsScreen.displayNow),
          onWhy: setWhy,
          onWatch: (n) =>
            void commands.research.watch(n).then((failure) => failure && toast(failure, 4000)),
          onDismiss: (n) =>
            void commands.research.dismiss(n).then((failure) => failure && toast(failure, 4000)),
          onAll: () => o.onResearchOpened?.("candidates"),
        })
      : null,
    signalsScreen,
    // ---- widgets ui (H2) ----
    widgets,
    range: o.range,
    onRange: (range: PerfRange) => startTransition(() => o.onRangePicked?.(range)),
    allocView,
    setAllocView,
    assetTab,
    setAssetTab,
    filtered: filter != null,
    onReconcile: (account: number | null) => setDrawer({ kind: "import", account }),
    openAsset,
    openPage: (gid: string) => o.openPage?.(gid),
    research: {
      onOpenAsset: (id: number, noteId?: number) => {
        const nid = noteId != null ? gidOf(noteId) : null;
        if (nid !== null) o.onResearchOpened?.(undefined, undefined, nid);
        else openAsset(id);
      },
      onOpenTopic: (key: string) => o.onResearchOpened?.(undefined, key),
      onOpenResearch: (query?: string) =>
        o.onResearchOpened?.(query?.startsWith("tab=") ? query.slice(4) : undefined),
    },
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
    importDrawer,
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
            onNewAlert: (instrument: string) => o.onAlertsOpened?.(instrument, true),
            onAlerts: (instrument: string) => o.onAlertsOpened?.(instrument, false),
            onJournal: (instrument: string) => o.onJournalOpened?.(instrument),
            onAddTxn: (instrumentId: number) => setDrawer({ kind: "txn", instrumentId }),
            onTxns: (position: Position) => setDrawer({ kind: "txns", position }),
            onThesis: (inst: { id: number; label: string }, thesis: Thesis | null) =>
              setDrawer({ kind: "thesis", instrumentId: inst.id, label: inst.label, thesis }),
            // old ctx.onOpenNote: the note in the research view, else the segment's topic.
            onOpenNote: (_instrument: string, note: string | null, segment: string | null) =>
              note
                ? o.onResearchOpened?.(undefined, undefined, note)
                : o.onResearchOpened?.(undefined, segment ?? undefined),
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
