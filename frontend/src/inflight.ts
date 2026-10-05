// In-flight guard for submit buttons (F7 FE2): a second click while the first request runs does nothing,
// so a double click on "Potwierdź" or "Zamknij przegląd" records one decision / one review. The guard is
// synchronous (a flag, not React state), so two clicks in the same frame cannot both pass. Pure; tested in
// tests/inflight.test.mjs; `useInFlight` in hooks.ts adds the `busy` state that disables the button.

export interface InFlight {
  readonly busy: boolean;
  /** Run `fn` unless a run is in flight; returns its result, or undefined when skipped. */
  run<T>(fn: () => Promise<T>): Promise<T | undefined>;
}

export function singleFlight(onChange?: (busy: boolean) => void): InFlight {
  let busy = false;
  return {
    get busy() { return busy; },
    async run<T>(fn: () => Promise<T>): Promise<T | undefined> {
      if (busy) return undefined;
      busy = true;
      onChange?.(true);
      try { return await fn(); } finally { busy = false; onChange?.(false); }
    },
  };
}

// Post-write lock (F7 fix pass F1): the guard above releases when the POST answers, but the item keeps its
// buttons until the parent's reload brings the new server state. The caller records the key of the state
// the write changes (e.g. the signal's decision ids) on success; while the data still shows that key the
// item stays locked. The caller clears the lock itself on undo (undo brings the old key back).

/** Locked while a lock was taken and the data still shows the key it was taken at. */
export function stillLocked(lockKey: string | null, currentKey: string): boolean {
  return lockKey != null && lockKey === currentKey;
}
