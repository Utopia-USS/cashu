import { Button, Dialog, Spinner } from "@cashu/ui";
import { useRef } from "react";
import { T } from "./Devices.strings.js";
import { OFFLINE_BOUND_DAYS } from "./deviceRows.js";
import { useFocusWhenShown } from "./useFocusWhenShown.js";
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
  const primary = useRef<HTMLButtonElement>(null);
  const confirmShown = stop === null && targetName !== null;
  useFocusWhenShown(primary, confirmShown && !busy);
  return (
    <Dialog size="narrow" title={title} label={title} onClose={state.close} focus="panel">
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
      {stop !== null ? (
        // An error or pause note replaces the button row: only "Close", plus the step's own way on.
        <>
          <p role="alert" className={note}>
            {stop}
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" disabled={busy} onPress={state.close}>
              {T.close}
            </Button>
            {status === "unknown" && state.operationId && (
              <Button onPress={state.inspect}>{T.inspect}</Button>
            )}
            {status === "failed" && !state.blocked && targetName !== null && (
              <Button variant="primary" onPress={state.confirm}>
                {T.tryAgain}
              </Button>
            )}
          </div>
        </>
      ) : (
        <div className="flex justify-end gap-2">
          <Button variant="ghost" disabled={busy} onPress={state.close}>
            {T.cancel}
          </Button>
          {confirmShown && (
            <Button ref={primary} variant="primary" disabled={busy} onPress={state.confirm}>
              {T.fetchConfirmHere}
            </Button>
          )}
        </div>
      )}
    </Dialog>
  );
}

/**
 * Dialog F for the paused bank fetch: this Mac already is the fetching one, so the action is the
 * owner's override ("Keep fetching on this Mac"). The title asks; the body states what to check.
 */
export function KeepFetchingDialog({ state }: { state: NonNullable<KeepFetchingState> }) {
  const primary = useRef<HTMLButtonElement>(null);
  useFocusWhenShown(primary, true);
  return (
    <Dialog
      size="narrow"
      title={T.keepFetchingTitle}
      label={T.keepFetchingTitle}
      onClose={state.onCancel}
      focus="panel"
    >
      <p className="text-fg-secondary">
        {state.otherMac === null
          ? T.keepFetchingBodyUnnamed(OFFLINE_BOUND_DAYS)
          : T.keepFetchingBody(state.otherMac, OFFLINE_BOUND_DAYS)}
      </p>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onPress={state.onCancel}>
          {T.cancel}
        </Button>
        <Button ref={primary} variant="primary" onPress={state.onConfirm}>
          {T.keepFetchingConfirm}
        </Button>
      </div>
    </Dialog>
  );
}
