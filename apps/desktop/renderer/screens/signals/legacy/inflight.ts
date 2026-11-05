// ab24ab6 inflight.ts + hooks.ts useInFlight: one request at a time per surface (F7 FE2: a double click must not
// save twice), and the post-write lock that keeps a row locked until the data shows its new state (F7 fix F1).
import { useState } from "react";

interface InFlight {
  readonly busy: boolean;
  /** Run `fn` unless a run is in flight; returns its result, or undefined when skipped. */
  run<T>(fn: () => Promise<T>): Promise<T | undefined>;
}

function singleFlight(onChange?: (busy: boolean) => void): InFlight {
  let busy = false;
  return {
    get busy() {
      return busy;
    },
    async run<T>(fn: () => Promise<T>): Promise<T | undefined> {
      if (busy) return undefined;
      busy = true;
      onChange?.(true);
      try {
        return await fn();
      } finally {
        busy = false;
        onChange?.(false);
      }
    },
  };
}

/** Locked while a lock was taken and the data still shows the key it was taken at. */
export function stillLocked(lockKey: string | null | undefined, currentKey: string): boolean {
  return lockKey != null && lockKey === currentKey;
}

export function useInFlight(): { busy: boolean; run: InFlight["run"] } {
  const [busy, setBusy] = useState(false);
  const [guard] = useState(() => singleFlight(setBusy));
  return { busy, run: guard.run.bind(guard) };
}
