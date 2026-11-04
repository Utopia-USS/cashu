import type { ReactNode, Ref } from "react";

export interface ButtonProps {
  /** Visible content: usually the translated label, or inline content such as a title with an amount. */
  children: ReactNode;
  onPress?: () => void;
  variant?: "primary" | "secondary" | "danger" | "ghost";
  size?: "sm" | "md" | "lg";
  disabled?: boolean;
  type?: "button" | "submit" | "reset";
  /** Layout only (margin, width, alignment); identity comes from `variant`. */
  className?: string;
  /** Accessible name when the visible content does not name the action (an arrow, a truncated title). */
  label?: string;
  /** Toggle state; a pressed button takes the selected look. */
  pressed?: boolean;
  /** Marks the button for the current page or view in a set (tabs, a file list); takes the selected look. */
  current?: "page";
  /** Whether the region this button discloses is open. */
  expanded?: boolean;
  /** Tooltip text (desktop). */
  title?: string;
  /** The DOM button on desktop, for focus management; ignored on native. */
  ref?: Ref<HTMLButtonElement>;
}
