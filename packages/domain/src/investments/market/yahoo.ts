/**
 * Yahoo's unofficial chart and spark endpoints, the pure part (`market/yahoo.py`): request parameters,
 * response parsing, exchange dates and float32-noise-free prices. The HTTP source is
 * `@cashu/market` `YahooPriceSource`.
 *
 * Dates: a bar's timestamp (session open or local midnight, UTC seconds) is shifted by the exchange's
 * `meta.gmtoffset` to get the exchange calendar date. `gmtoffset` is the offset in force at fetch time,
 * so a bar from the other side of a DST switch can be off by one hour; a shifted time of 22:00 or later
 * can only be a local-midnight stamp read with the wrong offset and counts as the next day.
 *
 * Prices: Yahoo serves single-precision floats widened to doubles (166.22 arrives as
 * 166.22000122070312). A value that is exactly a float32 becomes the shortest decimal that maps to the
 * same float32 (166.22); any other value keeps its shortest double form.
 *
 * Currency (R3): `meta.currency` is the quote currency. Minor units are normalized (`GBp` / `GBX` ->
 * GBP, `ZAc` -> ZAR, `ILA` -> ILS, every price divided by 100). When the normalized currency differs
 * from `Instrument.currency` a non-retryable `QuoteCurrencyMismatchException` is thrown and no bar is
 * returned. Bars carry the quote currency.
 *
 * Splits (R6): the chart request asks for `events=split`; splits within the range come back in
 * `PriceHistory.splits`. Yahoo's `close` is split-adjusted retroactively, so stored bars from before a
 * split must be fetched again (see the refresher).
 *
 * Errors: an unknown symbol (`chart.error`, usually HTTP 404) is a non-retryable `SourceException`; a
 * range without sessions is an empty answer.
 */

import { addDays, type DateTime, daysBetween } from "../../dates.js";
import { Decimal, floatRepr, roundFloatToInt } from "../../decimal.js";
import { isPyNumber, isRecord, PyJsonError, parsePyJson } from "../../pyJson.js";
import { pySplit, pyStrip } from "../../text.js";
import { AssetClass } from "../domain/enums.js";
import {
  AliasNamespace,
  aliasOf,
  type Instrument,
  instrumentAlias,
  instrument as makeInstrument,
} from "../domain/instrument.js";
import { type PriceBar, priceBar } from "../domain/marketData.js";
import {
  asInstrumentId,
  type CalendarDate,
  Currencies,
  type Currency,
  dividedBy,
  type InstrumentId,
  toCurrency,
} from "../domain/values.js";
import {
  bodySnippet,
  type PriceHistory,
  priceHistory,
  QuoteCurrencyMismatchException,
  SourceException,
  type SplitEvent,
} from "./sources.js";

export const YAHOO_SOURCE_ID = AliasNamespace.YAHOO;

/** Short browser-like agent (a full but outdated browser string got HTTP 429 in live tries). */
export const YAHOO_USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)";

/** Window of a spark request: about 21 sessions, enough for a refresh after a few weeks away. */
export const SPARK_RANGE = "1mo";

/** Minor-unit quote currencies Yahoo uses and their major currency (prices / 100). */
export const MINOR_UNITS: Readonly<Record<string, string>> = Object.freeze({
  GBp: "GBP",
  GBX: "GBP",
  ZAc: "ZAR",
  ILA: "ILS",
});

const EPOCH_DAY = "1970-01-01";

/**
 * A Yahoo chart read without an instrument (verifying a search pick): the verification and currency
 * source of a pick, and the macro refresh's chart answer.
 */
export interface ChartQuote {
  readonly symbol: string;
  /** `meta.currency` normalized for minor units (`GBp` -> GBP); the bars are in it. */
  readonly currency: Currency;
  /** `meta.instrumentType` (`EQUITY`, `ETF`, `MUTUALFUND`, `CRYPTOCURRENCY`, ...). */
  readonly instrumentType: string | null;
  readonly longName: string | null;
  readonly exchangeName: string | null;
  readonly bars: readonly PriceBar[];
  readonly splits: readonly SplitEvent[];
  /**
   * `indicators.adjclose` (split- and distribution-adjusted closes) within the range, oldest first;
   * empty when the response has none. Read only by the macro refresh.
   */
  readonly adjusted: readonly (readonly [CalendarDate, Decimal])[];
}

