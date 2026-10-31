/**
 * Shared helpers for the market tests (`tests/investments/market/inv_market_support.py`). No live HTTP:
 * every source runs on a recording fake `fetch`; fixtures are the recorded responses in
 * `tests/investments/fixtures/market`.
 */

import { readFileSync } from "node:fs";
import { addDays, D, type DateTime, type Decimal, weekday } from "@cashu/domain";
import {
  AssetClass,
  asInstrumentId,
  Currencies,
  type Instrument,
  type InstrumentAlias,
  type InstrumentInit,
  instrument,
  instrumentAlias,
} from "@cashu/domain/investments";
import type { FetchLike, HttpRequest, HttpResponse } from "../http.js";
import { MarketHttp } from "../http.js";

const FIXTURES = new URL("../../../../tests/investments/fixtures/market/", import.meta.url);

/** Fetch time the sources stamp on bars and rates in tests. */
export const FETCHED_AT: DateTime = Object.freeze({
  date: "2026-10-04",
  hour: 18,
  minute: 0,
  second: 0,
  microsecond: 0,
  offsetSeconds: 0,
});

export const fakeClock = (): DateTime => FETCHED_AT;

export function fixture(name: string): string {
  return readFileSync(new URL(name, FIXTURES), "utf8");
}

export const d = (value: string | number): Decimal => D(String(value));

/** Fake monotonic time: `sleep` records the delay and advances `now` instantly. */
export class FakeTime {
  now = 1000.0;
  readonly sleeps: number[] = [];
  readonly clock = (): number => this.now;
  readonly sleep = async (seconds: number): Promise<void> => {
    this.sleeps.push(seconds);
    this.now += seconds;
  };
}

/** One request the fake `fetch` saw. */
export interface SeenRequest {
  readonly url: URL;
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string | undefined;
  readonly signal: AbortSignal | undefined;
}

export type Handler = (request: SeenRequest) => HttpResponse | Promise<HttpResponse>;

export function respond(
  body: string,
  status = 200,
  contentType = "application/json; charset=utf-8",
  headers: Readonly<Record<string, string>> = {},
): HttpResponse {
  const all = new Map(
    Object.entries({ "content-type": contentType, ...headers }).map(([k, v]) => [
      k.toLowerCase(),
      v,
    ]),
  );
  return {
    status,
    headers: { get: (name) => all.get(name.toLowerCase()) ?? null },
    text: async () => body,
  };
}

/** A fake `fetch` that records requests into `requests` and answers with `handler`. */
export function recording(requests: SeenRequest[], handler: Handler): FetchLike {
  return async (url: string, init: HttpRequest) => {
    const seen: SeenRequest = {
      url: new URL(url),
      method: init.method,
      headers: init.headers,
      body: init.body,
      signal: init.signal,
    };
    requests.push(seen);
    return handler(seen);
  };
}

/** A `MarketHttp` over `fetch` with fake time (no real waiting, no real timers). */
export function makeHttp(
  fetch: FetchLike,
  time: FakeTime = new FakeTime(),
  timeout = 15.0,
): MarketHttp {
  return new MarketHttp({
    fetch,
    timeout,
    sleep: time.sleep,
    clock: time.clock,
    timeoutSignal: () => undefined,
  });
}

let counter = 0;

export function buildInstrument(
  init: Partial<Omit<InstrumentInit, "aliases">> & {
    readonly aliases?: Iterable<InstrumentAlias>;
  } = {},
): Instrument {
  counter += 1;
  return instrument({
    id: asInstrumentId(`instrument-${counter}`),
    name: "Orlen",
    symbol: "PKN",
    mic: "XWAR",
    currency: Currencies.PLN,
    assetClass: AssetClass.EQUITY,
    ...init,
  });
}

/** Orlen on GPW (XWAR) with confirmed stooq and yahoo aliases. */
export function orlen(aliases?: readonly InstrumentAlias[]): Instrument {
  return buildInstrument({
    aliases: aliases ?? [instrumentAlias("stooq", "pkn"), instrumentAlias("yahoo", "PKN.WA")],
  });
}

/** Vanguard FTSE All-World on XETRA with confirmed yahoo and stooq aliases. */
export function vwce(aliases?: readonly InstrumentAlias[]): Instrument {
  return buildInstrument({
    name: "Vanguard FTSE All-World",
    symbol: "VWCE",
    mic: "XETR",
    currency: Currencies.EUR,
    assetClass: AssetClass.ETF,
    aliases: aliases ?? [instrumentAlias("yahoo", "VWCE.DE"), instrumentAlias("stooq", "vwce.de")],
  });
}

/** Epoch seconds of a UTC wall time. */
export function utc(y: number, m: number, dd: number, h = 0, minute = 0): number {
  return Date.UTC(y, m - 1, dd, h, minute) / 1000;
}

export function weekdays(start: string, end: string): string[] {
  const days: string[] = [];
  for (let current = start; current <= end; current = addDays(current, 1)) {
    if (weekday(current) < 5) days.push(current);
  }
  return days;
}

/** `datetime.fromtimestamp(seconds, UTC).date()`. */
function utcDate(seconds: number): string {
  return new Date(seconds * 1000).toISOString().slice(0, 10);
}

/**
 * A chart response in Yahoo's recorded format (NASDAQ: sessions open 13:30 UTC, gmtoffset -4 h) with
 * one session per weekday of `start..end` and the given splits inside the range.
 */
function yahooChart(
  start: string,
  end: string,
  close: (on: string) => string,
  options: {
    readonly currency?: string;
    readonly splits?: readonly (readonly [string, number, number])[];
  } = {},
): string {
  const stamp = (on: string) => {
    const [y, m, dd] = on.split("-").map(Number) as [number, number, number];
    return utc(y, m, dd, 13, 30);
  };
  const dates = weekdays(start, end);
  const closes = dates.map((on) => Number(close(on)));
  const splits: Record<string, unknown> = {};
  for (const [on, numerator, denominator] of options.splits ?? []) {
    if (start <= on && on <= end) {
      splits[String(stamp(on))] = {
        date: stamp(on),
        numerator,
        denominator,
        splitRatio: `${numerator}:${denominator}`,
      };
    }
  }
  return JSON.stringify({
    chart: {
      result: [
        {
          meta: {
            currency: options.currency ?? "USD",
            symbol: "TEST",
            exchangeName: "NMS",
            gmtoffset: -14400,
            priceHint: 2,
          },
          timestamp: dates.map(stamp),
          events: { splits },
          indicators: {
            quote: [
              {
                open: closes,
                high: closes,
                low: closes,
                close: closes,
                volume: dates.map(() => 1000),
              },
            ],
          },
        },
      ],
      error: null,
    },
  });
}

/** Answers every chart request with `yahooChart` for the requested period1..period2. */
export function yahooChartFetch(
  requests: SeenRequest[],
  close: (on: string) => string,
  options: {
    readonly currency?: string;
    readonly splits?: readonly (readonly [string, number, number])[];
  } = {},
): FetchLike {
  return recording(requests, (request) => {
    const dateOf = (key: string) => utcDate(Number(request.url.searchParams.get(key)));
    return respond(yahooChart(dateOf("period1"), dateOf("period2"), close, options));
  });
}
