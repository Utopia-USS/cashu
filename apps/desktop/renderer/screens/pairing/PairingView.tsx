import { Button, Spinner } from "@cashu/ui";
import { QRCodeSVG } from "qrcode.react";
import { S as D } from "../../Desktop.strings.js";
import { T } from "./Pairing.strings.js";

export type PairingViewState =
  | { kind: "unavailable" }
  | { kind: "idle"; onCreate(): Promise<void> }
  | { kind: "creating" }
  | {
      kind: "invited";
      qr: string;
      /** The code under the QR as one short line (start…end); the full value only goes to the clipboard. */
      codePreview: string;
      /** Epoch ms; rendered through the shared clock format. */
      expiresAt: number;
      /**
       * Whether a phone has connected to this invitation, as the host's inspect reports it. "unknown"
       * (a host that does not say) shows the six-digit field as before; "waiting" hides it, so the
       * code cannot be confirmed before a phone connected.
       */
      phone: "unknown" | "waiting" | "connected";
      code: string;
      onCodeChange(code: string): void;
      onConfirm(): Promise<void>;
      onCancel(): Promise<void>;
      onCopy(): void;
      canCopy: boolean;
      /** "Copy code" succeeded and nothing happened since (no host push, no action). */
      copied: boolean;
      submitting: boolean;
    }
  /** Always offers a way back: cancels the attempt (or reports the outcome as unknown). */
  | { kind: "checking"; onCancel(): Promise<void> }
  | { kind: "unknown"; onInspect(): Promise<void> }
  /** Paired at the commit (membership written); the phone's first sync runs on the phone. */
  | { kind: "completed"; onCreate(): Promise<void> }
  /** A cancel the host refused because the phone was already written into the vault. */
  | { kind: "already_added"; onCreate(): Promise<void> }
  /** The phone left the pairing before it was added; a new invitation can start at once. */
  | { kind: "phone_cancelled"; onCreate(): Promise<void> }
  | { kind: "refused" | "expired" | "sync_off"; onCreate(): Promise<void> };

/** The six-digit field; its label is the only instruction. */
function DigitsStep({ state }: { state: Extract<PairingViewState, { kind: "invited" }> }) {
  return (
    <label className="grid gap-2">
      <span>{T.sasLabel}</span>
      <input
        className="rounded-sm border border-border bg-surface px-3 py-2 focus-visible:outline-2 focus-visible:outline-accent"
        value={state.code}
        onChange={(event) => state.onCodeChange(event.target.value.replace(/\D/g, "").slice(0, 6))}
        inputMode="numeric"
        pattern="[0-9]{6}"
        maxLength={6}
        autoComplete="off"
        spellCheck={false}
        disabled={state.submitting}
      />
    </label>
  );
}

/**
 * The buttons of an end state (paired, expired, refused): "Done" closes the dialog, the second one
 * starts a new invitation (designer, DV4 follow-up).
 */
function EndActions({
  again,
  onCreate,
  onDone,
}: {
  again: string;
  onCreate(): Promise<void>;
  onDone: (() => void) | undefined;
}) {
  return (
    <div className="flex gap-2">
      {onDone && (
        <Button variant="primary" onPress={onDone}>
          {T.done}
        </Button>
      )}
      <Button onPress={onCreate}>{again}</Button>
    </div>
  );
}