export interface ParseOptions {
  /** The symbol named in error messages. */
  readonly symbol?: string | null;
  /** Fetch time stamped on every bar (the source's clock). */
  readonly fetchedAt: DateTime | null;
}

/** Epoch seconds of UTC midnight of `on`. */
export function epochOf(on: CalendarDate): number {
  return daysBetween(EPOCH_DAY, on) * 86400;
}

/** Query parameters of a chart request: one extra day on each side covers every UTC offset. */
export function chartParams(start: CalendarDate, end: CalendarDate): Record<string, string> {
  return {
    period1: String(epochOf(addDays(start, -1))),
    period2: String(epochOf(addDays(end, 2))),
    interval: "1d",
    events: "split",
  };
}

/** Query parameters of a spark request for `symbols`. */
export function sparkParams(
  symbols: readonly string[],
  range: string = SPARK_RANGE,
): Record<string, string> {
  return { symbols: symbols.join(","), range, interval: "1d" };
}

/**
 * Exchange calendar date of a bar stamped `epochSeconds` (UTC) on an exchange `gmtOffsetSeconds` from
 * UTC, with the 22:00 rule (`exchange_date`).
 */
export function exchangeDate(epochSeconds: number, gmtOffsetSeconds: number): CalendarDate {
  const local = epochSeconds + gmtOffsetSeconds;
  const days = Math.floor(local / 86400);
  const hour = Math.floor((local - days * 86400) / 3600);
  return addDays(EPOCH_DAY, hour >= 22 ? days + 1 : days);
}

/** `1E+2` -> `100` (positive exponents only; the value is unchanged). */
function plain(value: Decimal): Decimal {
  return value.exp > 0 ? value.quantize(0) : value;
}

/**
 * Python `f"{value:.{precision}g}"` read back as a Decimal: the exact binary value rounded half-even to
 * `precision` significant digits, insignificant trailing zeros dropped (the `g` presentation).
 */
function significantDigits(value: number, precision: number): Decimal {
  if (value === 0) return Decimal.parse(Object.is(value, -0) ? "-0" : "0");
  const exact = Decimal.fromFloat(value);
  const rounded = exact.rescale(exact.adjusted() - precision + 1, "ROUND_HALF_EVEN");
  const digits = rounded.digits.replace(/0+$/, "") || "0";
  return Decimal.fromTriple(
    rounded.sign,
    digits,
    rounded.exp + (rounded.digits.length - digits.length),
  );
}

/** A Yahoo price without float32 noise (`_price`), or null. */
export function yahooPrice(value: unknown): Decimal | null {
  if (!isPyNumber(value) || !Number.isFinite(value)) return null;
  if (Math.fround(value) === value) {
    for (let precision = 1; precision < 10; precision++) {
      const candidate = significantDigits(value, precision);
      if (Math.fround(candidate.toFloat()) === value) return plain(candidate);
    }
  }
  return plain(Decimal.parse(floatRepr(value)));
}

/** Python `" ".join(value.split()) or None` for a string, else null. */
export function cleanText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = pySplit(value).join(" ");
  return text === "" ? null : text;
}

/** Python `int(x)` of a JSON number. */
const pyInt = (x: number): number => Math.trunc(x);

/** Python `repr` of a JSON number as a Decimal literal (an int keeps no `.0`). */
function numberDecimal(x: number): Decimal {
  return Number.isInteger(x) && Math.abs(x) < 1e16
    ? Decimal.fromInt(x)
    : Decimal.parse(floatRepr(x));
}

