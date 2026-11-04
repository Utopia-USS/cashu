import type { KeyboardEventHandler, ReactNode, Ref } from "react";

export interface ModalProps {
  /** Accessible name of the dialog (shown as the sheet title on native). */
  label: string;
  /** Id of a visible heading inside the panel that names the dialog; replaces `label` as the DOM name. */
  labelledBy?: string;
  onClose(): void;
  children: ReactNode;
  /** Where the panel sits: `fill` (inset sheet, default), `center` (content-height dialog), `end`
   * (full-height side drawer) or `screen` (the whole window, for a flow such as a wizard). */
  placement?: "fill" | "center" | "end" | "screen";
  /** Layout only (width, inner layout); identity comes from `placement`. */
  className?: string;
  panelRef?: Ref<HTMLElement>;
  onKeyDown?: KeyboardEventHandler<HTMLElement>;
  focus?: "first" | "panel";
}
