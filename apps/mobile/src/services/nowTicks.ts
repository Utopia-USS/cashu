// The shell's time boundaries (local midnight, return from the background; `shell/useNow.ts`) as a
// change source, so live investments reads whose answer depends on the clock (review due, signal ages)
// re-run when the day moves on. Time alone never notifies a query (`InvestmentScreenClock`); this does.
import type { ChangeSource } from "@cashu/store/query";

const listeners = new Set<() => void>();

export const nowTicks: ChangeSource = {
  subscribe(listener) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};

/** Called by the shell's clock on each boundary. */
export function emitNowTick(): void {
  for (const listener of [...listeners]) listener();
}
