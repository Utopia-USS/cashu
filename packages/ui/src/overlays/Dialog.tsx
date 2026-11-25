import type { KeyboardEventHandler, ReactNode, Ref } from "react";
import { Modal } from "./Modal.js";
import { S } from "./overlay.strings.js";

/** The close glyph of the old `.icon-btn` (a symbol, not a word). */
const CLOSE_GLYPH = "✕";

export interface DialogProps {
  /** Bold head title (old `.dh strong`, 15px). */
  title: ReactNode;
  /** Accessible name of the dialog. */
  label: string;
  onClose(): void;
  children: ReactNode;
  /** `wide` = the old signals dialog `.sdlg` (1120px, the body scrolls, a widget-like foot); `narrow` = the
   * old decision dialog `.ddlg` (560px at 10vh, the whole card scrolls, the body a 10px grid). */
  size?: "wide" | "narrow";
  /** Head items after the title (tags, segments); the head wraps. */
  head?: ReactNode;
  /** Head items right before the close button (a muted keys hint: hidden at <= 760px). */
  hint?: ReactNode;
  /** Foot band (old `.wf` with the dialog's bottom radius); wide only. */
  footer?: ReactNode;
  /** Initial focus: the first control (default) or the panel itself (the old `focus: "panel"`). */
  focus?: "first" | "panel";
  panelRef?: Ref<HTMLElement>;
  onKeyDown?: KeyboardEventHandler<HTMLElement>;
}

const frames = {
  wide: "top-12 flex max-h-[calc(100vh-96px)] w-[min(1120px,calc(100vw-48px))] min-w-0 flex-col max-narrow:top-3 max-narrow:max-h-[calc(100vh-24px)] max-narrow:w-[calc(100vw-16px)]",
  narrow:
    "top-[10vh] max-h-[80vh] w-[min(560px,calc(100vw-32px))] overflow-auto overscroll-contain",
} as const;
const heads = {
  wide: "flex flex-wrap items-center gap-2.5 border-b border-border px-4.5 py-3",
  narrow: "flex items-center gap-2 border-b border-border px-4.5 py-3",
} as const;
const bodies = {
  wide: "min-h-0 flex-1 overflow-auto overscroll-contain px-4.5 pt-2 pb-3.5",
  narrow: "grid gap-2.5 px-4.5 pt-3 pb-4",
} as const;

/** Centred card dialog over the scrim (old `.sdlg` / `.ddlg`: `.dh` head with the title, items, a spacer and
 * the close glyph; `.db` body; the `.wf` foot band). Behaviour from Modal: Esc, the scrim, browser back,
 * focus trap, scroll lock, focus back to the opener. */
export function Dialog({
  title,
  label,
  onClose,
  children,
  size = "wide",
  head,
  hint,
  footer,
  focus,
  panelRef,
  onKeyDown,
}: DialogProps) {
  return (
    <Modal
      label={label}
      onClose={onClose}
      placement="top"
      className={frames[size]}
      focus={focus}
      panelRef={panelRef}
      onKeyDown={onKeyDown}
    >
      <div className={heads[size]}>
        <strong className="text-base">{title}</strong>
        {head}
        <span className="flex-1" />
        {hint != null && <span className="text-xs text-fg-muted max-narrow:hidden">{hint}</span>}
        <button
          type="button"
          title={S.closeEsc}
          aria-label={S.close}
          onClick={onClose}
          className="cursor-pointer border-0 bg-transparent px-1.5 py-0.5 font-control text-base leading-control text-fg-muted hover:text-fg"
        >
          {CLOSE_GLYPH}
        </button>
      </div>
      <div className={bodies[size]}>{children}</div>
      {footer != null && size === "wide" && (
        <div className="flex flex-wrap items-center gap-x-3.5 gap-y-1.5 rounded-b-lg border-t border-border bg-subtle px-4 py-2 text-xs text-fg-muted [&_b]:font-strong [&_b]:text-fg [&_b]:tabular-nums">
          {footer}
        </div>
      )}
    </Modal>
  );
}