/** `data[key]` the way Python indexes parsed JSON, undefined where Python raises. */
function at(value: unknown, key: string | number): unknown {
  if (typeof key === "number") return Array.isArray(value) ? value[key] : undefined;
  return isRecord(value) ? value[key] : undefined;
}

/** The normalized quote currency and the price divisor (1 or 100); [null, 1] when absent. */
function quoteCurrency(raw: unknown, what: string): [Currency | null, number] {
  if (typeof raw !== "string" || pyStrip(raw) === "") return [null, 1];
  const code = pyStrip(raw);
  const major = MINOR_UNITS[code];
  if (major !== undefined) return [toCurrency(major), 100];
  // Checked before normalizing: toCurrency("GBp") would silently become GBP.
  try {
    return [toCurrency(code), 1];
  } catch {
    throw new SourceException(
      YAHOO_SOURCE_ID,
      `unexpected response${what}: quote currency "${code}"`,
    );
  }
}

function parseBody(body: string, unexpected: (detail: string, cause?: unknown) => Error): unknown {
  try {
    return parsePyJson(body);
  } catch (error) {
    if (error instanceof PyJsonError) throw unexpected(bodySnippet(body), error);
    throw error;
  }
}

const scaledBy =
  (divisor: number) =>
  (price: Decimal | null): Decimal | null =>
    price === null || divisor === 1 ? price : price.scaleb(-2);

