/**
 * The market calendar feeds over HTTP and their device-local cache (`market/calendar.py`
 * `fetch_feeds` / `feeds`). Parsing, freshness and the profile's view are pure
 * (`@cashu/domain` `investments.market`: `parseFf`, `parseNasdaq`, `isFresh`, `calendarEvents`).
 *
 * Privacy: both feeds are fetched as whole public lists; no symbol, amount or profile detail is sent.
 * The fetched lists are shared by every profile and cached on the device for `CACHE_TTL_SECONDS`; a
 * failed feed keeps the last cache's rows, is marked stale and retried after `RETRY_AFTER_SECONDS`.
 * Without a fetcher nothing is fetched (the feeds are offline): the leader passes one, tests pass fakes.
 */

import { type DateTime, formatDateTime } from "@cashu/domain";
import { market } from "@cashu/domain/investments";
import { MarketHttp, type MarketHttpOptions } from "./http.js";

const {
  DAYS,
  PyJsonError,
  SourceException,
  emptyFeeds,
  isFresh,
  mergeFetched,
  parseFf,
  parseNasdaq,
  uniqueRows,
  weekdaysFrom,
} = market;

export const FF_URLS: readonly string[] = [
  "https://nfs.faireconomy.media/ff_calendar_thisweek.json",
  "https://nfs.faireconomy.media/ff_calendar_nextweek.json",
];

export function nasdaqUrl(day: string): string {
  return `https://api.nasdaq.com/api/calendar/earnings?date=${day}`;
}

export const CALENDAR_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) " +
    "Chrome/130.0 Safari/537.36",
  Accept: "application/json, text/plain, */*",
});

/** Seconds per feed request. */
export const CALENDAR_TIMEOUT = 10.0;
/** Nasdaq days fetched at once. */
const NASDAQ_WORKERS = 4;

/** `(today, days) -> feeds` (`fetched_at`, `from`, `to`, `macro`, `earnings`, `errors`). */
export type FeedFetcher = (today: string, days: number) => Promise<market.CalendarFeeds>;

/** The device-local cache file of the feeds (`market/calendar.json` in the data dir on the leader). */
export interface CalendarCacheStore {
  /** The cached JSON, or null when absent or unreadable. */
  read(): Promise<unknown>;
  /** Replaces the cache atomically (write a temp file, then rename). */
  write(data: market.CalendarFeeds): Promise<void>;
}

/**
 * The HTTP client of the feeds: no retries and no pacing (one try per feed, as in Python), the
 * calendar timeout. `fetch`, `sleep` and `clock` come from the app root.
 */
export function calendarHttp(
  options: Pick<MarketHttpOptions, "fetch" | "sleep" | "clock" | "timeoutSignal">,
): MarketHttp {
  return new MarketHttp({
    ...options,
    timeout: CALENDAR_TIMEOUT,
    maxRetries: 0,
    minHostInterval: 0,
  });
}

async function inOrder<T, R>(
  items: readonly T[],
  workers: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      out[index] = await fn(items[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(workers, items.length) }, worker));
  return out;
}

/**
 * The failures Python catches per feed request (`httpx.HTTPError`, `ValueError`, `TypeError` /
 * `AttributeError`): a transport or status failure, an unparsable body, an unexpected shape.
 */
function isFeedFailure(error: unknown): boolean {
  return (
    error instanceof SourceException || error instanceof PyJsonError || error instanceof TypeError
  );
}

/** True for a status `raise_for_status` raises on. */
const failed = (status: number): boolean => status >= 400;

/**
 * Fetches both public feeds (`fetch_feeds`, best effort: each failed request adds an `errors` code).
 * `toLocal` converts a feed time to the device's wall time; `now` stamps `fetched_at`.
 */
export function feedFetcher(
  http: MarketHttp,
  options: { readonly toLocal: market.ToLocalTime; readonly now: () => DateTime },
): FeedFetcher {
  return async (today, days) => {
    const errors: string[] = [];
    const macro: market.MacroRow[] = [];
    for (const url of FF_URLS) {
      try {
        const response = await http.get(url, "forexfactory", { headers: CALENDAR_HEADERS });
        if (response.status === 404) continue; // next week's feed appears only late in the week
        if (failed(response.status))
          throw new SourceException("forexfactory", `HTTP ${response.status}`);
        macro.push(...parseFf(response.text, options.toLocal));
      } catch (error) {
        if (!isFeedFailure(error)) throw error;
        errors.push("macro_unavailable");
      }
    }
    const perDay = await inOrder(weekdaysFrom(today, days), NASDAQ_WORKERS, async (day) => {
      try {
        const response = await http.get(nasdaqUrl(day), "nasdaq", { headers: CALENDAR_HEADERS });
        if (failed(response.status)) return null;
        return parseNasdaq(response.text, day);
      } catch (error) {
        if (!isFeedFailure(error)) throw error;
        return null;
      }
    });
    const earnings: market.EarningsRow[] = [];
    for (const got of perDay) {
      if (got === null) errors.push("earnings_unavailable");
      else earnings.push(...got);
    }
    const empty = emptyFeeds(today, days, []);
    return {
      fetched_at: formatDateTime(options.now()),
      from: empty.from,
      to: empty.to,
      macro: uniqueRows(macro, ["date", "country", "title"]),
      earnings,
      errors: [...new Set(errors)].sort(),
    };
  };
}

export interface FeedsOptions {
  readonly cache: CalendarCacheStore;
  /** An aware timestamp (UTC). */
  readonly now: DateTime;
  readonly days?: number;
  /** Absent: offline (the cache, else empty feeds marked `offline`). */
  readonly fetch?: FeedFetcher;
}

/**
 * The cached feeds, refetched when older than the TTL or not covering the range (`feeds`). Resolves to
 * `[feeds, stale]`: `stale` when part of the last fetch failed (the failed part keeps the previous
 * cache's rows) or the feeds are offline.
 */
export async function feeds(
  today: string,
  options: FeedsOptions,
): Promise<[market.CalendarFeeds, boolean]> {
  const days = options.days ?? DAYS;
  const cached = await options.cache.read();
  if (isFresh(cached, today, days, options.now)) return [cached, cached.errors.length > 0];
  if (options.fetch === undefined) {
    const usable = cached !== null && typeof cached === "object" && Object.keys(cached).length > 0;
    return [usable ? (cached as market.CalendarFeeds) : emptyFeeds(today, days, ["offline"]), true];
  }
  const got = await options.fetch(today, days);
  const merged = mergeFetched(got, cached, formatDateTime(options.now));
  await options.cache.write(merged);
  return [merged, merged.errors.length > 0];
}

const two = (n: number): string => String(n).padStart(2, "0");

/**
 * Python `datetime.astimezone()` in the device's time zone (wired at the app root): an aware time
 * shifted to local wall time, a naive time taken as local already.
 */
export function systemLocalTime(moment: DateTime): market.LocalTime {
  if (moment.offsetSeconds === null) {
    return { date: moment.date, time: `${two(moment.hour)}:${two(moment.minute)}` };
  }
  const [y, m, d] = moment.date.split("-").map(Number) as [number, number, number];
  const instant =
    Date.UTC(y, m - 1, d, moment.hour, moment.minute, moment.second) - moment.offsetSeconds * 1000;
  const local = new Date(instant);
  return {
    date: `${String(local.getFullYear()).padStart(4, "0")}-${two(local.getMonth() + 1)}-${two(local.getDate())}`,
    time: `${two(local.getHours())}:${two(local.getMinutes())}`,
  };
}
