import type { FormEventHandler, PointerEventHandler, ReactNode } from "react";

export interface CardProps {
  children: ReactNode;
  /** Desktop element, for its landmark semantics; native always renders a view. */
  as?: "section" | "aside" | "nav" | "form" | "div" | "p";
  /** Inner spacing: `md` for dense dashboard panels, `lg` for page-level forms and summaries. */
  padding?: "md" | "lg";
  /** Accessible name when no visible heading names the card. */
  label?: string;
  /** Id of the visible heading that names the card. */
  labelledBy?: string;
  /** Live-region role for a card that reports a status or a failure. */
  role?: "alert" | "status";
  id?: string;
  testID?: string;
  /** Desktop only: submit handler when `as="form"`. */
  onSubmit?: FormEventHandler<HTMLElement>;
  /** Desktop only: pointer handlers for swipe gestures on the card. */
  onPointerDown?: PointerEventHandler<HTMLElement>;
  onPointerUp?: PointerEventHandler<HTMLElement>;
  /** Layout only (grid, gap, margin, width); identity comes from the card. */
  className?: string;
}
