// Automatic price refresh (P10): one global store per profile, so however many components mount the driver the
// server gets one request at a time. The app asks once when it opens and then every 15 minutes while it is visible
// (rules in priceRefreshLogic.ts); when new quotes were stored every investments view and the net worth on screen
// re-read (pricesChanged). The driver is mounted by the investments header tag (always in the shell header).
import { useEffect, useSyncExternalStore } from "react";
import { postPriceRefresh, pricesChanged } from "./api";
import { nextRefreshAt, type PriceRefreshClock, refreshDue, storedNewPrices } from "./priceRefreshLogic";

export interface PriceRefreshState extends PriceRefreshClock {
  /** Server time of the last answered refresh. */
  lastFinishedAt: string | null;
  lastStatus: string | null;
}

const INITIAL: PriceRefreshState = { running: false, nextAt: 0, lastFinishedAt: null, lastStatus: null };
const states = new Map<string, PriceRefreshState>();
const subs = new Set<() => void>();
const get = (slug: string): PriceRefreshState => states.get(slug) ?? INITIAL;
function set(slug: string, patch: Partial<PriceRefreshState>): void {
  states.set(slug, { ...get(slug), ...patch });
  subs.forEach((f) => f());
}
const subscribe = (f: () => void) => { subs.add(f); return () => { subs.delete(f); }; };

const visible = () => typeof document === "undefined" || !document.hidden;

/** Ask the server for fresh quotes when it is time (see refreshDue); never throws. */
export async function refreshPricesIfDue(slug: string): Promise<void> {
  if (!refreshDue(get(slug), Date.now(), visible())) return;
  set(slug, { running: true });
  let status: string | null = null;
  try {
    const r = await postPriceRefresh(slug);
    status = r.status;
    set(slug, { lastFinishedAt: r.finished_at, lastStatus: r.status });
    if (storedNewPrices(r)) pricesChanged(slug);
  } catch {
    status = "error";
    set(slug, { lastStatus: status });
  } finally {
    set(slug, { running: false, nextAt: nextRefreshAt(status, Date.now()) });
  }
}

/** The refresh state of a profile (read only). */
export function usePriceRefreshState(slug: string): PriceRefreshState {
  return useSyncExternalStore(subscribe, () => get(slug));
}

/** Drives the refresh: on mount, every minute's check, when the window becomes visible or focused. */
export function usePriceRefresh(slug: string): PriceRefreshState {
  useEffect(() => {
    const tick = () => { void refreshPricesIfDue(slug); };
    tick();
    const t = setInterval(tick, 60_000);
    document.addEventListener("visibilitychange", tick);
    window.addEventListener("focus", tick);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", tick);
      window.removeEventListener("focus", tick);
    };
  }, [slug]);
  return usePriceRefreshState(slug);
}
