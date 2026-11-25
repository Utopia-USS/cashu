import { type RefObject, useEffect } from "react";

/**
 * Moves focus to `target` each time it becomes shown inside a dialog (DV2 item 10: dialog R's recovery
 * words, dialog F's primary button). Call it in the component that renders the `Dialog`: a parent's
 * effect runs after the Modal's own initial focus, so this one wins; the dialog opens with
 * `focus="panel"`, so the close glyph never shows a ring while the target is not there yet.
 */
export function useFocusWhenShown(target: RefObject<HTMLElement | null>, shown: boolean): void {
  useEffect(() => {
    if (shown) target.current?.focus();
  }, [target, shown]);
}
