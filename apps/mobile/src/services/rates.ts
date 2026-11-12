// NBP table A mid rates on the phone: the converted net worth (CLAUDE.md rule 5, a labelled NBP
// conversion beside every currency's own amount) needs them in this device's price cache. Fetched
// straight from api.nbp.pl over `@cashu/market`; the request names one currency code and a date
// range, nothing else leaves the phone. Device-local, never synced.
import { addDays, type IsoDate, parseDateTime } from "@cashu/domain";
import { type Currency, toCurrency } from "@cashu/domain/investments";
import { type FetchLike, MarketHttp, NbpFxSource } from "@cashu/market/nbp";
import type { SqlPriceCache } from "@cashu/store/investments/local";

const PROVIDER = "nbp";
/** How far back the first fetch of a currency reaches (the 12-month history plus a margin). */
const HISTORY_DAYS = 400;
/**
 * A currency is fresh when its newest cached table is at most this many days old: Friday's table
 * still counts on Monday. A longer gap (a holiday after a weekend) costs one more request.
 */
const FRESH_DAYS = 3;
/** Per request, connect plus the whole body. */
const TIMEOUT_MS = 10_000;

export interface RatesRefresh {
  /** The currencies whose rates were fetched and stored. */
  readonly fetched: string[];
  /** "fresh": every currency was fresh; "offline": a request failed (the rest waits for the next run). */
  readonly skipped: "fresh" | "offline" | null;
}

/** `fetch` with a 10 s limit on the request and its body; the timer is cleared either way. */
function timed(fetch: FetchLike): FetchLike {
  return async (url, init) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const response = await fetch(url, { ...init, signal: controller.signal });
      const text = await response.text();
      return { status: response.status, headers: response.headers, text: async () => text };
    } finally {
      clearTimeout(timer);
    }
  };
}

/**
 * Fetches the NBP mid rates of every non-PLN currency the vault uses into the device cache. A currency
 * whose newest cached rate is at most 3 days before `today` is skipped; otherwise the fetch starts the
 * day after the newest cached rate (400 days back for a currency without any). Never throws: a failed
 * request ends the run with `skipped: "offline"`.
 */
export async function refreshRates(deps: {
  readonly prices: SqlPriceCache;
  readonly fetch: FetchLike;
  readonly now: () => number;
  readonly today: IsoDate;
  readonly currencies: readonly string[];
}): Promise<RatesRefresh> {
  const oldestFresh = addDays(deps.today, -FRESH_DAYS);
  const due: { quote: Currency; start: IsoDate }[] = [];
  for (const code of new Set(deps.currencies)) {
    if (code === "PLN") continue;
    let quote: Currency;
    try {
      quote = toCurrency(code);
    } catch {
      continue;
    }
    const newest = deps.prices.rates(PROVIDER, quote).at(-1)?.date ?? null;
    if (newest !== null && newest >= oldestFresh) continue;
    const floor = addDays(deps.today, -HISTORY_DAYS);
    const start = newest === null || newest < floor ? floor : addDays(newest, 1);
    due.push({ quote, start });
  }
  if (due.length === 0) return { fetched: [], skipped: "fresh" };
  const stamp = () => parseDateTime(new Date(deps.now()).toISOString());
  const http = new MarketHttp({
    fetch: timed(deps.fetch),
    // The phone tries again at the next activation instead of waiting here.
    maxRetries: 0,
    sleep: (seconds) => new Promise((resolve) => setTimeout(resolve, seconds * 1000)),
    clock: () => deps.now() / 1000,
    timeoutSignal: () => undefined,
  });
  const nbp = new NbpFxSource(http, { clock: stamp });
  const fetched: string[] = [];
  for (const { quote, start } of due) {
    try {
      const rates = await nbp.rates(quote, start, deps.today);
      deps.prices.upsertRates(
        PROVIDER,
        quote,
        rates.map((r) => ({ date: r.date, rate: r.rate, fetchedAt: r.fetchedAt })),
        stamp(),
      );
      fetched.push(quote);
    } catch {
      return { fetched, skipped: "offline" };
    }
  }
  return { fetched, skipped: null };
}
