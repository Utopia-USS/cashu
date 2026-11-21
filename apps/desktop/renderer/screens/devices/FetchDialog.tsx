import { Button, Dialog, Spinner } from "@cashu/ui";
import { T } from "./Devices.strings.js";
import { S } from "./Sync.strings.js";
import type { KeepFetchingState } from "./useKeepFetching.js";
import type { LeaderActionState } from "./useLeaderAction.js";

const check = "flex items-start gap-2.5 rounded-control bg-warning-bg px-3 py-2.5 text-warning";
const note = "rounded-control bg-chip px-3 py-2.5";

/** Dialog F: change which device fetches the bank data (the row menu's item). */
export function FetchDialog({ state }: { state: LeaderActionState }) {
  const { status, current, targetName } = state;
  const busy = status === "busy";
  const title = targetName === null ? T.fetchTitleUnknown : T.fetchTitleHere;
  const stop =
    status === "unknown"
      ? T.fetchUnknown
      : state.blocked
        ? T.fetchBlocked
        : status === "failed"
          ? T.failed
          : null;
  return (
    <Dialog size="narrow" title={title} label={title} onClose={state.close}>
      {targetName !== null && (
        <p className="text-fg-secondary">
          {current === null ? T.noFetcher : T.handover(current.name)}
        </p>
      )}
      {targetName !== null && current !== null && status !== "unknown" && (
        <label className={check}>
          <input
            type="checkbox"
            className="mt-1"
            disabled={busy}
            checked={state.force}
            onChange={(event) => state.setForce(event.target.checked)}
          />
          <span>{T.force(current.name, current.days)}</span>
        </label>
      )}
      {busy && (
        <p role="status" className="flex items-center gap-1.5">
          <Spinner />
          {T.working}
        </p>
      )}
      {stop !== null && (
        <p role="alert" className={note}>
          {stop}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" disabled={busy} onPress={state.close}>
          {T.cancel}
        </Button>
        {status === "unknown" && state.operationId ? (
          <Button onPress={state.inspect}>{T.inspect}</Button>
        ) : (
          targetName !== null &&
          !state.blocked && (
            <Button variant="primary" disabled={busy} onPress={state.confirm}>
              {T.fetchConfirmHere}
            </Button>
          )
        )}
      </div>
    </Dialog>
  );
}

/**
 * Dialog F for the paused bank fetch: this Mac already is the fetching one, so the action is the
 * owner's override ("Keep fetching on this Mac"), with today's wording of its consequences.
 */
export function KeepFetchingDialog({ state }: { state: NonNullable<KeepFetchingState> }) {
  return (
    <Dialog
      size="narrow"
      title={T.fetchTitleHere}
      label={T.fetchTitleHere}
      onClose={state.onCancel}
    >
      <p className="text-fg-secondary">
        {state.otherMac === null
          ? S.keepFetchingConfirmUnnamed
          : S.keepFetchingConfirm(state.otherMac)}
      </p>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onPress={state.onCancel}>
          {S.keepFetchingCancel}
        </Button>
        <Button variant="primary" onPress={state.onConfirm}>
          {T.fetchConfirmHere}
        </Button>
      </div>
    </Dialog>
  );
}
