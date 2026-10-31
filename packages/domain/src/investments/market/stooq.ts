/**
 * Stooq's CSV download, the pure part (`market/stooq.py`). Blocked by a bot check since 2026-10
 * (detected, never bypassed). The HTTP source is `@cashu/market` `StooqPriceSource`.
 *
 * - CSV with Polish (`Data,Otwarcie,...,Zamkniecie,Wolumen`) or English (`Date,Open,...`) headers; the
 *   volume column is optional (indices, funds).
 * - `Brak danych` / `No data`: an empty list (stooq answers the same for an unknown symbol and for a
 *   range without sessions).
 * - Bot-protection page, daily hit limit or API key demand: `SourceBlockedException`. The composite
 *   then stops asking stooq for the rest of the run; nothing tries to pass the check.
 * - Any other HTML or unexpected text, or a malformed row: a non-retryable `SourceException`.
 *
 * Stooq reports no quote currency, so its bars carry `currency = null` (not checked).
 */

import { type DateTime, fromIsoFormat } from "../../dates.js";
import { Decimal, roundFloatToInt } from "../../decimal.js";
import { pyLower, pyStrip } from "../../text.js";
import { AliasNamespace } from "../domain/instrument.js";
import { type PriceBar, priceBar } from "../domain/marketData.js";
import type { CalendarDate, InstrumentId } from "../domain/values.js";
import { bodySnippet, SourceBlockedException, SourceException } from "./sources.js";

export const STOOQ_SOURCE_ID = AliasNamespace.STOOQ;

/** `YYYYMMDD` of a date (stooq's `d1` / `d2` parameters). */
export function compactDate(on: CalendarDate): string {
  return on.replaceAll("-", "");
}

/** Query parameters of a stooq daily download. */
export function stooqParams(
  symbol: string,
  start: CalendarDate,
  end: CalendarDate,
): Record<string, string> {
  return { s: symbol, i: "d", d1: compactDate(start), d2: compactDate(end) };
}

/** Python `Decimal(value)` that must be finite (`_required_decimal`); throws on anything else. */
function requiredDecimal(value: string | null): Decimal {
  return Decimal.parse(value ?? "");
}

/** Python `int(value)`, else `round(float(value))` (`_volume`). */
function volumeOf(value: string): number {
  const text = pyStrip(value);
  if (/^[+-]?\d+(_\d+)*$/.test(text)) return Number(text.replaceAll("_", ""));
  if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(text)) {
    throw new Error(`could not convert string to float: '${value}'`);
  }
  return Number(roundFloatToInt(Number(text)));
}

/** Parses a stooq CSV body into bars dated within `start..end`, oldest first (`parse`). */
export function parseStooq(
  body: string,
  instrumentId: InstrumentId,
  start: CalendarDate,
  end: CalendarDate,
  options: { readonly symbol?: string | null; readonly fetchedAt: DateTime | null },
): PriceBar[] {
  const text = pyStrip(body.replace("﻿", ""));
  const lower = pyLower(text);
  const symbol = options.symbol ?? null;
  const what = symbol === null ? "" : ` for "${symbol}"`;
  if (lower.startsWith("brak danych") || lower.startsWith("no data")) return [];
  if (text === "") {
    throw new SourceException(STOOQ_SOURCE_ID, `empty response${what}`, { retryable: true });
  }
  if (
    lower.includes("verify your browser") ||
    lower.includes("/__verify") ||
    lower.includes("captcha")
  ) {
    throw new SourceBlockedException(
      STOOQ_SOURCE_ID,
      `answered with a browser verification page${what}`,
    );
  }
  if (lower.includes("limit") && (lower.includes("przekroczony") || lower.includes("exceeded"))) {
    throw new SourceBlockedException(STOOQ_SOURCE_ID, `daily request limit exceeded${what}`, {
      retryable: true,
    });
  }
  if (lower.includes("apikey") || lower.includes("api key")) {
    throw new SourceBlockedException(
      STOOQ_SOURCE_ID,
      `demands an API key${what}: ${bodySnippet(text)}`,
    );
  }
  if (lower.startsWith("<") || lower.includes("<html")) {
    throw new SourceException(STOOQ_SOURCE_ID, `answered with an HTML page instead of CSV${what}`);
  }

  const lines = text.split(/\r?\n/).filter((line) => pyStrip(line) !== "");
  const header = (lines[0] ?? "").split(",").map((cell) => pyLower(pyStrip(cell)));
  const column = (...names: string[]): number | null => {
    const index = header.findIndex((cell) => names.includes(cell));
    return index < 0 ? null : index;
  };
  const dateCol = column("data", "date");
  const closeCol = column("zamkniecie", "close");
  if (dateCol === null || closeCol === null) {
    throw new SourceException(STOOQ_SOURCE_ID, `unexpected response${what}: ${bodySnippet(text)}`);
  }
  const openCol = column("otwarcie", "open");
  const highCol = column("najwyzszy", "high");
  const lowCol = column("najnizszy", "low");
  const volumeCol = column("wolumen", "volume");

  const bars = new Map<CalendarDate, PriceBar>();
  lines.slice(1).forEach((line, index) => {
    const cells = line.split(",");
    const cell = (col: number | null): string | null => {
      if (col === null || col >= cells.length) return null;
      const value = pyStrip(cells[col] as string);
      return value === "" ? null : value;
    };
    try {
      const on = fromIsoFormat(cell(dateCol) ?? "");
      if (on < start || on > end) return;
      const volume = cell(volumeCol);
      const open = cell(openCol);
      const high = cell(highCol);
      const low = cell(lowCol);
      bars.set(
        on,
        priceBar({
          instrumentId,
          date: on,
          open: open === null ? null : requiredDecimal(open),
          high: high === null ? null : requiredDecimal(high),
          low: low === null ? null : requiredDecimal(low),
          close: requiredDecimal(cell(closeCol)),
          volume: volume === null ? null : volumeOf(volume),
          source: STOOQ_SOURCE_ID,
          fetchedAt: options.fetchedAt,
        }),
      );
    } catch (error) {
      throw new SourceException(
        STOOQ_SOURCE_ID,
        `malformed CSV row ${index + 2}${what}: ${bodySnippet(line)}`,
        { cause: error },
      );
    }
  });
  return [...bars.keys()].sort().map((on) => bars.get(on) as PriceBar);
}
