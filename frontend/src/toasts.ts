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

/** An undo toast (one with an action) stays at least this long, so a keyboard user can reach it (F7 FE14). */
export const MIN_ACTION_MS = 20000;

/** Per-toast timers that can be paused (hover, focus inside the stack, hidden window) and resumed with the
 * time each toast had left (F7 FE14: a toast never expires while the owner is on it). `schedule` / `cancel`
 * are setTimeout / clearTimeout in the app and fakes in tests. */
export function toastTimers(
  onExpire: (id: number) => void,
  schedule: (fn: () => void, ms: number) => unknown = (fn, ms) => setTimeout(fn, ms),
  cancel: (h: unknown) => void = (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  now: () => number = Date.now,
) {
  const items = new Map<number, { left: number; since: number; handle: unknown }>();
  let paused = false;
  const arm = (id: number) => {
    const t = items.get(id)!;
    t.since = now();
    t.handle = schedule(() => { items.delete(id); onExpire(id); }, t.left);
  };
  return {
    start(id: number, ms: number) {
      items.set(id, { left: ms, since: now(), handle: null });
      if (!paused) arm(id);
    },
    stop(id: number) {
      const t = items.get(id);
      if (t?.handle != null) cancel(t.handle);
      items.delete(id);
    },
    pause() {
      if (paused) return;
      paused = true;
      for (const t of items.values()) {
        if (t.handle != null) cancel(t.handle);
        t.handle = null;
        t.left = Math.max(0, t.left - (now() - t.since));
      }
    },
    resume() {
      if (!paused) return;
      paused = false;
      for (const id of items.keys()) arm(id);
    },
    get paused() { return paused; },
    left(id: number) { const t = items.get(id); return t ? (paused || t.handle == null ? t.left : Math.max(0, t.left - (now() - t.since))) : null; },
    clear() { for (const t of items.values()) if (t.handle != null) cancel(t.handle); items.clear(); },
  };
}