export function PairingView({
  state,
  onGoToSync,
  onDone,
  bare = false,
}: {
  state: PairingViewState;
  /** Moves focus to the Sync row; absent when there is no Sync row (no sync config). */
  onGoToSync?: () => void;
  /** Closes the "Pair a phone" dialog ("Done" in the end states); absent outside a dialog. */
  onDone?: () => void;
  /** Inside the "Pair a phone" dialog, which carries the title. */
  bare?: boolean;
}) {
  // Once a phone connected, the dialog shows only the six digits (designer DV2 item 7); "unknown" (a
  // host that does not say) keeps the code step with the field.
  const codeStep = state.kind === "invited" && state.phone !== "connected";
  return (
    <section
      className="grid gap-4"
      {...(bare ? { "aria-label": T.title } : { "aria-labelledby": "pairing-title" })}
    >
      {!bare && (
        <h2 id="pairing-title" className="text-title font-strong">
          {T.title}
        </h2>
      )}
      {codeStep && <p>{T.intro}</p>}
      {state.kind === "unavailable" && <p role="status">{T.unavailable}</p>}
      {state.kind === "creating" && (
        <p role="status" className="flex items-center gap-1.5">
          <Spinner />
          {T.checking}
        </p>
      )}
      {state.kind === "invited" && (
        <div className="grid gap-4">
          {codeStep && (
            <>
              <div role="img" aria-label={T.qrLabel}>
                <QRCodeSVG value={state.qr} size={232} level="M" title={T.qrLabel} />
              </div>
              <p>{T.pasteHint}</p>
              <div className="grid gap-1">
                <span className="text-sm text-fg-muted">{T.codeLabel}</span>
                <code className="truncate whitespace-nowrap rounded-control border border-border bg-chip px-3 py-1.5 font-mono text-xs-plus">
                  {state.codePreview}
                </code>
              </div>
              <div aria-live="polite">
                <Button disabled={!state.canCopy} onPress={state.onCopy}>
                  {state.copied ? T.copied : T.copy}
                </Button>
              </div>
              {state.phone === "waiting" ? (
                <p role="status" className="flex items-center gap-1.5">
                  <Spinner />
                  {T.expiryScan(state.expiresAt)}
                </p>
              ) : (
                <p>{T.expiry(state.expiresAt)}</p>
              )}
            </>
          )}
          {state.phone !== "waiting" && <DigitsStep state={state} />}
          <div className="flex gap-2">
            {state.phone !== "waiting" && (
              <Button
                variant="primary"
                disabled={state.code.length !== 6 || state.submitting}
                onPress={state.onConfirm}
              >
                {T.confirm}
              </Button>
            )}
            <Button disabled={state.submitting} onPress={state.onCancel}>
              {T.cancel}
            </Button>
          </div>
        </div>
      )}
      {state.kind === "checking" && (
        <div className="grid gap-2">
          <p role="status" className="flex items-center gap-1.5">
            <Spinner />
            {T.checking}
          </p>
          <div>
            <Button onPress={state.onCancel}>{T.cancel}</Button>
          </div>
        </div>
      )}
      {state.kind === "unknown" && (
        <div className="grid gap-2">
          <p role="alert">{T.unknown}</p>
          <div>
            <Button onPress={state.onInspect}>{T.inspect}</Button>
          </div>
        </div>
      )}
      {state.kind === "completed" && (
        <div className="grid gap-2">
          <p role="status">{T.complete}</p>
          <EndActions again={T.pairAnother} onCreate={state.onCreate} onDone={onDone} />
        </div>
      )}
      {state.kind === "refused" && (
        <div className="grid gap-2">
          <p role="alert">{T.refused}</p>
          <EndActions again={D.retry} onCreate={state.onCreate} onDone={onDone} />
        </div>
      )}
      {state.kind === "already_added" && <p role="alert">{T.alreadyAdded}</p>}
      {state.kind === "phone_cancelled" && <p role="status">{T.phoneCancelled}</p>}
      {state.kind === "expired" && (
        <div className="grid gap-2">
          <p role="alert">{T.expired}</p>
          <EndActions again={D.retry} onCreate={state.onCreate} onDone={onDone} />
        </div>
      )}
      {state.kind === "sync_off" && (
        <div className="grid gap-2">
          <p role="alert">{T.syncOff}</p>
          {onGoToSync && (
            <div>
              <Button onPress={onGoToSync}>{T.goToSync}</Button>
            </div>
          )}
        </div>
      )}
      {(state.kind === "idle" ||
        state.kind === "already_added" ||
        state.kind === "phone_cancelled") && (
        <div>
          <Button onPress={state.onCreate}>{T.create}</Button>
        </div>
      )}
    </section>
  );
}
