/**
 * Shared HTTP access for market data sources (`market/market_http.py`): timeout, retries with backoff,
 * per-host pacing. Every request goes through an injected `fetch` (the leader wires the platform's
 * `fetch` at the app root; tests pass fakes), so nothing here touches the network on its own.
 */

import { market } from "@cashu/domain/investments";

const { SourceBlockedException, SourceException } = market;

/** The response surface the sources read (a WHATWG `Response` satisfies it). */
export interface HttpResponse {
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  text(): Promise<string>;
}

/** The request the sources send (a subset of WHATWG `RequestInit`). */
export interface HttpRequest {
  readonly method: "GET" | "POST";
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly signal?: AbortSignal;
}

/** A finished response: status, the whole body, headers. */
export interface MarketResponse {
  readonly status: number;
  readonly text: string;
  readonly headers: HttpResponse["headers"];
}

/** A `fetch`: the platform's on the leader, a fake in tests. */
export type FetchLike = (url: string, init: HttpRequest) => Promise<HttpResponse>;

/** Waits for the given number of seconds. Injectable so tests run without real delays. */
export type Sleep = (seconds: number) => Promise<void>;
/** Monotonic time in seconds. */
export type MonotonicClock = () => number;
/** Delay in seconds before retry number `n` (1 for the first retry). */
export type Backoff = (retry: number) => number;
/** An abort signal that fires after `ms` milliseconds (per attempt: connect + full response). */
export type TimeoutSignal = (ms: number) => AbortSignal | undefined;

/** Default backoff: 1 s, 2 s, 4 s... */
export function exponentialBackoff(retry: number): number {
  return 2 ** (retry - 1);
}

export interface MarketHttpOptions {
  readonly fetch: FetchLike;
  readonly sleep: Sleep;
  readonly clock: MonotonicClock;
  /** Seconds per attempt (connect + full response). */
  readonly timeout?: number;
  /** Retries after the first attempt. */
  readonly maxRetries?: number;
  /** Seconds between two request starts to one host. */
  readonly minHostInterval?: number;
  /** Cap of a 429 `Retry-After` wait, seconds. */
  readonly maxRetryAfter?: number;
  readonly backoff?: Backoff;
  /** Default: `AbortSignal.timeout`. */
  readonly timeoutSignal?: TimeoutSignal;
  /**
   * Pace requests together with another instance (one schedule per host for both, e.g. the price and
   * the macro sources of one run fetching in parallel).
   */
  readonly shareSlotsWith?: MarketHttp;
}

