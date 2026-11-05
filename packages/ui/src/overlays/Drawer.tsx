import type { ReactNode } from "react";
import { Modal } from "./Modal.js";
import { S } from "./overlay.strings.js";

/** The close glyph of the old `.icon-btn` (a symbol, not a word). */
const CLOSE_GLYPH = "\u2715";

export interface DrawerProps {
  /** Bold head title. */
  title: ReactNode;
  /** Accessible name of the dialog (the title as plain text). */
  label: string;
  onClose(): void;
  children: ReactNode;
  /** Next to the title (e.g. a `Tag` with the account). */
  tag?: ReactNode;
  /** Foot row (actions; put `<span className="flex-1" />` before right-aligned buttons). */
  footer?: ReactNode;
  /** Panel width in px, capped at the window width (default 520). */
  width?: number;
}

/** Right side panel over the scrim (old ui.tsx `Drawer`: `.dh` head, `.db` scrolling body, `.df` foot). Esc,
 * the scrim, the close button and browser back close it; focus is trapped inside, starts on the first
 * control of the body (or `[data-autofocus]`) and returns to the opener; the page does not scroll. */
export function Drawer({ title, label, onClose, children, tag, footer, width = 520 }: DrawerProps) {
  return (
    <Modal label={label} onClose={onClose} placement="side" sideWidth={width}>
      <div className="flex items-center gap-2.5 border-b border-border px-4.5 py-3.5">
        <strong className="text-base">{title}</strong>
        {tag}
        <span className="flex-1" />
        <button
          type="button"
          title={S.closeEsc}
          aria-label={S.close}
          onClick={onClose}
          className="cursor-pointer border-0 bg-transparent px-1.5 py-0.5 text-base leading-control text-fg-muted hover:text-fg"
        >
          {CLOSE_GLYPH}
        </button>
      </div>
      <div data-modal-body="" className="flex-1 overflow-auto px-4.5 py-3.5">
        {children}
      </div>
      {footer != null && (
        <div className="flex flex-wrap items-center gap-2 border-t border-border bg-surface-raised px-4.5 py-3">
          {footer}
        </div>
      )}
    </Modal>
  );
}
