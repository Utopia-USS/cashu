import type { ReactNode } from "react";
import { Stepper } from "../lists/Stepper.js";
import { Modal } from "./Modal.js";
import { S } from "./overlay.strings.js";

/** The close glyph of the old `.icon-btn` (a symbol, not a word). */
const CLOSE_GLYPH = "✕";

export interface WizardFrameProps {
  /** `page` = the first launch (old `.wrap` > `.wizard`, no frame); `overlay` = over the dimmed app (old
   * `.overlay .wizard`: page-colour card with a shadow, Esc and the close glyph close it, the scrim does not). */
  mode: "page" | "overlay";
  /** Accessible name of the page / dialog. */
  label: string;
  /** The h1 (old `.wizard h1`, 22px). */
  title: ReactNode;
  /** The muted lead under the title (old `.lead`). */
  lead?: ReactNode;
  steps: readonly string[];
  /** 0-based step shown as current in the stepper. */
  current: number;
  /** Overlay only: Esc and the close glyph; omitted = the wizard cannot be closed now. */
  onClose?: () => void;
  testID?: string;
  /** The steps' card content (old `.wizard > .card`). */
  children: ReactNode;
}

/** A step-by-step flow (old core/Wizard.tsx frame): title, lead, stepper, then the card with the step. */
export function WizardFrame({
  mode,
  label,
  title,
  lead,
  steps,
  current,
  onClose,
  testID,
  children,
}: WizardFrameProps) {
  const body = (
    <>
      <h1 className="mt-0 mb-1 text-3xl-plus font-bold tracking-heading">{title}</h1>
      {lead != null && <p className="mt-0 mb-4.5 text-md text-fg-muted">{lead}</p>}
      <Stepper steps={steps} current={current} />
      <div className="rounded-widget border border-border bg-surface-raised px-4.5 py-4">
        {children}
      </div>
    </>
  );
  if (mode === "page")
    return (
      <main
        aria-label={label}
        data-testid={testID}
        className="min-h-screen bg-surface px-5 pt-6 pb-17.5 text-base leading-normal text-fg"
      >
        <div className="mx-auto mt-12 max-w-170">{body}</div>
      </main>
    );
  return (
    <Modal label={label} placement="overlay" closeOnBackdrop={false} onClose={() => onClose?.()}>
      <div
        data-testid={testID}
        className="relative mx-auto mt-12 max-w-170 rounded-widget border border-border bg-surface px-6.5 pt-5.5 pb-6 text-base leading-normal shadow-toast"
      >
        {onClose && (
          <button
            type="button"
            title={S.closeEsc}
            aria-label={S.close}
            onClick={onClose}
            className="absolute top-3.5 right-3.5 cursor-pointer border-0 bg-transparent px-1.5 py-0.5 font-control text-base leading-control text-fg-muted hover:text-fg"
          >
            {CLOSE_GLYPH}
          </button>
        )}
        {body}
      </div>
    </Modal>
  );
}
