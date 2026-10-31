/**
 * The HTTP price and FX sources (`market/yahoo.py`, `stooq.py`, `nbp.py`, `composite.py`): requests over
 * `MarketHttp`, parsing by the pure parsers of `@cashu/domain` (`investments.market`). Each source
 * stamps its bars and rates with the injected UTC clock.
 */

import type { DateTime } from "@cashu/domain";
import {
  AliasNamespace,
  aliasOf,
  asInstrumentId,
  type CalendarDate,
  Currencies,
  type Currency,
  type FxRate,
  type Instrument,
  market,
} from "@cashu/domain/investments";
import type { MarketHttp } from "./http.js";

const {
  NoPriceSourceException,
  SourceBlockedException,
  SourceException,
  bodySnippet,
  chartParams,
  nbpChunks,
  nbpRatesPath,
  nbpTablesPath,
  parseNbpRates,
  parseNbpTables,
  parseStooq,
  parseYahooChart,
  parseYahooHistory,
  parseYahooSpark,
  priceHistory,
  sparkParams,
  stooqParams,
} = market;

/** The wall clock in UTC that stamps `fetchedAt` (the app root passes `systemUtcClock`). */
export type UtcClock = () => DateTime;

/** The system clock as a UTC `DateTime` (wired at the app root, never used by tests). */
export function systemUtcClock(): DateTime {
  const now = new Date();
  const iso = now.toISOString(); // YYYY-MM-DDTHH:MM:SS.mmmZ
  return {
    date: iso.slice(0, 10),
    hour: now.getUTCHours(),
    minute: now.getUTCMinutes(),
    second: now.getUTCSeconds(),
    microsecond: now.getUTCMilliseconds() * 1000,
    offsetSeconds: 0,
  };
}

// --- Yahoo ----------------------------------------------------------------------------------------

export interface YahooOptions {
  readonly clock: UtcClock;
  readonly host?: string;
  readonly userAgent?: string;
}

/**
 * Daily bars from `https://query1.finance.yahoo.com/v8/finance/chart/<alias>` (no key). Symbol: the
 * instrument's `yahoo` alias (`VWCE.DE`, `PKN.WA`, `AAPL`). Parsing rules: `parseYahooHistory`. HTTP
 * 401/403 is a `SourceBlockedException`, any other status but 200 / 404 a `SourceException`.
 */
export class YahooPriceSource implements market.PriceSource, market.SparkSource {
  static readonly DEFAULT_USER_AGENT = market.YAHOO_USER_AGENT;
  readonly id = market.YAHOO_SOURCE_ID;
  readonly host: string;
  readonly userAgent: string;
  private readonly http: MarketHttp;
  private readonly clock: UtcClock;

  constructor(http: MarketHttp, options: YahooOptions) {
    this.http = http;
    this.host = options.host ?? "query1.finance.yahoo.com";
    this.userAgent = options.userAgent ?? market.YAHOO_USER_AGENT;
    this.clock = options.clock;
  }

  async fetch(
    instrument: Instrument,
    start: CalendarDate,
    end: CalendarDate,
  ): Promise<market.PriceHistory> {
    const symbol = aliasOf(instrument, AliasNamespace.YAHOO);
    if (symbol === null) {
      throw new NoPriceSourceException(this.id, `instrument ${instrument.id} has no yahoo alias`);
    }
    if (start > end) return priceHistory();
    const body = await this.getChart(symbol, start, end);
    return this.parseHistory(body, instrument, start, end, symbol);
  }

  /** `parseYahooHistory` stamped with this source's clock. */
  parseHistory(
    body: string,
    instrument: Instrument,
    start: CalendarDate,
    end: CalendarDate,
    symbol: string | null = null,
  ): market.PriceHistory {
    return parseYahooHistory(body, instrument, start, end, { symbol, fetchedAt: this.clock() });
  }

  /**
   * The chart of a Yahoo `symbol` before any instrument exists (verifying a search pick): the meta and
   * the bars within `start..end`, stamped with `instrumentId`. Errors as in `fetch`; a chart without a
   * quote currency is a `SourceException`.
   */
  async chart(
    symbol: string,
    start: CalendarDate,
    end: CalendarDate,
    instrumentId?: string,
  ): Promise<market.ChartQuote> {
    const body = await this.getChart(symbol, start, end);
    return this.parseChart(body, symbol, start, end, instrumentId);
  }

