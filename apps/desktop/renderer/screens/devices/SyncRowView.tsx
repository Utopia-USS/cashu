import { Button, Dialog, SettingRow, Spinner, Switch } from "@cashu/ui";
import { S } from "./Sync.strings.js";
import type { SyncStatusLine } from "./syncStatusLine.js";

export type SyncRowState =
  /** No sync config on this host (or no host): the row is not shown at all. */
  | { readonly kind: "hidden" }
  | {
      readonly kind: "ready";
      readonly enabled: boolean;
      readonly line: SyncStatusLine;
      readonly busy: boolean;
      /** The last owner action's answer, until the next one. */
      readonly outcome: "none" | "failed" | "purge_done" | "purge_retry" | "reconnect_unavailable";
      readonly confirmingPurge: boolean;
      onToggle(on: boolean): void;
      onReconnect(): void;
      /** "Try now" of a failing removal: a sync pass now. */
      onTryNow(): void;
      onAskPurge(): void;
      onCancelPurge(): void;
      onPurge(): void;
    };

/** The one status line under the switch (the clock and device counts come in the line). */
function StatusLine({ line }: { line: SyncStatusLine }) {
  switch (line.kind) {
    case "hidden":
    case "off":
    case "reconnect":
      return null;
    case "reconnect_unavailable":
      return <p role="alert">{S.reconnectUnavailable}</p>;
    case "quota":
      return <p role="status">{S.quota}</p>;
    case "paused":
      return <p role="status">{S.paused(line.since)}</p>;
    case "removal_failing":
      return (
        <p role="alert">
          {line.device === null ? S.removalFailingUnnamed : S.removalFailing(line.device)}
        </p>
      );
    case "stuck_failed":
      return (
        <p role="alert">
          {line.device === null ? S.stuckFailedUnnamed : S.stuckFailed(line.device)}
        </p>
      );
    case "stuck_waiting":
      return (
        <p role="status">
          {line.device === null ? S.stuckWaitingUnnamed : S.stuckWaiting(line.device)}
        </p>
      );
    case "synced":
      return (
        <p role="status">
          {line.day === "today"
            ? S.syncedToday(line.at, line.devices)
            : line.day === "yesterday"
              ? S.syncedYesterday(line.at)
              : S.syncedOn(line.at)}
        </p>
      );
    case "first_sync":
      return <p role="status">{S.firstSync(line.devices)}</p>;
  }
}

/** Settings > Devices > Sync: the switch, the details line, one status line and the purge. */
export function SyncRowView({ state }: { state: SyncRowState }) {
  if (state.kind === "hidden") return null;
  return (
    <section id="sync" className="grid gap-2" aria-labelledby="sync-title">
      <SettingRow
        title={<h2 id="sync-title">{S.title}</h2>}
        detail={S.details}
        control={
          <Switch
            on={state.enabled}
            onChange={state.onToggle}
            label={S.title}
            disabled={state.busy}
          />
        }
      >
        <div className="grid gap-1 text-sm">
          <StatusLine line={state.line} />
          {state.line.kind === "removal_failing" && (
            <div>
              <Button disabled={state.busy} onPress={state.onTryNow}>
                {S.tryNow}
              </Button>
            </div>
          )}
          {state.line.kind === "reconnect" && (
            <div>
              <Button disabled={state.busy} onPress={state.onReconnect}>
                {S.reconnect}
              </Button>
            </div>
          )}
          {state.busy && (
            <p role="status" className="flex items-center gap-1.5">
              <Spinner />
              {S.working}
            </p>
          )}
          {state.outcome === "failed" && <p role="alert">{S.actionFailed}</p>}
          {state.outcome === "reconnect_unavailable" && (
            <p role="alert">{S.reconnectUnavailable}</p>
          )}
          {state.outcome === "purge_done" && <p role="status">{S.purgeDone}</p>}
          {state.outcome === "purge_retry" && (
            <div className="grid gap-1">
              <p role="alert">{S.purgeRetry}</p>
              <div>
                <Button disabled={state.busy} onPress={state.onPurge}>
                  {S.purgeAgain}
                </Button>
              </div>
            </div>
          )}
        </div>
      </SettingRow>
      <details className="text-sm">
        <summary className="cursor-pointer">{S.purgeDisclosure}</summary>
        <div className="grid gap-2 pt-2">
          <p className="text-fg-muted">{S.purgeHelp}</p>
          <div>
            <Button disabled={state.busy} onPress={state.onAskPurge}>
              {S.purge}
            </Button>
          </div>
        </div>
      </details>
      {state.confirmingPurge && (
        <Dialog
          size="narrow"
          title={S.purgeConfirmTitle}
          label={S.purgeConfirmTitle}
          onClose={state.onCancelPurge}
        >
          <p>{S.purgeHelp}</p>
          <div className="flex gap-2">
            <Button onPress={state.onPurge}>{S.purgeConfirm}</Button>
            <Button onPress={state.onCancelPurge}>{S.purgeKeep}</Button>
          </div>
        </Dialog>
      )}
    </section>
  );
}