/** True for a rejection that a timeout (abort) caused. */
function isTimeout(error: unknown): boolean {
  return error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * GETs (and the odd read-only POST lookup) for market data sources over an injected `fetch`.
 *
 * Share one instance between all sources of a run so the per-host gap holds across them.
 * - Each attempt is limited to `timeout` seconds (connect + full response).
 * - Retried: HTTP 429, HTTP 5xx, network errors and timeouts (any rejection of `fetch`), at most
 *   `maxRetries` times after the first attempt, waiting `backoff(n)`. A 429 `Retry-After` header
 *   (seconds, capped at `maxRetryAfter`) lengthens the wait.
 * - Exhausted retries reject with a retryable `SourceException` (`SourceBlockedException` for a
 *   persistent 429).
 * - Every other response (2xx, 3xx, 4xx except 429) is returned as is; the source interprets it (NBP
 *   answers 404 for "no data in range", Yahoo 404 for an unknown symbol).
 * - Requests to one host start at least `minHostInterval` seconds apart (slots are reserved
 *   synchronously, so concurrent callers queue up per host).
 */
export class MarketHttp {
  timeout: number;
  maxRetries: number;
  readonly minHostInterval: number;
  readonly maxRetryAfter: number;
  private readonly fetchImpl: FetchLike;
  private readonly sleep: Sleep;
  private readonly clock: MonotonicClock;
  private readonly backoff: Backoff;
  private readonly timeoutSignal: TimeoutSignal;
  private readonly nextSlot: Map<string, number>;

  constructor(options: MarketHttpOptions) {
    this.fetchImpl = options.fetch;
    this.sleep = options.sleep;
    this.clock = options.clock;
    this.timeout = options.timeout ?? 15.0;
    this.maxRetries = options.maxRetries ?? 2;
    this.minHostInterval = options.minHostInterval ?? 0.3;
    this.maxRetryAfter = options.maxRetryAfter ?? 30.0;
    this.backoff = options.backoff ?? exponentialBackoff;
    this.timeoutSignal = options.timeoutSignal ?? ((ms) => AbortSignal.timeout(ms));
    this.nextSlot = options.shareSlotsWith?.nextSlot ?? new Map();
  }

  /** GETs `url` (with `params` as its query) on behalf of source `sourceId` (named in errors). */
  get(
    url: string,
    sourceId: string,
    options: {
      readonly params?: Readonly<Record<string, string>>;
      readonly headers?: Readonly<Record<string, string>>;
    } = {},
  ): Promise<MarketResponse> {
    const target = new URL(url);
    for (const [key, value] of Object.entries(options.params ?? {}))
      target.searchParams.set(key, value);
    return this.request("GET", target.toString(), sourceId, options.headers ?? {});
  }

  /**
   * POSTs `json` to `url` on behalf of source `sourceId`, with the same timeout, retries and pacing as
   * `get` (a read-only lookup such as OpenFIGI's mapping endpoint).
   */
  post(
    url: string,
    sourceId: string,
    json: unknown,
    headers: Readonly<Record<string, string>> = {},
  ): Promise<MarketResponse> {
    return this.request("POST", url, sourceId, headers, JSON.stringify(json));
  }

  private async request(
    method: "GET" | "POST",
    url: string,
    sourceId: string,
    headers: Readonly<Record<string, string>>,
    body?: string,
  ): Promise<MarketResponse> {
    const host = new URL(url).hostname;
    const attempts = this.maxRetries + 1;
    for (let attempt = 1; ; attempt++) {
      const isLast = attempt === attempts;
      await this.waitForSlot(host);
      let status: number;
      let text: string;
      let responseHeaders: HttpResponse["headers"];
      try {
        const signal = this.timeoutSignal(Math.round(this.timeout * 1000));
        const init: HttpRequest = {
          method,
          headers,
          ...(body === undefined ? {} : { body }),
          ...(signal === undefined ? {} : { signal }),
        };
        const response = await this.fetchImpl(url, init);
        status = response.status;
        responseHeaders = response.headers;
        text = await response.text();
      } catch (error) {
        if (isLast) {
          const what = isTimeout(error)
            ? `timed out after ${Math.trunc(this.timeout * 1000)} ms`
            : `network error: ${errorText(error)}`;
          throw new SourceException(sourceId, `${host} ${what} (${attempts} attempts)`, {
            retryable: true,
            cause: error,
          });
        }
        await this.sleep(this.backoff(attempt));
        continue;
      }
      if (!isRetryableStatus(status)) return { status, text, headers: responseHeaders };
      if (isLast) {
        const message = `${host} answered HTTP ${status} (${attempts} attempts)`;
        if (status === 429) {
          throw new SourceBlockedException(sourceId, `rate limited: ${message}`, {
            retryable: true,
          });
        }
        throw new SourceException(sourceId, message, { retryable: true });
      }
      await this.sleep(this.retryDelay(attempt, status, responseHeaders));
    }
  }

  private async waitForSlot(host: string): Promise<void> {
    const now = this.clock();
    const reserved = this.nextSlot.get(host);
    const start = reserved !== undefined && reserved > now ? reserved : now;
    this.nextSlot.set(host, start + this.minHostInterval);
    if (start > now) await this.sleep(start - now);
  }

  private retryDelay(retry: number, status: number, headers: HttpResponse["headers"]): number {
    const base = this.backoff(retry);
    if (status !== 429) return base;
    const raw = (headers.get("retry-after") ?? "").trim();
    if (!/^[+-]?\d+$/.test(raw)) return base;
    const retryAfter = Number(raw);
    if (retryAfter <= 0) return base;
    return Math.max(Math.min(retryAfter, this.maxRetryAfter), base);
  }
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}