  parseChart(
    body: string,
    symbol: string,
    start: CalendarDate,
    end: CalendarDate,
    instrumentId?: string,
  ): market.ChartQuote {
    return parseYahooChart(body, symbol, start, end, {
      fetchedAt: this.clock(),
      ...(instrumentId === undefined ? {} : { instrumentId: asInstrumentId(instrumentId) }),
    });
  }

  /**
   * Daily closes of many symbols in one request (`/v7/finance/spark`, no crumb): per symbol Yahoo
   * answered for, a chart response body `parseHistory` reads. An unknown symbol is simply absent. HTTP
   * 401/403 is a `SourceBlockedException`, any other non-200 a `SourceException`.
   */
  async spark(
    symbols: readonly string[],
    range: string = market.SPARK_RANGE,
  ): Promise<Map<string, string>> {
    if (symbols.length === 0) return new Map();
    const what = `spark (${symbols.length} symbols)`;
    const response = await this.http.get(`https://${this.host}/v7/finance/spark`, this.id, {
      params: sparkParams(symbols, range),
      headers: { "User-Agent": this.userAgent, Accept: "application/json" },
    });
    if (response.status === 401 || response.status === 403) {
      throw new SourceBlockedException(
        this.id,
        `HTTP ${response.status} for ${what}: ${bodySnippet(response.text)}`,
      );
    }
    if (response.status !== 200) {
      throw new SourceException(
        this.id,
        `HTTP ${response.status} for ${what}: ${bodySnippet(response.text)}`,
      );
    }
    return parseYahooSpark(response.text);
  }

  private async getChart(symbol: string, start: CalendarDate, end: CalendarDate): Promise<string> {
    const response = await this.http.get(
      `https://${this.host}/v8/finance/chart/${symbol}`,
      this.id,
      {
        params: chartParams(start, end),
        headers: { "User-Agent": this.userAgent, Accept: "application/json" },
      },
    );
    const status = response.status;
    if (status === 401 || status === 403) {
      throw new SourceBlockedException(
        this.id,
        `HTTP ${status} for "${symbol}": ${bodySnippet(response.text)}`,
      );
    }
    if (status !== 200 && status !== 404) {
      throw new SourceException(
        this.id,
        `HTTP ${status} for "${symbol}": ${bodySnippet(response.text)}`,
      );
    }
    return response.text;
  }
}

// --- stooq ----------------------------------------------------------------------------------------

/**
 * Daily bars from `https://stooq.pl/q/d/l/?s=<alias>&i=d&d1=YYYYMMDD&d2=YYYYMMDD`. Symbol: the
 * instrument's `stooq` alias (`pkn`, `vwce.de`). Blocked by a bot check since 2026-10 (detected by
 * `parseStooq`, never bypassed). `host`: `stooq.pl` (Polish headers) or `stooq.com` (English); both parse.
 */
export class StooqPriceSource implements market.PriceSource {
  readonly id = market.STOOQ_SOURCE_ID;
  readonly host: string;
  private readonly http: MarketHttp;
  private readonly clock: UtcClock;

  constructor(http: MarketHttp, options: { readonly clock: UtcClock; readonly host?: string }) {
    this.http = http;
    this.host = options.host ?? "stooq.pl";
    this.clock = options.clock;
  }

  async fetch(
    instrument: Instrument,
    start: CalendarDate,
    end: CalendarDate,
  ): Promise<market.PriceHistory> {
    const symbol = aliasOf(instrument, AliasNamespace.STOOQ);
    if (symbol === null) {
      throw new NoPriceSourceException(this.id, `instrument ${instrument.id} has no stooq alias`);
    }
    if (start > end) return priceHistory();
    const response = await this.http.get(`https://${this.host}/q/d/l/`, this.id, {
      params: stooqParams(symbol, start, end),
    });
    if (response.status !== 200) {
      throw new SourceException(
        this.id,
        `HTTP ${response.status} for "${symbol}": ${bodySnippet(response.text)}`,
      );
    }
    const bars = parseStooq(response.text, instrument.id, start, end, {
      symbol,
      fetchedAt: this.clock(),
    });
    return priceHistory({ bars });
  }
}

