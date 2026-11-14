import { Button, Spinner } from "@cashu/ui";
import { QRCodeSVG } from "qrcode.react";
import { T } from "./Pairing.strings.js";

export type PairingViewState =
  | { kind: "unavailable" }
  | { kind: "idle"; onCreate(): Promise<void> }
  | { kind: "creating" }
  | {
      kind: "invited";
      qr: string;
      expiresAt: string;
      code: string;
      onCodeChange(code: string): void;
      onConfirm(): Promise<void>;
      onCancel(): Promise<void>;
      onCopy(): void;
      canCopy: boolean;
      submitting: boolean;
    }
  | { kind: "checking" }
  /** The phone is admitted; its first sync has not reached this Mac yet. */
  | { kind: "waiting" }
  | { kind: "unknown"; onInspect(): Promise<void> }
  | { kind: "completed"; onCreate(): Promise<void> }
  | { kind: "refused" | "expired" | "sync_off"; onCreate(): Promise<void> };

export function PairingView({
  state,
  onGoToSync,
}: {
  state: PairingViewState;
  /** Moves focus to the Sync row; absent when there is no Sync row (no sync config). */
  onGoToSync?: () => void;
}) {
  return (
    <section className="grid gap-4" aria-labelledby="pairing-title">
      <h2 id="pairing-title" className="text-title font-strong">
        {T.title}
      </h2>
      <p>{T.intro}</p>
      {state.kind === "unavailable" && <p role="status">{T.unavailable}</p>}
      {state.kind === "creating" && (
        <p role="status" className="flex items-center gap-1.5">
          <Spinner />
          {T.checking}
        </p>
      )}
      {state.kind === "invited" && (
        <div className="grid gap-4">
          <div role="img" aria-label={T.qrLabel}>
            <QRCodeSVG value={state.qr} size={232} level="M" title={T.qrLabel} />
          </div>
          <p>{T.pasteHint}</p>
          <div className="grid gap-1">
            <span className="text-sm text-fg-muted">{T.codeLabel}</span>
            <code className="select-all break-all rounded-control border border-border bg-chip px-3 py-1.5 font-mono text-xs-plus">
              {state.qr}
            </code>
          </div>
          <div>
            <Button disabled={!state.canCopy} onPress={state.onCopy}>
              {T.copy}
            </Button>
          </div>
          <p>
            {T.expiry} {state.expiresAt}
          </p>
          <p>{T.sasInstruction}</p>
          <label className="grid gap-2">
            <span>{T.sasLabel}</span>
            <input
              className="rounded-sm border border-border bg-surface px-3 py-2 focus-visible:outline-2 focus-visible:outline-accent"
              value={state.code}
              onChange={(event) =>
                state.onCodeChange(event.target.value.replace(/\D/g, "").slice(0, 6))
              }
              inputMode="numeric"
              pattern="[0-9]{6}"
              maxLength={6}
              autoComplete="off"
              spellCheck={false}
              disabled={state.submitting}
            />
          </label>
          <div className="flex gap-2">
            <Button
              disabled={state.code.length !== 6 || state.submitting}
              onPress={state.onConfirm}
            >
              {T.confirm}
            </Button>
            <Button disabled={state.submitting} onPress={state.onCancel}>
              {T.cancel}
            </Button>
          </div>
        </div>
      )}
      {state.kind === "checking" && (
        <p role="status" className="flex items-center gap-1.5">
          <Spinner />
          {T.checking}
        </p>
      )}
      {state.kind === "unknown" && (
        <div className="grid gap-2">
          <p role="alert">{T.unknown}</p>
          <Button onPress={state.onInspect}>{T.inspect}</Button>
        </div>
      )}
      {state.kind === "waiting" && (
        <p role="status" className="flex items-center gap-1.5">
          <Spinner />
          {T.waitingForPhone}
        </p>
      )}
      {state.kind === "completed" && <p role="status">{T.complete}</p>}
      {state.kind === "refused" && <p role="alert">{T.refused}</p>}
      {state.kind === "expired" && (
        <div className="grid gap-2">
          <p role="alert">{T.expired}</p>
          <div>
            <Button onPress={state.onCreate}>{T.newCode}</Button>
          </div>
        </div>
      )}
      {state.kind === "sync_off" && (
        <div className="grid gap-2">
          <p role="alert">{T.syncOff}</p>
          {onGoToSync && (
            <div>
              <Button variant="link" onPress={onGoToSync}>
                {T.goToSync}
              </Button>
            </div>
          )}
        </div>
      )}
      {(state.kind === "idle" || state.kind === "completed" || state.kind === "refused") && (
        <Button onPress={state.onCreate}>{T.create}</Button>
      )}
    </section>
  );
}
