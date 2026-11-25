// The failure screen's automatic retry: while the window's retry budget lasts (reconnect window,
// `failureRetry`), the screen asks the failed live queries again and renders its boundary's tree again
// after a bounded back-off. A failure that keeps coming back uses up the budget and then waits for the
// button. A screen without a boundary to reset (no `reset`) never retries on its own.
import { useStoreClient } from "@cashu/store-react";
import { useEffect, useRef, useState } from "react";
import { type FailureRetry, failureRetry } from "./reconnectWindow.js";

export function useFailureRetry(
  reset: (() => void) | undefined,
  budget: FailureRetry = failureRetry,
): void {
  const client = useStoreClient();
  // A retry that fails again may keep this very screen (its boundary never committed the tree in
  // between) or mount a new one: either way the next attempt takes the next step of the shared budget.
  const [attempt, setAttempt] = useState(0);
  // One budget step per attempt, taken when it commits: a render React throws away takes none, and a
  // new `reset` reference only moves the timer.
  const taken = useRef<{ readonly attempt: number; readonly delay: number | null } | null>(null);
  useEffect(() => {
    if (reset === undefined) return;
    if (taken.current?.attempt !== attempt)
      taken.current = { attempt, delay: budget.next(Date.now()) };
    const { delay } = taken.current;
    if (delay === null) return;
    const timer = setTimeout(() => {
      client.retryFailed?.();
      reset();
      setAttempt(attempt + 1);
    }, delay);
    return () => clearTimeout(timer);
  }, [reset, budget, client, attempt]);
}
