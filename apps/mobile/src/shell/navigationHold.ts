// Holding the app's navigation (pure, module-level, tested in Node): while a hold is taken nothing from
// outside the app may navigate (a deep link, a notification tap). The app lock holds navigation while it
// is locked, so nothing can be pushed or presented under (or above) the lock screen; the deep-link
// redirect (`app/+native-intent.ts`) and the notification tap handler wait for `whenNavigationFree()`.

/** Why navigation is held. */
export type NavigationHoldReason = "lock";

const holds = new Set<symbol>();
const listeners = new Set<() => void>();
let waiting: (() => void)[] = [];

function changed(): void {
  for (const listener of [...listeners]) listener();
  if (holds.size > 0) return;
  const resolve = waiting;
  waiting = [];
  for (const done of resolve) done();
}

/**
 * Take a hold; returns its release (idempotent). Navigation is free again once every hold is released.
 */
export function holdNavigation(reason: NavigationHoldReason): () => void {
  const hold = Symbol(reason);
  holds.add(hold);
  if (holds.size === 1) changed();
  return () => {
    if (!holds.delete(hold)) return;
    if (holds.size === 0) changed();
  };
}

export function isNavigationHeld(): boolean {
  return holds.size > 0;
}

/** `useSyncExternalStore` source: called when navigation becomes held or free. */
export function subscribeNavigationHold(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Resolves when no hold is taken (at once when navigation is free now). */
export function whenNavigationFree(): Promise<void> {
  if (holds.size === 0) return Promise.resolve();
  return new Promise((resolve) => {
    waiting.push(resolve);
  });
}
