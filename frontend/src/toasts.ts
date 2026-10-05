// The toast stack (F5 R4): several toasts are visible at once, each with its own timer and its own
// action, so a second "Zapisano decyzję" never takes away the first one's "Cofnij". Pure (tested in
// tests/undo.test.mjs); ui.tsx renders it.

/** One optional action in a toast (e.g. `Cofnij`); the toast closes when it is clicked. */
export interface ToastAction { label: string; onClick: () => void }
export interface ToastItem { id: number; text: string; action?: ToastAction }

/** At most this many toasts at once. */
export const MAX_TOASTS = 4;

/** Add a toast at the end (newest last). Over the limit, the oldest toast without an action goes
 * first, so an undo stays reachable as long as possible; only when every toast has one, the oldest. */
export function pushToast(list: readonly ToastItem[], item: ToastItem, max = MAX_TOASTS): ToastItem[] {
  const next = [...list, item];
  while (next.length > max) {
    const plain = next.findIndex((t) => !t.action && t.id !== item.id);
    next.splice(plain >= 0 ? plain : 0, 1);
  }
  return next;
}

export const dropToast = (list: readonly ToastItem[], id: number): ToastItem[] => list.filter((t) => t.id !== id);
