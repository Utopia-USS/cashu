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
