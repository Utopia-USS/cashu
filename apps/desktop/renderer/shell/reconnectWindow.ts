// The desktop's reconnect window: how long a lost or restarting host connection may look like a failure
// before the window says so. A host hands over to a new process after turning sync on, removing a
// profile's data from sync or admitting a device (exit 75, a new host within a few seconds); just before
// it goes, it fails the live queries of the window. The store client asks such a query again on a
// bounded back-off (`QUERY_ERROR_RETRY_MS`) and keeps the last values shown meanwhile; only a failure
// that outlives the window reaches the failure screen, which itself retries a few times
// (`FailureRetry`) before it waits for the button. Screens that show "unavailable" for missing data use
// `useOutlasts` with the same window.
import { useEffect, useState } from "react";

/** The store client's re-asks of a failed live query (ms); the last delay only waits for the answer. */
export const QUERY_ERROR_RETRY_MS: readonly number[] = [500, 1_000, 2_000, 4_000];

/** The whole reconnect window (7.5 s). */
export const RECONNECT_WINDOW_MS = QUERY_ERROR_RETRY_MS.reduce((sum, ms) => sum + ms, 0);

/** The failure screen's own retries (ms): after these it waits for the button. */
export const FAILURE_RETRY_MS: readonly number[] = [1_000, 3_000, 9_000];

/** A failure this long after the last one starts the retries from the first again. */
export const FAILURE_QUIET_MS = 60_000;

/**
 * The failure screen's retry budget. The screen is unmounted by every retry (its boundary renders the
 * tree again), so the count lives here, across mounts: consecutive failures use up the delays, a
 * failure after a quiet period starts again.
 */
export class FailureRetry {
  #attempt = 0;
  #last = Number.NEGATIVE_INFINITY;
  private readonly delays: readonly number[];
  private readonly quietMs: number;

  constructor(delays: readonly number[] = FAILURE_RETRY_MS, quietMs = FAILURE_QUIET_MS) {
    this.delays = delays;
    this.quietMs = quietMs;
  }

  /** A failure showed at `now`: the delay before the next automatic retry, or null (button only). */
  next(now: number): number | null {
    if (now - this.#last >= this.quietMs) this.#attempt = 0;
    this.#last = now;
    const delay = this.delays[this.#attempt];
    if (delay === undefined) return null;
    this.#attempt += 1;
    return delay;
  }
}

/** The window's one budget: every failure screen of this window shares it. */
export const failureRetry = new FailureRetry();

/**
 * True once `active` has held for `ms` without a break: a state that only a handover causes for a moment
 * (a missing list, a refused read) is never shown, one that outlasts the reconnect window is.
 */
export function useOutlasts(active: boolean, ms: number = RECONNECT_WINDOW_MS): boolean {
  const [outlasted, setOutlasted] = useState(false);
  useEffect(() => {
    if (!active) return;
    const timer = setTimeout(() => setOutlasted(true), ms);
    return () => {
      clearTimeout(timer);
      setOutlasted(false);
    };
  }, [active, ms]);
  return active && outlasted;
}
