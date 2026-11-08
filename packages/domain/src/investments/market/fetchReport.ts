/**
 * Outcome of a market data refresh: per instrument and per currency, with the data to persist
 * (`market/fetch_report.py`).
 */

import type { FxRate, PriceBar } from "../domain/marketData.js";
import type { CalendarDate, Currency, InstrumentId } from "../domain/values.js";

/** Outcome of refreshing one instrument or currency (value = wire name). */
export const FetchStatus = Object.freeze({
  /** Data was fetched, or the stored data was already up to date (no request made). */
  OK: "ok",
  /** The source answered without data for the range, or no source can price the instrument. */
  NO_DATA: "no_data",
  /** Not fetched on purpose: a delisted or frozen instrument. */
  SKIPPED: "skipped",
  /** The fetch failed (transport, blocked source, unexpected format, currency mismatch). */
  ERROR: "error",
} as const);
export type FetchStatus = (typeof FetchStatus)[keyof typeof FetchStatus];

/**
 * Price refresh outcome of one instrument, including the bars to store.
 *
 * Persistence: when `replaceFrom` is set (a split made the refresher fetch the whole stored window
 * again), delete the stored bars of the instrument dated `replaceFrom..end` and insert `bars` in one
 * transaction; otherwise upsert `bars` by (instrument, date).
 */
export interface InstrumentFetch {
  readonly instrumentId: InstrumentId;
  /** Symbol or name, for messages. */
  readonly label: string;
  readonly status: FetchStatus;
  /** Requested range start; null when no request was needed. */
  readonly start: CalendarDate | null;
  readonly end: CalendarDate | null;
  readonly bars: readonly PriceBar[];
  /** Source(s) that delivered the bars (`stooq`, `yahoo`), null without bars. */
  readonly source: string | null;
  readonly message: string | null;
  /** Quote currency the source reported (= the instrument currency), null when it reports none. */
  readonly currency: Currency | null;
  readonly refetchedForSplit: boolean;
  readonly replaceFrom: CalendarDate | null;
}

export type InstrumentFetchInit = Pick<InstrumentFetch, "instrumentId" | "label" | "status"> &
  Partial<Omit<InstrumentFetch, "instrumentId" | "label" | "status">>;

export function instrumentFetch(init: InstrumentFetchInit): InstrumentFetch {
  return Object.freeze({
    start: null,
    end: null,
    source: null,
    message: null,
    currency: null,
    refetchedForSplit: false,
    replaceFrom: null,
    ...init,
    bars: Object.freeze([...(init.bars ?? [])]),
  });
}

/** FX refresh outcome of one quote currency (rates in PLN per 1 unit), with the rates to upsert. */
export interface FxFetch {
  readonly currency: Currency;
  readonly status: FetchStatus;
  readonly start: CalendarDate | null;
  readonly end: CalendarDate | null;
  readonly rates: readonly FxRate[];
  readonly source: string | null;
  readonly message: string | null;
}

export type FxFetchInit = Pick<FxFetch, "currency" | "status"> &
  Partial<Omit<FxFetch, "currency" | "status">>;

export function fxFetch(init: FxFetchInit): FxFetch {
  return Object.freeze({
    start: null,
    end: null,
    source: null,
    message: null,
    ...init,
    rates: Object.freeze([...(init.rates ?? [])]),
  });
}

/**
 * Result of a refresh: one entry per instrument and per requested currency, in input order. A failure
 * is an entry, never a rejection.
 */
export interface FetchReport {
  readonly asOf: CalendarDate;
  readonly instruments: readonly InstrumentFetch[];
  readonly fx: readonly FxFetch[];
}

export function fetchReport(
  asOf: CalendarDate,
  instruments: Iterable<InstrumentFetch> = [],
  fx: Iterable<FxFetch> = [],
): FetchReport {
  return Object.freeze({
    asOf,
    instruments: Object.freeze([...instruments]),
    fx: Object.freeze([...fx]),
  });
}

/** `FetchReport.has_errors`. */
export function reportHasErrors(report: FetchReport): boolean {
  return (
    report.instruments.some((i) => i.status === FetchStatus.ERROR) ||
    report.fx.some((f) => f.status === FetchStatus.ERROR)
  );
}

/** `FetchReport.error_messages`: one human-readable line per error (for the run log). */
export function reportErrorMessages(report: FetchReport): string[] {
  return [
    ...report.instruments
      .filter((i) => i.status === FetchStatus.ERROR)
      .map((i) => `prices ${i.label} (${i.instrumentId}): ${i.message}`),
    ...report.fx
      .filter((f) => f.status === FetchStatus.ERROR)
      .map((f) => `fx ${f.currency}: ${f.message}`),
  ];
}

export interface FetchStats {
  readonly instruments_ok: number;
  readonly instruments_no_data: number;
  readonly instruments_skipped: number;
  readonly instruments_error: number;
  readonly bars_fetched: number;
  readonly fx_ok: number;
  readonly fx_no_data: number;
  readonly fx_error: number;
  readonly rates_fetched: number; // float-ok: a count (Python int), not money
}

/** `FetchReport.to_stats`: counts for the run log (JSON-encodable). */
export function reportStats(report: FetchReport): FetchStats {
  const count = (items: readonly { readonly status: FetchStatus }[], status: FetchStatus) =>
    items.filter((item) => item.status === status).length;
  return {
    instruments_ok: count(report.instruments, FetchStatus.OK),
    instruments_no_data: count(report.instruments, FetchStatus.NO_DATA),
    instruments_skipped: count(report.instruments, FetchStatus.SKIPPED),
    instruments_error: count(report.instruments, FetchStatus.ERROR),
    bars_fetched: report.instruments.reduce((n, i) => n + i.bars.length, 0),
    fx_ok: count(report.fx, FetchStatus.OK),
    fx_no_data: count(report.fx, FetchStatus.NO_DATA),
    fx_error: count(report.fx, FetchStatus.ERROR),
    rates_fetched: report.fx.reduce((n, f) => n + f.rates.length, 0),
  };
}
