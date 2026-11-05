// The toast stack (old frontend toasts.ts, verbatim behaviour): several toasts at once, each with its own
// timer and action, so a second "saved" never takes away the first one's undo. Pure; Toast.tsx renders it.

/** One optional action in a toast (e.g. an undo); the toast closes when it is clicked. */
export interface ToastAction {
  label: string;
  onClick(): void;
}

export interface ToastItem {
  id: number;
  text: string;
  action?: ToastAction;
}

/** At most this many toasts at once. */
const MAX_TOASTS = 4;

/** Add a toast at the end (newest last). Over the limit the oldest toast without an action goes first, so
 * an undo stays reachable as long as possible; only when every toast has one, the oldest. */
export function pushToast(
  list: readonly ToastItem[],
  item: ToastItem,
  max = MAX_TOASTS,
): ToastItem[] {
  const next = [...list, item];
  while (next.length > max) {
    const plain = next.findIndex((t) => !t.action && t.id !== item.id);
    next.splice(Math.max(plain, 0), 1);
  }
  return next;
}

export const dropToast = (list: readonly ToastItem[], id: number): ToastItem[] =>
  list.filter((t) => t.id !== id);

/** A toast with an action stays at least this long, so a keyboard user can reach it. */
export const MIN_ACTION_MS = 20000;

interface Timer {
  left: number;
  since: number;
  handle: ReturnType<typeof setTimeout> | null;
}

/** Per-toast timers that pause (hover, focus inside the stack, hidden window) and resume with the time each
 * toast had left. */
export function toastTimers(onExpire: (id: number) => void, now: () => number = Date.now) {
  const items = new Map<number, Timer>();
  let paused = false;
  const arm = (id: number, timer: Timer) => {
    timer.since = now();
    timer.handle = setTimeout(() => {
      items.delete(id);
      onExpire(id);
    }, timer.left);
  };
  return {
    start(id: number, ms: number) {
      const timer: Timer = { left: ms, since: now(), handle: null };
      items.set(id, timer);
      if (!paused) arm(id, timer);
    },
    stop(id: number) {
      const timer = items.get(id);
      if (timer?.handle != null) clearTimeout(timer.handle);
      items.delete(id);
    },
    pause() {
      if (paused) return;
      paused = true;
      for (const timer of items.values()) {
        if (timer.handle != null) clearTimeout(timer.handle);
        timer.handle = null;
        timer.left = Math.max(0, timer.left - (now() - timer.since));
      }
    },
    resume() {
      if (!paused) return;
      paused = false;
      for (const [id, timer] of items) arm(id, timer);
    },
    clear() {
      for (const timer of items.values()) if (timer.handle != null) clearTimeout(timer.handle);
      items.clear();
    },
  };
}
