import { QRCodeSVG } from "qrcode.react";
import { T } from "./Pairing.strings.js";

export type PairingViewState =
  | { kind: "unavailable" }
  | { kind: "idle"; onCreate(): void }
  | { kind: "creating" }
  | {
      kind: "invited";
      qr: string;
      expiresAt: string;
      code: string;
      onCodeChange(code: string): void;
      onConfirm(): void;
      onCancel(): void;
      onCopy(): void;
      canCopy: boolean;
      submitting: boolean;
    }
  | { kind: "checking" }
  | { kind: "unknown"; onInspect(): void }
  | { kind: "completed"; onCreate(): void }
  | { kind: "refused" | "expired"; onCreate(): void };

const button =
  "rounded-sm border border-border px-3 py-2 hover:bg-surface-sunken disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-accent";

export function PairingView({ state }: { state: PairingViewState }) {
  return (
    <section className="grid gap-4" aria-labelledby="pairing-title">
      <h2 id="pairing-title" className="text-title font-strong">
        {T.title}
      </h2>
      <p>{T.intro}</p>
      {state.kind === "unavailable" && <p role="status">{T.unavailable}</p>}
      {state.kind === "creating" && <p role="status">{T.checking}</p>}
      {state.kind === "invited" && (
        <div className="grid gap-4">
          <div role="img" aria-label={T.qrLabel}>
            <QRCodeSVG value={state.qr} size={232} level="M" title={T.qrLabel} />
          </div>
          <p>{T.pasteHint}</p>
          <button className={button} type="button" disabled={!state.canCopy} onClick={state.onCopy}>
            {T.copy}
          </button>
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
            <button
              className={button}
              type="button"
              disabled={state.code.length !== 6 || state.submitting}
              onClick={state.onConfirm}
            >
              {T.confirm}
            </button>
            <button
              className={button}
              type="button"
              disabled={state.submitting}
              onClick={state.onCancel}
            >
              {T.cancel}
            </button>
          </div>
        </div>
      )}
      {state.kind === "checking" && <p role="status">{T.checking}</p>}
      {state.kind === "unknown" && (
        <div className="grid gap-2">
          <p role="alert">{T.unknown}</p>
          <button className={button} type="button" onClick={state.onInspect}>
            {T.inspect}
          </button>
        </div>
      )}
      {state.kind === "completed" && <p role="status">{T.complete}</p>}
      {state.kind === "refused" && <p role="alert">{T.refused}</p>}
      {state.kind === "expired" && <p role="alert">{T.expired}</p>}
      {(state.kind === "idle" ||
        state.kind === "completed" ||
        state.kind === "refused" ||
        state.kind === "expired") && (
        <button className={button} type="button" onClick={state.onCreate}>
          {T.create}
        </button>
      )}
    </section>
  );
}
