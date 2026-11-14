import type { ReactNode, Ref } from "react";

export interface ButtonProps {
  /** Visible content: usually the translated label, or inline content such as a title with an amount. */
  children: ReactNode;
  /** Press handler. When it returns a promise, the button is busy until it settles: it ignores further
   * presses and shows a spinner in place of its content (after a short delay, so fast actions never
   * blink). Return the action's promise (`onPress={state.save}`, not `() => void state.save()`). */
  onPress?: () => unknown;
  /** Busy from the outside (a form submit, an action started elsewhere): the same spinner and blocking
   * as a pending `onPress` promise. */
  pending?: boolean;
  /** `secondary` is the plain chip button; `ghost` the same on a transparent face; `link` an underlined
   * text action; `icon` a bare glyph for a removing action (turns red on hover); `glyph` a neutral bare glyph
   * (copy). Both glyph variants need `label`; on the phone their `children` is an `Icon` node. */
  variant?: "primary" | "secondary" | "danger" | "ghost" | "link" | "icon" | "glyph";
  /** Box sizes for the framed variants; for `link`: sm = widget footer, md = widget body, lg = plain text. */
  size?: "sm" | "md" | "lg";
  /** Label weight (default regular, like the Python app's buttons). */
  weight?: "regular" | "strong";
  disabled?: boolean;
  type?: "button" | "submit" | "reset";
  /** Full width of the parent (sheet and footer actions on the phone). */
  block?: boolean;
  /** Layout only (margin, width, alignment); identity comes from `variant`. */
  className?: string;
  /** Accessible name when the visible content does not name the action (an arrow, a truncated title). */
  label?: string;
  /** Toggle state; a pressed button takes the selected look (a bare glyph on the phone turns accent). */
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
