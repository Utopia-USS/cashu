// Pure rules of the automatic price refresh (P10; the store and the hook live in priceRefresh.ts): when the app
// asks the server for fresh quotes and whether the answer changed anything. Tested in tests/price-refresh.test.mjs.

/** While the app is open and visible: every 15 minutes (the server throttles to 10 on its own). */
export const PRICE_REFRESH_EVERY_MS = 15 * 60_000;
/** A daily check held the lock: ask again a minute later. */
export const PRICE_REFRESH_BUSY_RETRY_MS = 60_000;

export interface PriceRefreshClock {
  running: boolean;
  /** Epoch ms of the next allowed refresh; 0 = due now (the app just opened). */
  nextAt: number;
}

/** A refresh starts only on a visible page, never next to one in flight, once its time has come. */
export function refreshDue(st: PriceRefreshClock, now: number, visible: boolean): boolean {
  return visible && !st.running && now >= st.nextAt;
}

/** The next refresh after an answer: a minute after `busy`, never while the server has it turned off, else in
 * 15 minutes (also after a failure: no retry storm while offline). */
export function nextRefreshAt(status: string | null, now: number): number {
  if (status === "busy") return now + PRICE_REFRESH_BUSY_RETRY_MS;
  if (status === "disabled") return Number.POSITIVE_INFINITY;
  return now + PRICE_REFRESH_EVERY_MS;
}

/** The answer stored new quotes or rates (a throttled `cached` answer is old news). */
export function storedNewPrices(r: { cached?: boolean; updated?: number; fx_updated?: number } | null): boolean {
  return !!r && !r.cached && ((r.updated ?? 0) > 0 || (r.fx_updated ?? 0) > 0);
}
