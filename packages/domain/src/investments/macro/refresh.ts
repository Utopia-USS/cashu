/**
 * Macro series refresh, the pure part (`macro/refresh.py`, P6): fetch the whole window of every
 * reference series over an injected chart source (Yahoo `chart(symbol, start, end)`) and return the
 * closes to store in a `MacroReport`. No store access: the caller writes the report in its own short
 * transaction afterwards, so nothing is held open while this waits for the network.
 *
 * Window: `asOf - BACKFILL_DAYS .. asOf` for every series on every run, so restated adjusted closes
 * (a new ETF payout rescales Yahoo's whole adjusted history) and late corrections replace the stored
 * ones. ETFs (`MacroSeries.adjusted`) store the adjusted close; indices and yields the raw close.
 *
 * Failures: every failure is an entry in the report (status `error`), never a rejection. Circuit
 * breaker: after a blocked source or a retryable failure (timeout, transport error, 429, 5xx) the
 * remaining series are not asked (one `skipped` entry names them), so a hanging or blocking source
 * costs one request's retries, not seven. Series are fetched one after another; the parallel worker
 * pool, the HTTP source and the daily-check wiring are the refresh orchestration (S22c).
 */

import { addDays, type IsoDate } from "../../dates.js";
import type { Decimal } from "../../decimal.js";
import type { PriceBar } from "../domain/marketData.js";
import { BACKFILL_DAYS, type MacroSeries, SERIES } from "./series.js";

export const SKIPPED_MESSAGE = "not asked: the source failed earlier in this run";
/** Per attempt timeout of a macro request (the production HTTP client of the macro source). */
export const TIMEOUT_SECONDS = 10.0;
/** Retries of a macro request after the first attempt. */
export const MAX_RETRIES = 1;

/**
 * Outcome of refreshing one series (`market.FetchStatus`, value = wire name).
 * TRANSITIONAL(S18): replace with the market layer's FetchStatus once it is ported.
 */
export const FetchStatus = Object.freeze({
  OK: "ok",
  NO_DATA: "no_data",
  SKIPPED: "skipped",
  ERROR: "error",
});
export type FetchStatus = (typeof FetchStatus)[keyof typeof FetchStatus];

/**
 * A market source failure (`market.SourceException`; `blocked` = `SourceBlockedException`).
 * TRANSITIONAL(S18): replace with the market layer's source errors once they are ported.
 */
export class MacroSourceError extends Error {
  readonly sourceId: string;
  readonly retryable: boolean;
  readonly blocked: boolean;

  constructor(
    sourceId: string,
    message: string,
    options: { readonly retryable?: boolean; readonly blocked?: boolean } = {},
  ) {
    super(message);
    this.name = options.blocked ? "SourceBlockedException" : "SourceException";
    this.sourceId = sourceId;
    this.retryable = options.retryable ?? false;
    this.blocked = options.blocked ?? false;
  }
}

/** What the refresh reads of a chart answer (`market.ChartQuote`: `bars`, `adjusted`). */
export interface MacroChartQuote {
  readonly bars: readonly Pick<PriceBar, "date" | "close" | "source">[];
  /** Distribution-adjusted closes, oldest first; empty or absent when the answer has none. */
  readonly adjusted?: readonly (readonly [IsoDate, Decimal])[];
}

/** A chart source by public symbol (the Yahoo source satisfies it; tests pass fakes). */
export interface MacroChartSource {
  chart(
    symbol: string,
    start: IsoDate,
    end: IsoDate,
    instrumentId: string,
  ): Promise<MacroChartQuote>;
}

/**
 * The refresh outcome of one series (or, for `skipped`, of the series not asked: their keys joined by
 * `", "`), with the closes to upsert by (series, date).
 */
export interface MacroFetch {
  readonly series: string;
  readonly symbol: string;
  readonly status: FetchStatus;
  readonly start: IsoDate | null;
  readonly end: IsoDate | null;
  readonly closes: readonly (readonly [IsoDate, Decimal])[];
  readonly source: string | null;
  readonly message: string | null;
  /** `closes` are distribution-adjusted (older stored bars are rescaled to match on write). */
  readonly adjusted: boolean;
}

export interface MacroReport {
  readonly asOf: IsoDate;
  readonly series: readonly MacroFetch[];
}

/** The series keys an entry covers (several for `skipped`). */
export function fetchKeys(fetch: MacroFetch): string[] {
  return fetch.series.split(", ");
}

/** `MacroFetch.to_json`. */
export function fetchJson(fetch: MacroFetch): Record<string, unknown> {
  return {
    series: fetch.series,
    symbol: fetch.symbol,
    status: fetch.status,
    from: fetch.start,
    to: fetch.end,
    bar_count: fetch.closes.length,
    source: fetch.source,
    message: fetch.message,
    adjusted: fetch.adjusted,
  };
}

/** `macro <series> (<symbol>): <message>` for every failed series. */
export function reportErrors(report: MacroReport): string[] {
  return report.series
    .filter((f) => f.status === FetchStatus.ERROR)
    .map((f) => `macro ${f.series} (${f.symbol}): ${f.message}`);
}

export interface MacroStats {
  readonly series_ok: number;
  readonly series_no_data: number;
  readonly series_error: number;
  readonly series_skipped: number;
  readonly bars_fetched: number;
}