// --- NBP ------------------------------------------------------------------------------------------

/**
 * Rates from `https://api.nbp.pl/api/exchangerates/rates/A/<code>/<start>/<end>/?format=json`: PLN per 1
 * unit of the quote currency. Long ranges are split into requests of at most `maxDaysPerRequest` days;
 * HTTP 404 ("Brak danych") is a chunk without rates; PLN has no rates (identity).
 */
export class NbpFxSource implements market.FxSource, market.TableFxSource {
  readonly id = market.NBP_SOURCE_ID;
  readonly host: string;
  readonly maxDaysPerRequest: number;
  private readonly http: MarketHttp;
  private readonly clock: UtcClock;

  constructor(
    http: MarketHttp,
    options: {
      readonly clock: UtcClock;
      readonly host?: string;
      readonly maxDaysPerRequest?: number;
    },
  ) {
    const maxDays = options.maxDaysPerRequest ?? market.NBP_MAX_DAYS_PER_REQUEST;
    if (maxDays <= 0) throw new RangeError("max_days_per_request must be positive");
    this.http = http;
    this.host = options.host ?? "api.nbp.pl";
    this.maxDaysPerRequest = maxDays;
    this.clock = options.clock;
  }

  async rates(quote: Currency, start: CalendarDate, end: CalendarDate): Promise<FxRate[]> {
    if (quote === Currencies.PLN || start > end) return [];
    const byDate = new Map<CalendarDate, FxRate>();
    for (const [chunkStart, chunkEnd] of nbpChunks(start, end, this.maxDaysPerRequest)) {
      for (const rate of await this.chunk(quote, chunkStart, chunkEnd)) byDate.set(rate.date, rate);
    }
    return [...byDate.keys()].sort().map((on) => byDate.get(on) as FxRate);
  }

  /**
   * Every table A currency over `start..end` (at most `maxDaysPerRequest` days) in one request: rates
   * per currency, oldest first. A range without a table (HTTP 404) is empty.
   */
  async tableRates(start: CalendarDate, end: CalendarDate): Promise<Map<Currency, FxRate[]>> {
    if (start > end) return new Map();
    if (nbpChunks(start, end, this.maxDaysPerRequest).length > 1) {
      throw new RangeError("table range longer than max_days_per_request");
    }
    const response = await this.http.get(
      `https://${this.host}${nbpTablesPath(start, end)}`,
      this.id,
      {
        params: { format: "json" },
        headers: { Accept: "application/json" },
      },
    );
    if (response.status === 404) return new Map();
    if (response.status !== 200) {
      throw new SourceException(
        this.id,
        `HTTP ${response.status} for table A ${start}..${end}: ${bodySnippet(response.text)}`,
      );
    }
    return parseNbpTables(response.text, start, end, this.clock());
  }

  private async chunk(quote: Currency, start: CalendarDate, end: CalendarDate): Promise<FxRate[]> {
    const response = await this.http.get(
      `https://${this.host}${nbpRatesPath(quote, start, end)}`,
      this.id,
      {
        params: { format: "json" },
        headers: { Accept: "application/json" },
      },
    );
    if (response.status === 404) return [];
    if (response.status !== 200) {
      throw new SourceException(
        this.id,
        `HTTP ${response.status} for ${quote} ${start}..${end}: ${bodySnippet(response.text)}`,
      );
    }
    return parseNbpRates(response.text, quote, start, end, this.clock());
  }
}

// --- composite ------------------------------------------------------------------------------------

/** stooq + yahoo over one shared `MarketHttp`, in the default order (`CompositePriceSource.standard`). */
export function standardCompositeSource(
  http: MarketHttp,
  options: { readonly clock: UtcClock; readonly log?: market.MarketLog },
): market.CompositePriceSource {
  return new market.CompositePriceSource(
    [new StooqPriceSource(http, options), new YahooPriceSource(http, options)],
    options.log === undefined ? {} : { log: options.log },
  );
}
