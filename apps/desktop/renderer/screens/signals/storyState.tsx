/** Synthetic presentation fixtures only: stories build each surface's narrow props and never connect to a vault or host. */
import { D, toCurrency } from "@cashu/domain";
import { alerts, asInstrumentId, instrument as makeInstrument } from "@cashu/domain/investments";
import type { ReadySignals, SignalRow } from "@cashu/store/investments/signals-screen";
import { useForm } from "@tanstack/react-form";
import { alertHistoryLines, alertLine } from "./alertModels.js";
import { journalModel } from "./journalModels.js";
import type { SignalsNotice } from "./outcomes.js";
import { signalGroups } from "./presentation.js";
import {
  decisionHeader,
  estimateView,
  groupSection,
  railRows,
  railSummary,
} from "./signalModels.js";
import type { AlertsPageState } from "./useAlertsPage.js";
import type { DecisionDialogState } from "./useDecisionDialog.js";
import type { JournalPageState } from "./useJournalPage.js";
import type { SignalsFeedback } from "./useSignalsFeedback.js";
import type { SignalsListState, SignalsRailState } from "./useSignalsScreen.js";
import type { WatchlistPageState } from "./useWatchlistPage.js";
import { watchRow } from "./watchModels.js";

const now = "2026-11-03T12:00:00Z";
const instrument = "00000000-0000-8000-8000-000000000101";
const episode = "00000000-0000-8000-8000-000000000102";
const alertId = "00000000-0000-8000-8000-000000000103";
const decisionId = "00000000-0000-8000-8000-000000000104";
const itemId = "00000000-0000-8000-8000-000000000105";
const syntheticInstrument = makeInstrument({
  id: asInstrumentId(instrument),
  name: "Synthetic instrument",
  currency: toCurrency("PLN"),
  assetClass: "equity",
  symbol: "SYN",
});

const signal: SignalRow = {
  gid: episode,
  ruleId: `alert:${alertId}`,
  kind: "alert:price_above",
  dedupKey: "synthetic",
  severity: "action",
  polarity: "positive",
  status: "active",
  message: "Synthetic price crossed 148 PLN",
  instrument,
  account: null,
  payload: {
    alert_kind: "price_above",
    close: "148.625",
    currency: "PLN",
    title: "Synthetic price alert",
  },
  firstSeenAt: now,
  lastSeenAt: now,
  createdRun: null,
  lastRun: null,
  acknowledgedAt: null,
  closedAt: null,
  snoozedUntil: null,
  source: "alert",
  instrumentLabel: "SYN",
  messageCode: null,
  messageParams: null,
  alert: alertId,
  note: null,
  snoozed: false,
  current: true,
  decisions: [],
};
const decision = {
  gid: decisionId,
  signal: episode,
  signals: [episode],
  instrument,
  account: null,
  action: "held",
  quantity: null,
  price: null,
  currency: null,
  reason: "Review next week",
  createdAt: now,
};
const alert = {
  gid: alertId,
  instrument,
  scope: "instrument",
  kind: "price_above",
  params: { level: "145" },
  polarity: "positive",
  severity: "action",
  title: "Synthetic price alert",
  note: null,
  tag: null,
  source: "user",
  createdBy: "app",
  status: "triggered",
  cooldownDays: 14,
  expiresAt: null,
  snoozedUntil: null,
  lastTriggeredAt: now,
  lastCheckedAt: now,
  lastValue: "148.625",
  createdAt: now,
  updatedAt: now,
  deletedAt: null,
  instrumentDetail: syntheticInstrument,
  unit: "price",
  state: null,
  stateUnavailable: false,
  signal: {
    gid: episode,
    status: "active",
    message: signal.message,
    messageCode: null,
    messageParams: null,
    firstSeenAt: now,
  },
};
const watch = {
  id: itemId,
  instrument_id: instrument,
  instrument: {
    id: instrument,
    name: "Synthetic instrument",
    symbol: "SYN",
    currency: "PLN",
    plan: "buy",
    plan_freshness: { state: "fresh" },
  },
  note: "Synthetic watch note",
  tags: ["demo"],
  source: "user",
  added_at: now,
  held: false,
  price_source: true,
  price: {
    close: D("148.625"),
    date: "2026-11-03",
    currency: "PLN",
    stale: false,
    change_1d: 0.012,
    change_1m: 0.038,
    high_52w: D("151"),
    high_52w_date: "2026-10-31",
    from_high_52w: -0.016,
    bars: 30,
  },
  closes_30d: [
    { date: "2026-10-31", close: D("143") },
    { date: "2026-11-03", close: D("148.625") },
  ],
  alerts: { count: 1, live: 1, triggered: 1, nearest: null },
  research_unread: 0,
  hints: [],
};

export function signalsStorySnapshot(): ReadySignals {
  return {
    status: "ready",
    asOf: now,
    lastReviewAt: null,
    signals: [signal],
    open: [signal],
    alerts: [alert],
    counts: { active: 0, triggered: 1, snoozed: 0, muted: 0, expired: 0, agentLive: 0 },
    catalog: alerts.catalogDicts(),
    decisions: [decision],
    accounts: [],
    instruments: [syntheticInstrument],
    theses: [],
    watchlist: [
      {
        gid: itemId,
        instrument,
        note: watch.note,
        tags: watch.tags,
        source: "user",
        addedAt: now,
        removedAt: null,
      },
    ],
    held: [],
    lastRun: {
      gid: "00000000-0000-8000-8000-000000000106",
      trigger: "scheduled",
      asOf: "2026-11-03",
      status: "partial",
      strategyVersion: null,
      stats: {},
      errors: [],
      report: {},
      startedAt: now,
      finishedAt: now,
    },
    context: {
      status: "ready",
      revision: "synthetic",
      positions: { positions: [] },
      allocation: {
        buckets: [
          { bucket_id: "equity", generic: true, value: D("1000"), target: 0.6, drift_pp: 1 },
        ],
      },
      overview: { base_currency: "PLN", kpis: { value: { total: D("1000") } } },
      watchlist: [watch],
      contributionDay: 10,
    } as unknown as ReadySignals["context"],
  } as ReadySignals;
}

