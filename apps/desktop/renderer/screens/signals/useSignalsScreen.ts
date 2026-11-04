import { lang } from "@cashu/i18n";
import { signalsQueries } from "@cashu/store/investments/signals-screen";
import { useConnection, useQuery } from "@cashu/store-react";
import { useUiEnv } from "@cashu/ui";
import { nextDeposit } from "@cashu/ui-logic/investments/logic";
import { useCalendarDay } from "../../shell/useCalendarDay.js";
import { useDurableCommands } from "../useDurableCommand.js";
import { groupSection, railRows, railSummary } from "./signalModels.js";
import { useAlertsPage } from "./useAlertsPage.js";
import { useDecisionDialog } from "./useDecisionDialog.js";
import { useDecisionUndo } from "./useDecisionUndo.js";
import { useDisplayClock } from "./useDisplayClock.js";
import { useJournalPage } from "./useJournalPage.js";
import { useSignalsFeedback } from "./useSignalsFeedback.js";
import { useSignalsList } from "./useSignalsList.js";
import { useWatchlistPage } from "./useWatchlistPage.js";

const query = signalsQueries().screen;
export type SignalsPageKind = "alerts" | "watchlist" | "journal";
export interface SignalsScreenOptions {
  readonly page?: SignalsPageKind;
  readonly initialSignal?: string | null;
  readonly initialInstrument?: string | null;
  readonly onOpenAsset?: (gid: string) => void;
  readonly onOpenNote?: (
    note: string | null,
    instrument: string | null,
    segment: string | null,
  ) => void;
  readonly onOpenReview?: () => void;
  readonly onOpenPage?: (page: SignalsPageKind) => void;
  readonly onClose?: () => void;
  readonly onExportCsv?: (filename: string, content: string) => void;
}

/**
 * The Signals screen: one live snapshot shared by the Home rail, the full dialog, the decision
 * dialog and the Alerts / Watchlist / Journal pages. Each surface gets its own slice.
 */
export function useSignalsScreen(options: SignalsScreenOptions = {}) {
  const { privacy } = useUiEnv();
  const connection = useConnection();
  const today = useCalendarDay();
  const displayNow = useDisplayClock(today);
  const snapshot = useQuery(query, {
    // The host's live clock wins when bound; a local day-scoped read clock keeps native displays
    // usable before that provider is installed. It never grants write or fetch authority.
    now: displayNow,
    today,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    lang: lang(),
    privacy,
  });
  const data = snapshot.status === "ready" ? snapshot : null;
  const feedback = useSignalsFeedback();
  const durable = useDurableCommands();
  const next =
    data?.context.status === "ready" ? nextDeposit(today, data.context.contributionDay) : null;
  const list = useSignalsList({
    data,
    privacy,
    connection,
    initialSignal: options.initialSignal,
    feedback,
    durable,
  });
  const decision = useDecisionDialog({
    data,
    privacy,
    group: list.selected,
    nextDeposit: next,
    feedback,
    durable,
    onClose: () => list.setDeciding(null),
  });
  const undo = useDecisionUndo({ privacy, feedback, durable });
  const alerts = useAlertsPage({
    data,
    privacy,
    feedback,
    durable,
    onExportCsv: options.onExportCsv,
  });
  const watchlist = useWatchlistPage({
    data,
    privacy,
    feedback,
    onOpenAsset: options.onOpenAsset,
  });
  const journal = useJournalPage({
    data,
    initialInstrument: options.initialInstrument,
    onUndo: undo.undoOne,
    onOpenAsset: options.onOpenAsset,
  });
  const closeDialog = () => list.setOpen(false);
  return {
    /** The live snapshot, or null while unavailable (privacy mode, module off). */
    data,
    privacy,
    /** The read clock of this instance (an ISO instant). */
    displayNow,
    feedback: feedback.state,
    rail: {
      available: data !== null,
      privacy,
      total: list.groups.length,
      rows: railRows(list.groups),
      summary: data === null ? null : railSummary(data),
      onOpenAll: () => list.setOpen(true),
      onOpenRow: (focus: string | null) => {
        list.setOpen(true);
        list.setCursor(focus);
      },
      onOpenPage: (page: SignalsPageKind) => options.onOpenPage?.(page),
      onOpenReview: options.onOpenReview,
    },
    list: {
      open: list.open,
      available: data !== null,
      filter: list.filter,
      cursor: list.cursor,
      /** No group has a signal under the current filter. */
      empty: list.groups.every((group) => group.signals.length === 0),
      portfolio: groupSection(list.groups, "portfolio", next),
      watched: groupSection(list.groups, "watched", next),
      deciding: list.selected !== null,
      busy: feedback.state.busy,
      canOpenNote: options.onOpenNote !== undefined,
      onFilter: list.onFilter,
      onMove: list.onMove,
      onDecide: (group: string) => list.setDeciding(group),
      onDecideCursor: list.onDecideCursor,
      onAcknowledge: list.onAcknowledge,
      onDefer: list.onDefer,
      onUndoDefer: list.onUndoDefer,
      onUndoDecision: undo.undoOne,
      onOpenAsset: (instrument: string) => {
        closeDialog();
        options.onOpenAsset?.(instrument);
      },
      onOpenNote: (note: string | null, instrument: string | null, segment: string | null) => {
        closeDialog();
        options.onOpenNote?.(note, instrument, segment);
      },
      onOpenPage: (page: SignalsPageKind) => {
        closeDialog();
        options.onOpenPage?.(page);
      },
      onClose: () => {
        closeDialog();
        options.onClose?.();
      },
    },
    decision,
    alerts,
    watchlist,
    journal,
    onUndoLast: undo.undoLast,
    onBack: options.onClose,
    /** Opens the full dialog (the Home rail and notifications). */
    setDialogOpen: list.setOpen,
    /** Focuses one signal in the full dialog. */
    setCursor: list.setCursor,
  };
}
export type SignalsScreenState = ReturnType<typeof useSignalsScreen>;
export type SignalsListState = SignalsScreenState["list"];
export type SignalsRailState = SignalsScreenState["rail"];
