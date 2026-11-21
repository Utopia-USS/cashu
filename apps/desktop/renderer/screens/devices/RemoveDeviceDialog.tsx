import { Button, Dialog, FieldNote, Spinner } from "@cashu/ui";
import { useRef } from "react";
import { T } from "./Devices.strings.js";
import type { DevicesScreenState } from "./useDevicesScreen.js";
import { useFocusWhenShown } from "./useFocusWhenShown.js";

const control =
  "w-full rounded-sm border border-border bg-surface px-3 py-2 focus-visible:outline-2 focus-visible:outline-accent";
const check = "flex items-start gap-2.5 rounded-control px-3 py-2.5";

/** Dialog R: what removing a device does, the one checkbox, the devices it added, the recovery words. */
export function RemoveDeviceDialog({ state }: { state: DevicesScreenState }) {
  const { preview, status, targetName, blocked } = state;
  const busy = status === "busy";
  const title =
    targetName === null
      ? T.removing
      : state.profileName === null
        ? T.removeTitleUnnamed(targetName)
        : T.removeTitle(targetName, state.profileName);
  // Error and pause states replace the buttons with a note inside the dialog, never on the page.
  const stop =
    status === "unknown"
      ? T.unknown
      : blocked === "overflow"
        ? T.evidenceOverflow
        : blocked === "pending"
          ? T.evidencePending
          : blocked === "writer"
            ? T.writerPaused
            : status === "failed"
              ? state.refusal === "recertify_capacity"
                ? T.capacity
                : T.failed
              : null;
  /** "Try again" re-runs the dialog's step (the preview); the commit needs a fresh one anyway. */
  const retry =
    status === "failed" &&
    blocked === null &&
    state.refusal !== "recertify_capacity" &&
    targetName !== null;
  const name = targetName ?? "";
  const form = preview !== null && status !== "unknown";
  const words = useRef<HTMLInputElement>(null);
  useFocusWhenShown(words, form && !busy);
  return (
    <Dialog
      size="narrow"
      title={title}
      label={title}
      onClose={() => void state.closeRemoval()}
      focus="panel"
    >
      {targetName !== null && <p className="text-fg-secondary">{T.removeBody}</p>}
      {form && (
        <>
          <label className={`${check} bg-warning-bg text-warning`}>
            <input
              type="checkbox"
              className="mt-1"
              disabled={busy}
              checked={state.ack}
              onChange={(event) => state.setAck(event.target.checked)}
            />
            <span>
              {state.ackKind === "local_start"
                ? T.ackLocalStart(name)
                : state.ackKind === "behind"
                  ? T.ackBehind(name)
                  : T.ackPlain(name)}
            </span>
          </label>
          {preview.affected.length > 0 && (
            <fieldset className="grid gap-1.5">
              <legend className="mb-1.5">{T.keepTitle(name)}</legend>
              {preview.affected.map((device) => (
                <label key={device.device} className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    disabled={busy}
                    checked={state.recertify.includes(device.device)}
                    onChange={(event) => state.toggleRecertify(device.device, event.target.checked)}
                  />
                  {device.name}
                </label>
              ))}
              {state.selectionDirty && (
                <div>
                  <Button size="sm" disabled={busy} onPress={state.review}>
                    {T.refreshSelection}
                  </Button>
                </div>
              )}
            </fieldset>
          )}
          <label className="grid gap-1.5">
            <span className="text-fg-secondary">{T.recovery}</span>
            <input
              ref={words}
              className={control}
              disabled={busy}
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={state.phrase}
              onChange={(event) => state.setPhrase(event.target.value)}
            />
            <FieldNote>{T.recoveryHelp}</FieldNote>
          </label>
        </>
      )}
      {stop === null && preview && state.refusal === "recertify_capacity" && (
        <p role="alert" className="rounded-control bg-chip px-3 py-2.5">
          {T.capacity}
        </p>
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
          <p role="alert" className="rounded-control bg-chip px-3 py-2.5">
            {stop}
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" disabled={busy} onPress={state.closeRemoval}>
              {T.close}
            </Button>
            {status === "unknown" && state.operationId && (
              <Button onPress={state.inspect}>{T.inspect}</Button>
            )}
            {retry && (
              <Button variant="primary" onPress={state.review}>
                {T.tryAgain}
              </Button>
            )}
          </div>
        </>
      ) : (
        <div className="flex justify-end gap-2">
          <Button variant="ghost" disabled={busy} onPress={state.closeRemoval}>
            {T.cancel}
          </Button>
          <Button
            variant="danger"
            disabled={busy || !preview || state.selectionDirty || !state.ack || !state.phrase}
            onPress={state.commit}
          >
            {T.remove}
          </Button>
        </div>
      )}
    </Dialog>
  );
}
