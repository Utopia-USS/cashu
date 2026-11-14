/**
 * Market data source contracts: price and FX sources, their answers and their errors
 * (`market/sources.py`). Sources are async (the HTTP implementations live in `@cashu/market`, on the
 * leader only); everything that plans or combines their answers is pure and lives here.
 */

import type { Decimal } from "../../decimal.js";
import { PY_WS } from "../../text.js";
import type { Instrument } from "../domain/instrument.js";
import type { FxRate, PriceBar } from "../domain/marketData.js";
import type { CalendarDate, Currency } from "../domain/values.js";

// --- errors -------------------------------------------------------------------------------------

export interface SourceErrorOptions {
  /** True for transient failures (429, 5xx, network errors) a later run may not hit. */
  readonly retryable?: boolean;
  readonly cause?: unknown;
}

/** A market data source failed (HTTP error, timeout, unexpected format, "no such symbol"). */
export class SourceException extends Error {
  readonly sourceId: string;
  /** The message without the class / source prefix (Python `.message`). */
  readonly detail: string;
  readonly retryable: boolean;

  constructor(sourceId: string, message: string, options: SourceErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "SourceException";
    this.sourceId = sourceId;
    this.detail = message;
    this.retryable = options.retryable ?? false;
  }

  /** Python `str(error)`: `SourceException(yahoo, retryable): HTTP 503`. */
  override toString(): string {
    return `${this.name}(${this.sourceId}${this.retryable ? ", retryable" : ""}): ${this.detail}`;
  }
}

/**
 * The source refused to serve this client: a bot-protection page, a daily request limit, an API key
 * demand, HTTP 401/403, or rate limiting (429) that persisted through every retry. Not specific to one
 * instrument, so the composite stops asking the source for the rest of its lifetime (one run). Nothing
 * ever tries to get around a bot check.
 */
export class SourceBlockedException extends SourceException {
  constructor(sourceId: string, message: string, options: SourceErrorOptions = {}) {
    super(sourceId, message, options);
    this.name = "SourceBlockedException";
  }
}

/**
 * The source quotes the instrument in another currency than `Instrument.currency` (after minor-unit
 * normalization, e.g. GBp -> GBP): its bars would be valued wrongly, so none are returned. Not
 * retryable (R3).
 */
export class QuoteCurrencyMismatchException extends SourceException {
  readonly quoteCurrency: Currency;
  readonly instrumentCurrency: Currency;

  constructor(
    sourceId: string,
    message: string,
    currencies: { readonly quoteCurrency: Currency; readonly instrumentCurrency: Currency },
  ) {
    super(sourceId, message);
    this.name = "QuoteCurrencyMismatchException";
    this.quoteCurrency = currencies.quoteCurrency;
    this.instrumentCurrency = currencies.instrumentCurrency;
  }
}

/**
 * No configured source can price the instrument (no alias in any source's namespace, e.g. a treasury
 * bond). A configuration gap, not a transport failure.
 */
export class NoPriceSourceException extends SourceException {
  constructor(sourceId: string, message: string, options: SourceErrorOptions = {}) {
    super(sourceId, message, options);
    this.name = "NoPriceSourceException";
  }
}

/** Python `f"{type(error).__name__}: {error}"` of an unexpected (non-source) error. */
export function describeError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return `Error: ${String(error)}`;
}

/** Python `repr(error)` of an unexpected error, as the composite and batched sources record it. */
export function reprError(error: unknown): string {
  if (error instanceof Error) return `${error.name}(${JSON.stringify(error.message)})`;
  return `Error(${JSON.stringify(String(error))})`;
}

// --- answers ------------------------------------------------------------------------------------

/**
 * A stock split reported by a price source: `ratio` new units per old unit (4:1 is 4), effective on
 * `date` (exchange calendar date).
 */
export interface SplitEvent {
  readonly date: CalendarDate;
  readonly ratio: Decimal;
}

/** Everything a price source answered for one request. */
export interface PriceHistory {
  /** Bars dated within the requested range, oldest first, prices in `currency`. */
  readonly bars: readonly PriceBar[];
  /**
   * Splits the source reported within the range. A source that reports splits serves split-adjusted
   * closes, so bars stored before a split are stale (R6).
   */
  readonly splits: readonly SplitEvent[];
  /**
   * Quote currency after minor-unit normalization, already checked against the instrument currency;
   * null when the source reports none.
   */
  readonly currency: Currency | null;
}

/** `PriceHistory(...)` with Python's defaults. */
export function priceHistory(init: Partial<PriceHistory> = {}): PriceHistory {
  return Object.freeze({
    bars: Object.freeze([...(init.bars ?? [])]),
    splits: Object.freeze([...(init.splits ?? [])]),
    currency: init.currency ?? null,
  });
}

// --- source contracts ---------------------------------------------------------------------------

/** Daily price history of instruments (stooq, yahoo, composite, batched). */
export interface PriceSource {
  /** Stable id, stored as `PriceBar.source` (`stooq`, `yahoo`). */
  readonly id: string;
  /**
   * Daily bars with `start <= date <= end`, oldest first, plus split events and the quote currency.
   * The source picks its symbol from the instrument's alias. No data in the range is an empty answer;
   * transport or format failures reject with `SourceException`. Prices are in the instrument currency:
   * a source that learns the quote currency rejects a mismatch with `QuoteCurrencyMismatchException`.
   */
  fetch(instrument: Instrument, start: CalendarDate, end: CalendarDate): Promise<PriceHistory>;
}

/** `PriceSource.history`: the bars of `fetch`. */
export async function history(
  source: PriceSource,
  instrument: Instrument,
  start: CalendarDate,
  end: CalendarDate,
): Promise<PriceBar[]> {
  return [...(await source.fetch(instrument, start, end)).bars];
}

/** Daily FX rates against PLN (NBP table A mid rates). */
export interface FxSource {
  /** Stable id, stored as `FxRate.source` (`nbp`). */
  readonly id: string;
  /**
   * Rates of `quote` with `start <= date <= end`, oldest first: PLN per 1 unit of `quote`
   * (`FxRate.base` is PLN). Days without a published rate are absent. Failures reject with
   * `SourceException`.
   */
  rates(quote: Currency, start: CalendarDate, end: CalendarDate): Promise<FxRate[]>;
}

const WHITESPACE_RUN = new RegExp(`[${PY_WS}]+`, "gu");

/** The first `maxChars` characters of `body` on one line, for error messages (`body_snippet`). */
export function bodySnippet(body: string, maxChars = 120): string {
  const flat = body.replace(WHITESPACE_RUN, " ");
  const trimmed = flat.replace(/^ /u, "").replace(/ $/u, "");
  return Array.from(trimmed).slice(0, maxChars).join("");
}
