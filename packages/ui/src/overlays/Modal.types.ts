import type { KeyboardEventHandler, ReactNode, Ref } from "react";

export interface ModalProps {
  /** Accessible name of the dialog (shown as the sheet title on native). */
  label: string;
  /** Id of a visible heading inside the panel that names the dialog; replaces `label` as the DOM name. */
  labelledBy?: string;
  /** Ids of elements that describe the dialog (validation or error text), as `aria-describedby`. */
  describedBy?: string;
  onClose(): void;
  children: ReactNode;
  /** Where the panel sits: `fill` (inset sheet, default), `center` (content-height dialog), `end`
   * (full-height side drawer with an inner padding), `side` (the same drawer bare, for a head / body /
   * foot layout: see `Drawer`), `sheet` (a bottom sheet, 600px wide) or `screen` (the whole window, for a
   * flow such as a wizard). */
  placement?: "fill" | "center" | "end" | "side" | "sheet" | "screen";
  /** Maximum width of a `center` panel: `sm` (a short form) up to `2xl` (a wide table); default `lg`. */
  width?: "sm" | "md" | "lg" | "xl" | "2xl";
  /** Width in px of a `side` panel, capped at the window width; default 520. */
  sideWidth?: number;
  /** Whether a click on the backdrop closes the dialog (default true). Forms that keep a draft turn
   * it off so a stray click cannot discard the draft; Escape and browser back still close. */
  closeOnBackdrop?: boolean;
  /** Layout only (width, inner layout); identity comes from `placement`. */
  className?: string;
  panelRef?: Ref<HTMLElement>;
  onKeyDown?: KeyboardEventHandler<HTMLElement>;
  focus?: "first" | "panel";
}
