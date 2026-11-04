import {
  type ReadySignals,
  signalsAlertCommands,
  signalsOwnerCommands,
} from "@cashu/store/investments/signals-screen";
import { useCommand } from "@cashu/store-react";
import { useState } from "react";
import type { GuardedOutcome, useDurableCommands } from "../useDurableCommand.js";
import {
  type AlertSourceFilter,
  type AlertStatusFilter,
  alertLine,
  filterAlerts,
  historyCsv,
  historyLine,
} from "./alertModels.js";
import { alertHistoryRows } from "./presentation.js";
import { G } from "./Signals.strings.js";
import type { SignalsFeedbackApi } from "./useSignalsFeedback.js";

const alertCommands = signalsAlertCommands();
export type AlertSave = { alert: string | null; fields: Record<string, unknown> };

/** The Alerts page: filters, the editor target, alert writes with one undo, the history and its CSV. */
export function useAlertsPage(args: {
  readonly data: ReadySignals | null;
  readonly privacy: boolean;
  readonly feedback: SignalsFeedbackApi;
  readonly durable: ReturnType<typeof useDurableCommands>;
  readonly onExportCsv?: (filename: string, content: string) => void;
}) {
  const { data, privacy, feedback, durable } = args;
  const [status, setStatus] = useState<AlertStatusFilter>("all");
  const [source, setSource] = useState<AlertSourceFilter>("all");
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const [removed, setRemoved] = useState<string | null>(null);
  const createAlert = useCommand(alertCommands.create);
  const updateAlert = useCommand(alertCommands.update);
  const deleteAlert = useCommand(signalsOwnerCommands.deleteAlert);
  const restoreAlert = useCommand(signalsOwnerCommands.restoreAlert);
  const write = (
    scope: string,
    run: () => Promise<GuardedOutcome<unknown>>,
    onSaved: () => void,
  ) => {
    if (privacy) return Promise.resolve();
    return feedback.exclusive(
      scope,
      async () => {
        const result = await run();
        if (!feedback.isActive()) return;
        if (result.kind === "completed") onSaved();
        else feedback.failed(result);
      },
      { clearRefusal: true },
    );
  };
  const save = (input: AlertSave) =>
    write(
      "alert save",
      () =>
        input.alert === null
          ? durable.run(
              "alert-create",
              createAlert,
              input.fields as Parameters<typeof createAlert.run>[0],
            )
          : durable.run(`alert-update:${input.alert}`, updateAlert, {
              alert: input.alert,
              changes: input.fields,
            }),
      () => {
        setEditing(null);
        feedback.setNotice("saved");
      },
    );
  const history = data === null ? [] : alertHistoryRows(data.signals, data.asOf);
  return {
    status,
    source,
    rows: data === null ? [] : filterAlerts(data.alerts, status, source).map(alertLine),
    counts: data?.counts ?? null,
    history: history.map(historyLine),
    /** The alert in the editor (`"new"` for a new one) and its current row. */
    editing,
    editingRow: data?.alerts.find((row) => row.gid === editing) ?? null,
    canRestore: removed !== null,
    canExport: !privacy && data !== null,
    busy: feedback.state.busy,
    onStatus: setStatus,
    onSource: setSource,
    onEdit: setEditing,
    onSave: save,
    onRemove: (alert: string) =>
      write(
        "alert delete",
        () => durable.run(`alert-delete:${alert}`, deleteAlert, { alert }),
        () => {
          setRemoved(alert);
          feedback.setNotice("removed");
        },
      ),
    onRestore: () => {
      if (removed === null) return Promise.resolve();
      return write(
        "alert restore",
        () => durable.run(`alert-restore:${removed}`, restoreAlert, { alert: removed }),
        () => {
          setRemoved(null);
          feedback.setNotice("restored");
        },
      );
    },
    /** Mute an active alert or unmute a muted one. */
    onToggleMute: (alert: string, current: string) =>
      write(
        "alert mute",
        () =>
          durable.run(`alert-update:${alert}`, updateAlert, {
            alert,
            changes: { status: current === "muted" ? "active" : "muted" },
          }),
        () => feedback.setNotice("saved"),
      ),
    onExport: () => {
      if (privacy || data === null) return;
      args.onExportCsv?.(G.csvFile, historyCsv(history, data.alerts));
    },
  };
}
export type AlertsPageState = ReturnType<typeof useAlertsPage>;
