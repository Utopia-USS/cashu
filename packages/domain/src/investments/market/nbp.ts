/**
 * NBP table A mid rates (official, free, no key), the pure part (`market/nbp.py`): PLN per 1 unit of a
 * currency. The HTTP source is `@cashu/market` `NbpFxSource`.
 *
 * Long ranges are split into requests of at most `maxDaysPerRequest` days (inclusive). NBP answers
 * HTTP 404 "Brak danych" for a range without any table (weekend, holiday, or a currency outside table
 * A): that chunk simply contributes no rates. PLN itself has no rates (identity). Rates are exact
 * decimals: the JSON numbers are read from their text, never through a float.
 */

import { addDays, type DateTime, fromIsoFormat } from "../../dates.js";
import { Decimal } from "../../decimal.js";
import { pyUpper } from "../../text.js";
import { type FxRate, fxRate } from "../domain/marketData.js";
import { type CalendarDate, Currencies, type Currency, toCurrency } from "../domain/values.js";
import { isRecord, PyJsonError, parsePyJson } from "./pyJson.js";
import { bodySnippet, SourceException } from "./sources.js";

export const NBP_SOURCE_ID = "nbp";

/**
 * Days per request, both ends inclusive. NBP documented 93; the live limit observed on 2026-10-04 is
 * 367 ("Limit of 367 days has been exceeded"). 93 works under both.
 */
export const NBP_MAX_DAYS_PER_REQUEST = 93;

/** A JSON number read exactly (Python `parse_float=Decimal`; an int is `Decimal(int)` too). */
class JsonDecimal {
  readonly value: Decimal;
  constructor(text: string) {
    this.value = Decimal.parse(text);
  }
}

const decimalJson = (body: string): unknown => parsePyJson(body, (text) => new JsonDecimal(text));

/** The contiguous `[start, end]` chunks of at most `maxDays` days covering `start..end`. */
export function nbpChunks(
  start: CalendarDate,
  end: CalendarDate,
  maxDays: number = NBP_MAX_DAYS_PER_REQUEST,
): (readonly [CalendarDate, CalendarDate])[] {
  if (maxDays <= 0) throw new RangeError("max_days_per_request must be positive");
  const chunks: (readonly [CalendarDate, CalendarDate])[] = [];
  for (let chunkStart = start; chunkStart <= end; chunkStart = addDays(chunkStart, maxDays)) {
    const last = addDays(chunkStart, maxDays - 1);
    chunks.push([chunkStart, last < end ? last : end]);
  }
  return chunks;
}

/** Path of a per-currency rates request. */
export function nbpRatesPath(quote: Currency, start: CalendarDate, end: CalendarDate): string {
  return `/api/exchangerates/rates/A/${quote.toLowerCase()}/${start}/${end}/`;
}

/** Path of a whole-table request. */
export function nbpTablesPath(start: CalendarDate, end: CalendarDate): string {
  return `/api/exchangerates/tables/A/${start}/${end}/`;
}

/** Python `str(entry)` stand-in for error messages. */
function show(value: unknown): string {
  return JSON.stringify(value, (_key, v) => (v instanceof JsonDecimal ? v.value.toString() : v));
}

/** Parses a table A rates response for `quote` into rates dated within `start..end` (`parse`). */
export function parseNbpRates(
  body: string,
  quote: Currency,
  start: CalendarDate,
  end: CalendarDate,
  fetchedAt: DateTime | null,
): FxRate[] {
  const unexpected = (detail: string, cause?: unknown) =>
    new SourceException(NBP_SOURCE_ID, `unexpected response for ${quote}: ${detail}`, { cause });
  let data: unknown;
  try {
    data = decimalJson(body);
  } catch (error) {
    if (error instanceof PyJsonError) throw unexpected(bodySnippet(body), error);
    throw error;
  }
  if (!isRecord(data) || !Array.isArray(data.rates)) throw unexpected(bodySnippet(body));
  const code = data.code;
  if (typeof code === "string" && pyUpper(code) !== quote) throw unexpected(`rates for ${code}`);
  const rates: FxRate[] = [];
  for (const entry of data.rates) {
    const effective = isRecord(entry) ? entry.effectiveDate : undefined;
    const mid = isRecord(entry) ? entry.mid : undefined;
    if (typeof effective !== "string" || !(mid instanceof JsonDecimal)) {
      throw unexpected(`rate entry ${bodySnippet(show(entry))}`);
    }
    let on: CalendarDate;
    try {
      on = fromIsoFormat(effective);
    } catch (error) {
      throw unexpected(`rate entry ${bodySnippet(show(entry))}`, error);
    }
    if (on < start || on > end) continue;
    rates.push(fxRate({ quote, date: on, rate: mid.value, source: NBP_SOURCE_ID, fetchedAt }));
  }
  return rates.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/**
 * Parses a table A tables response into rates per currency dated within `start..end`, oldest first
 * (`parse_tables`). Entries without a code or a numeric mid, unknown codes and PLN are skipped.
 */
export function parseNbpTables(
  body: string,
  start: CalendarDate,
  end: CalendarDate,
  fetchedAt: DateTime | null,
): Map<Currency, FxRate[]> {
  const unexpected = (detail: string, cause?: unknown) =>
    new SourceException(NBP_SOURCE_ID, `unexpected tables response: ${detail}`, { cause });
  let data: unknown;
  try {
    data = decimalJson(body);
  } catch (error) {
    if (error instanceof PyJsonError) throw unexpected(bodySnippet(body), error);
    throw error;
  }
  if (!Array.isArray(data)) throw unexpected(bodySnippet(body));
  const out = new Map<Currency, Map<CalendarDate, FxRate>>();
  for (const table of data) {
    const effective = isRecord(table) ? table.effectiveDate : undefined;
    const entries = isRecord(table) ? table.rates : undefined;
    if (typeof effective !== "string" || !Array.isArray(entries)) {
      throw unexpected(`table ${bodySnippet(show(table))}`);
    }
    let on: CalendarDate;
    try {
      on = fromIsoFormat(effective);
    } catch (error) {
      throw unexpected(`table date '${effective}'`, error);
    }
    if (on < start || on > end) continue;
    for (const entry of entries) {
      const code = isRecord(entry) ? entry.code : undefined;
      const mid = isRecord(entry) ? entry.mid : undefined;
      if (typeof code !== "string" || !(mid instanceof JsonDecimal)) continue;
      let quote: Currency;
      try {
        quote = toCurrency(code);
      } catch {
        continue;
      }
      if (quote === Currencies.PLN) continue;
      let series = out.get(quote);
      if (series === undefined) {
        series = new Map();
        out.set(quote, series);
      }
      series.set(
        on,
        fxRate({ quote, date: on, rate: mid.value, source: NBP_SOURCE_ID, fetchedAt }),
      );
    }
  }
  const result = new Map<Currency, FxRate[]>();
  for (const [quote, series] of out) {
    result.set(
      quote,
      [...series.keys()].sort().map((on) => series.get(on) as FxRate),
    );
  }
  return result;
}