/** `MacroReport.to_stats`: series per status (a skipped entry counts every series it names). */
export function reportStats(report: MacroReport): MacroStats {
  const count = (status: FetchStatus): number =>
    report.series.filter((f) => f.status === status).reduce((n, f) => n + fetchKeys(f).length, 0);
  return {
    series_ok: count(FetchStatus.OK),
    series_no_data: count(FetchStatus.NO_DATA),
    series_error: count(FetchStatus.ERROR),
    series_skipped: count(FetchStatus.SKIPPED),
    bars_fetched: report.series.reduce((n, f) => n + f.closes.length, 0),
  };
}

/** The first date every refresh fetches. */
export function windowStart(asOf: IsoDate): IsoDate {
  return addDays(asOf, -BACKFILL_DAYS);
}

/** Points inside `start..end`, one per day (the last one wins), oldest first. */
function inWindow(
  points: Iterable<readonly [IsoDate, Decimal]>,
  start: IsoDate,
  end: IsoDate,
): (readonly [IsoDate, Decimal])[] {
  const byDay = new Map<IsoDate, Decimal>();
  for (const [day, value] of points) if (start <= day && day <= end) byDay.set(day, value);
  return [...byDay.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

function entry(
  item: MacroSeries,
  start: IsoDate,
  end: IsoDate,
  status: FetchStatus,
  fields: Partial<Pick<MacroFetch, "closes" | "source" | "message" | "adjusted">> = {},
): MacroFetch {
  return {
    series: item.key,
    symbol: item.symbol,
    status,
    start,
    end,
    closes: fields.closes ?? [],
    source: fields.source ?? null,
    message: fields.message ?? null,
    adjusted: fields.adjusted ?? false,
  };
}

/** The error entry of a failed fetch and whether the circuit breaker trips. */
export function failedFetch(
  item: MacroSeries,
  start: IsoDate,
  asOf: IsoDate,
  error: unknown,
): [MacroFetch, boolean] {
  if (error instanceof MacroSourceError) {
    const message = `${error.sourceId}: ${error.message}`;
    return [
      entry(item, start, asOf, FetchStatus.ERROR, { message }),
      error.blocked || error.retryable,
    ];
  }
  // one broken series never aborts the refresh
  const message =
    error instanceof Error ? `${error.name}: ${error.message}` : `Error: ${String(error)}`;
  return [entry(item, start, asOf, FetchStatus.ERROR, { message }), false];
}

/** The entry of a chart answer: the adjusted closes of an ETF, else the raw closes, or `no_data`. */
export function quoteFetch(
  item: MacroSeries,
  start: IsoDate,
  asOf: IsoDate,
  quote: MacroChartQuote,
): MacroFetch {
  const raw = inWindow(
    quote.bars.map((b) => [b.date, b.close] as const),
    start,
    asOf,
  );
  const adjusted = item.adjusted ? inWindow(quote.adjusted ?? [], start, asOf) : [];
  if (raw.length === 0 && adjusted.length === 0) {
    return entry(item, start, asOf, FetchStatus.NO_DATA, {
      message: `no bars for ${start}..${asOf}`,
    });
  }
  const source =
    [...new Set(quote.bars.map((b) => b.source).filter((s) => s))].join(", ") || "yahoo";
  if (item.adjusted && adjusted.length > 0) {
    return entry(item, start, asOf, FetchStatus.OK, { closes: adjusted, source, adjusted: true });
  }
  if (item.adjusted) {
    // no adjusted close in the answer: the raw close, rescaled against the stored bars on write
    return entry(item, start, asOf, FetchStatus.OK, {
      closes: raw,
      source,
      adjusted: true,
      message: "no adjusted close in the answer: raw close stored",
    });
  }
  return entry(item, start, asOf, FetchStatus.OK, { closes: raw, source });
}

/** The one `skipped` entry naming every series not asked. */
export function skippedFetch(
  items: readonly MacroSeries[],
  start: IsoDate,
  asOf: IsoDate,
): MacroFetch {
  return {
    series: items.map((s) => s.key).join(", "),
    symbol: items.map((s) => s.symbol).join(", "),
    status: FetchStatus.SKIPPED,
    start,
    end: asOf,
    closes: [],
    source: null,
    message: SKIPPED_MESSAGE,
    adjusted: false,
  };
}

/**
 * Fetches every series' window one after another (module doc) and returns the closes to store; a
 * blocked or retryable failure skips the series after it.
 */
export async function refreshMacro(
  source: MacroChartSource,
  asOf: IsoDate,
  series: readonly MacroSeries[] = SERIES,
): Promise<MacroReport> {
  const start = windowStart(asOf);
  const out: MacroFetch[] = [];
  const skipped: MacroSeries[] = [];
  let broken = false;
  for (const item of series) {
    if (broken) {
      skipped.push(item);
      continue;
    }
    let fetched: MacroFetch;
    try {
      const quote = await source.chart(item.symbol, start, asOf, `macro:${item.key}`);
      fetched = quoteFetch(item, start, asOf, quote);
    } catch (error) {
      [fetched, broken] = failedFetch(item, start, asOf, error);
    }
    out.push(fetched);
  }
  if (skipped.length > 0) out.push(skippedFetch(skipped, start, asOf));
  return { asOf, series: out };
}