const nextDeposit = "2026-11-10";
const noop = () => {};
const resolved = () => Promise.resolve();

export function storyFeedback(patch: Partial<SignalsFeedback> = {}): SignalsFeedback {
  return { busy: false, notice: null, refusal: null, undoIds: [], ...patch };
}

export function storyRail(data: ReadySignals | null, privacy = false): SignalsRailState {
  const groups = data === null ? [] : signalGroups(data.open, data.held, "all");
  return {
    available: data !== null,
    privacy,
    total: groups.length,
    rows: railRows(groups),
    summary: data === null ? null : railSummary(data),
    onOpenAll: noop,
    onOpenRow: noop,
    onOpenPage: noop,
    onOpenReview: noop,
  };
}

export function storyList(
  data: ReadySignals | null,
  patch: Partial<SignalsListState> & {
    notice?: SignalsNotice | null;
    refusal?: string | null;
  } = {},
): Omit<SignalsListState, "open"> & { notice: SignalsNotice | null; refusal: string | null } {
  const groups = data === null ? [] : signalGroups(data.open, data.held, "all");
  return {
    available: data !== null,
    filter: "all",
    cursor: episode,
    empty: groups.every((group) => group.signals.length === 0),
    portfolio: groupSection(groups, "portfolio", nextDeposit),
    watched: groupSection(groups, "watched", nextDeposit),
    deciding: false,
    busy: false,
    canOpenNote: true,
    notice: null,
    refusal: null,
    onFilter: noop,
    onMove: noop,
    onDecide: noop,
    onDecideCursor: noop,
    onAcknowledge: noop,
    onDefer: noop,
    onUndoDefer: noop,
    onUndoDecision: noop,
    onOpenAsset: noop,
    onOpenNote: noop,
    onOpenPage: noop,
    onClose: noop,
    ...patch,
  };
}

/** The decision dialog over the first open group, with a buy estimate when `estimate` is set. */
export function useStoryDecision(
  data: ReadySignals,
  options: { busy?: boolean; estimate?: boolean } = {},
): DecisionDialogState {
  const group = signalGroups(data.open, data.held, "all")[0] ?? null;
  const form = useForm({
    defaultValues: {
      action: options.estimate ? "bought" : "held",
      account: "",
      quantity: options.estimate ? "2" : "",
      price: options.estimate ? "148.625" : "",
      currency: "PLN",
      reason: "",
    },
    onSubmit: noop,
  });
  return {
    open: group !== null,
    ...decisionHeader(group),
    form,
    suggestedQuantity: options.estimate ? D("2") : null,
    quantityUnavailable: false,
    estimate: options.estimate
      ? estimateView({
          amount: D("297.25"),
          currency: "PLN",
          allocation: { afterWeight: 0.62, target: 0.6, driftPp: 2 },
        } as Parameters<typeof estimateView>[0])
      : null,
    thesis: null,
    accounts: data.accounts,
    nextDeposit: null,
    busy: options.busy ?? false,
    onClose: noop,
  } as DecisionDialogState;
}

export function storyAlerts(
  data: ReadySignals | null,
  patch: Partial<AlertsPageState> = {},
): AlertsPageState {
  return {
    status: "all",
    source: "all",
    rows: (data?.alerts ?? []).map(alertLine),
    counts: data?.counts ?? null,
    history: data === null ? [] : alertHistoryLines(data),
    editing: null,
    editingRow: null,
    canRestore: false,
    canExport: data !== null,
    busy: false,
    onStatus: noop,
    onSource: noop,
    onEdit: noop,
    onSave: resolved,
    onRemove: resolved,
    onRestore: resolved,
    onToggleMute: resolved,
    onExport: noop,
    ...patch,
  };
}

export function storyWatchlist(
  data: ReadySignals | null,
  patch: Partial<WatchlistPageState> = {},
): WatchlistPageState {
  const ready = data?.context.status === "ready" ? data.context : null;
  return {
    available: ready !== null,
    rows: ready === null ? [] : ready.watchlist.map(watchRow),
    search: { text: "", hits: [], searching: false, remoteUnavailable: false, offerTyped: false },
    canRestore: false,
    onSearch: noop,
    onChoose: noop,
    onAddTyped: noop,
    onRemove: noop,
    onRestore: resolved,
    onOpenAsset: noop,
    ...patch,
  };
}

export function storyJournal(data: ReadySignals | null): JournalPageState {
  return {
    filter: "all",
    instrument: "",
    instruments: (data?.instruments ?? []).map((row) => ({
      id: row.id,
      label: row.symbol ?? row.name,
    })),
    ...(data === null ? { rows: [], decisions: 0, signals: 0 } : journalModel(data, "", "all")),
    onFilter: noop,
    onInstrument: noop,
    onUndo: noop,
    onOpenAsset: noop,
  };
}

/** A snapshot with no open signals (everything decided). */
export function emptyStorySnapshot(): ReadySignals {
  const data = signalsStorySnapshot();
  return { ...data, open: [], signals: [], alerts: [], decisions: [], lastRun: null };
}