/** Splits in `events.splits` dated within `start..end` (exchange dates), oldest first. */
function parseSplits(
  events: unknown,
  offset: number,
  start: CalendarDate,
  end: CalendarDate,
): SplitEvent[] {
  const splits = at(events, "splits");
  if (!isRecord(splits)) return [];
  const result: SplitEvent[] = [];
  for (const entry of Object.values(splits)) {
    if (!isRecord(entry)) continue;
    const { date: stamp, numerator, denominator } = entry;
    if (!(isPyNumber(stamp) && isPyNumber(numerator) && isPyNumber(denominator))) continue;
    if (numerator <= 0 || denominator <= 0) continue;
    const on = exchangeDate(pyInt(stamp), offset);
    if (on < start || on > end) continue;
    const ratio = dividedBy(numberDecimal(numerator), numberDecimal(denominator)).normalize();
    result.push(Object.freeze({ date: on, ratio: plain(ratio) }));
  }
  // Python's sort is stable: equal dates keep the events' order.
  return result.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/**
 * Parses a chart response body into bars dated within `start..end` (exchange dates), oldest first,
 * plus the splits in that range and the quote currency (`parse_history`). Rows without a close are
 * skipped; a repeated date keeps the later row.
 */
export function parseYahooHistory(
  body: string,
  instrument: Instrument,
  start: CalendarDate,
  end: CalendarDate,
  options: ParseOptions,
): PriceHistory {
  const symbol = options.symbol ?? null;
  const what = symbol === null ? "" : ` for "${symbol}"`;
  const unexpected = (detail: string, cause?: unknown) =>
    new SourceException(YAHOO_SOURCE_ID, `unexpected response${what}: ${detail}`, { cause });

  const data = parseBody(body, unexpected);
  const chart = at(data, "chart");
  if (!isRecord(chart)) throw unexpected(bodySnippet(body));
  const error = chart.error;
  if (isRecord(error)) {
    throw new SourceException(
      YAHOO_SOURCE_ID,
      `no such symbol${what} (${pyStr(error.code)}: ${pyStr(error.description)})`,
    );
  }
  const results = chart.result;
  const result = Array.isArray(results) ? results[0] : undefined;
  if (!isRecord(result)) throw unexpected("no chart result");
  const meta = isRecord(result.meta) ? result.meta : {};
  const offset = isPyNumber(meta.gmtoffset) ? pyInt(meta.gmtoffset) : 0;
  const [currency, divisor] = quoteCurrency(meta.currency, what);
  if (currency !== null && currency !== instrument.currency) {
    throw new QuoteCurrencyMismatchException(
      YAHOO_SOURCE_ID,
      `quote currency ${currency}${what} differs from the instrument currency ` +
        `${instrument.currency}; no bars stored (fix the instrument currency or its yahoo alias)`,
      { quoteCurrency: currency, instrumentCurrency: instrument.currency },
    );
  }
  const splits = parseSplits(result.events, offset, start, end);
  const timestamps = result.timestamp;
  if (timestamps === null || timestamps === undefined) {
    // a range without sessions has no timestamp list
    return priceHistory({ splits, currency });
  }
  const quotes = at(result.indicators, "quote");
  const quote = Array.isArray(quotes) ? quotes[0] : undefined;
  if (Array.isArray(timestamps) && isRecord(quote)) {
    const bars = parseBars(
      instrument.id,
      start,
      end,
      offset,
      timestamps,
      quote,
      currency,
      divisor,
      options.fetchedAt,
    );
    return priceHistory({ bars, splits, currency });
  }
  throw unexpected("no timestamp / quote arrays");
}

function parseBars(
  instrumentId: InstrumentId,
  start: CalendarDate,
  end: CalendarDate,
  offset: number,
  timestamps: readonly unknown[],
  quote: Record<string, unknown>,
  currency: Currency | null,
  divisor: number,
  fetchedAt: DateTime | null,
): PriceBar[] {
  const series = (key: string): readonly unknown[] => {
    const values = quote[key];
    return Array.isArray(values) ? values : [];
  };
  const scaled = scaledBy(divisor);
  const opens = series("open");
  const highs = series("high");
  const lows = series("low");
  const closes = series("close");
  const volumes = series("volume");
  const bars = new Map<CalendarDate, PriceBar>();
  timestamps.forEach((timestamp, index) => {
    const close = scaled(yahooPrice(closes[index]));
    if (!isPyNumber(timestamp) || close === null) return;
    const on = exchangeDate(pyInt(timestamp), offset);
    if (on < start || on > end) return;
    const volume = volumes[index];
    bars.set(
      on,
      priceBar({
        instrumentId,
        date: on,
        open: scaled(yahooPrice(opens[index])),
        high: scaled(yahooPrice(highs[index])),
        low: scaled(yahooPrice(lows[index])),
        close,
        volume: isPyNumber(volume) ? pyRound(volume) : null,
        source: YAHOO_SOURCE_ID,
        fetchedAt,
        currency,
      }),
    );
  });
  return [...bars.keys()].sort().map((on) => bars.get(on) as PriceBar);
}

/** Python `round(x)` of a JSON number (an int stays itself, a float rounds half-even). */
function pyRound(x: number): number {
  return Number.isInteger(x) ? x : Number(roundFloatToInt(x));
}

/** Python `str(x)` of a parsed JSON scalar in an error message (None for a missing key). */
function pyStr(value: unknown): string {
  if (value === undefined || value === null) return "None";
  if (typeof value === "boolean") return value ? "True" : "False";
  if (typeof value === "number") return Number.isInteger(value) ? String(value) : floatRepr(value);
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

/** `chart.result[0].meta` of a chart body, or {} when the body has none. */
function chartMeta(body: string): Record<string, unknown> {
  let data: unknown;
  try {
    data = parsePyJson(body);
  } catch {
    return {};
  }
  const meta = at(at(at(at(data, "chart"), "result"), 0), "meta");
  return isRecord(meta) ? meta : {};
}

/**
 * `chart.result[0].indicators.adjclose[0].adjclose` by exchange date within `start..end` (minor units
 * scaled like the bars); empty when absent or malformed (the bars are unaffected).
 */
function adjustedCloses(
  body: string,
  start: CalendarDate,
  end: CalendarDate,
  divisor: number,
): (readonly [CalendarDate, Decimal])[] {
  let data: unknown;
  try {
    data = parsePyJson(body);
  } catch {
    return [];
  }
  const result = at(at(at(data, "chart"), "result"), 0);
  const timestamps = at(result, "timestamp");
  const values = at(at(at(at(result, "indicators"), "adjclose"), 0), "adjclose");
  if (!Array.isArray(timestamps) || !Array.isArray(values)) return [];
  const meta = at(result, "meta");
  const gmt = at(meta, "gmtoffset");
  const offset = isRecord(meta) && isPyNumber(gmt) ? pyInt(gmt) : 0;
  const scaled = scaledBy(divisor);
  const out = new Map<CalendarDate, Decimal>();
  timestamps.forEach((timestamp, index) => {
    const price = yahooPrice(values[index]);
    if (!isPyNumber(timestamp) || price === null) return;
    const on = exchangeDate(pyInt(timestamp), offset);
    if (start <= on && on <= end) out.set(on, scaled(price) as Decimal);
  });
  return [...out.keys()].sort().map((on) => [on, out.get(on) as Decimal] as const);
}

export interface ChartOptions {
  /** Instrument id stamped on the bars (default `chart`). */
  readonly instrumentId?: InstrumentId;
  readonly fetchedAt: DateTime | null;
}

/** Parses a chart response body into a `ChartQuote` (`parse_chart`). */
export function parseYahooChart(
  body: string,
  symbol: string,
  start: CalendarDate,
  end: CalendarDate,
  options: ChartOptions,
): ChartQuote {
  const what = ` for "${symbol}"`;
  const instrumentId = options.instrumentId ?? asInstrumentId("chart");
  const probe = (currency: Currency): Instrument =>
    makeInstrument({
      id: instrumentId,
      name: symbol,
      currency,
      assetClass: AssetClass.OTHER,
      aliases: [instrumentAlias(AliasNamespace.YAHOO, symbol)],
    });
  const meta = chartMeta(body);
  const [currency, divisor] = quoteCurrency(meta.currency, what);
  const parseOptions = { symbol, fetchedAt: options.fetchedAt };
  if (currency === null) {
    // an error body (unknown symbol) or no meta: the bar parser names the actual problem
    parseYahooHistory(body, probe(Currencies.USD), start, end, parseOptions);
    throw new SourceException(YAHOO_SOURCE_ID, `unexpected response${what}: no quote currency`);
  }
  const parsed = parseYahooHistory(body, probe(currency), start, end, parseOptions);
  return Object.freeze({
    symbol,
    currency,
    instrumentType: cleanText(meta.instrumentType),
    longName: cleanText(meta.longName) ?? cleanText(meta.shortName),
    exchangeName: cleanText(meta.exchangeName),
    bars: parsed.bars,
    splits: parsed.splits,
    adjusted: Object.freeze(adjustedCloses(body, start, end, divisor)),
  });
}

/**
 * Splits a spark response into one chart response body per symbol Yahoo answered for (`parse_spark`):
 * each reads like the per-symbol chart in `parseYahooHistory` (meta with the quote currency and
 * `gmtoffset`, timestamps, closes; no open / high / low / volume, no split events). An unknown symbol
 * is simply absent.
 */
export function parseYahooSpark(body: string): Map<string, string> {
  let results: unknown;
  try {
    results = at(at(parsePyJson(body), "spark"), "result");
    if (results === undefined) throw new PyJsonError("no spark.result");
  } catch (error) {
    throw new SourceException(YAHOO_SOURCE_ID, `unexpected spark response: ${bodySnippet(body)}`, {
      cause: error,
    });
  }
  const out = new Map<string, string>();
  for (const entry of Array.isArray(results) ? results : []) {
    if (!isRecord(entry)) continue;
    const { symbol, response } = entry;
    if (typeof symbol !== "string" || !Array.isArray(response) || response.length === 0) continue;
    if (isRecord(response[0])) {
      out.set(symbol, JSON.stringify({ chart: { result: [response[0]], error: null } }));
    }
  }
  return out;
}

/** The yahoo alias of an instrument (its symbol at Yahoo), or null. */
export function yahooSymbolOf(instrument: Instrument): string | null {
  return aliasOf(instrument, AliasNamespace.YAHOO);
}
