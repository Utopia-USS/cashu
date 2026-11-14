/**
 * Incremental price and FX refresh planning (`market/refresh.py`). Reads what is stored through
 * `StoredMarketData`, fetches from the injected sources, and returns the data to persist in a
 * `FetchReport` (no store writes here: the caller applies the report in its own short transaction,
 * so nothing is held open while this waits for the network).
 */

import { addDays, type DateTime, toStorage } from "../../dates.js";
import { fetchesMarketData, type Instrument, type ManualValuation } from "../domain/instrument.js";
import type { FxRate, PriceBar } from "../domain/marketData.js";
import { type MarketView, marketView } from "../domain/snapshot.js";
import {
  type CalendarDate,
  Currencies,
  type Currency,
  type InstrumentId,
} from "../domain/values.js";
import { InMemoryFxLookup } from "../portfolio/fxLookup.js";
import type { MarketLog } from "./composite.js";
import {
  type FetchReport,
  FetchStatus,
  type FxFetch,
  fetchReport,
  fxFetch,
  type InstrumentFetch,
  type InstrumentFetchInit,
  instrumentFetch,
  reportStats,
} from "./fetchReport.js";
import {
  describeError,
  type FxSource,
  NoPriceSourceException,
  type PriceHistory,
  type PriceSource,
  priceHistory,
  SourceException,
} from "./sources.js";

/** Read-only view of the stored bars and rates the refresher plans against (per instrument). */
export interface StoredMarketData {
  lastBarDate(instrumentId: InstrumentId): CalendarDate | null;
  firstBarDate(instrumentId: InstrumentId): CalendarDate | null;
  /**
   * True when a stored bar dated before `datedBefore` was fetched before `fetchedBefore` (a bar
   * without a fetch time counts as fetched before).
   */
  hasBarsFetchedBefore(
    instrumentId: InstrumentId,
    datedBefore: CalendarDate,
    fetchedBefore: DateTime,
  ): boolean;
  lastRateDate(quote: Currency): CalendarDate | null;
  firstRateDate(quote: Currency): CalendarDate | null;
  hasRateOnOrBefore(quote: Currency, on: CalendarDate): boolean;
}

export interface RefresherOptions {
  /** Days fetched when nothing is stored (`as_of - backfill_days .. as_of`). */
  readonly backfillDays?: number;
  /** Stored days fetched again (a bar stored while its session was open gets its final close). */
  readonly refetchDays?: number;
  /**
   * Instruments and currencies fetched at once (bounded concurrency; the sources' HTTP layer still
   * paces each host). Reports keep the input order either way.
   */
  readonly workers?: number;
  readonly log?: MarketLog;
}

export interface RefreshOptions {
  /**
   * When no rate of a currency exists on/before the given date (e.g. the open date of the oldest lot
   * in it, needed for its cost at trade-date FX), the missing span from a week before that date up to
   * the oldest stored rate is fetched as well.
   */
  readonly fxHistoryFrom?: ReadonlyMap<Currency, CalendarDate>;
  /** Newest split transaction date per instrument (triggers the re-fetch for sources without events). */
  readonly splitDates?: ReadonlyMap<InstrumentId, CalendarDate>;
}

const SILENT: MarketLog = { debug() {}, info() {}, warn() {} };

/** Runs `jobs` with at most `workers` at once; results in input order. */
async function boundedAll<R>(jobs: readonly (() => Promise<R>)[], workers: number): Promise<R[]> {
  const results = new Array<R>(jobs.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < jobs.length) {
      const index = next++;
      results[index] = await (jobs[index] as () => Promise<R>)();
    }
  };
  await Promise.all(Array.from({ length: Math.min(workers, jobs.length) }, worker));
  return results;
}

/** End of a UTC day (= the start of the next one) as a timestamp. */
function startOfNextUtcDay(on: CalendarDate): DateTime {
  return {
    date: addDays(on, 1),
    hour: 0,
    minute: 0,
    second: 0,
    microsecond: 0,
    offsetSeconds: 0,
  };
}

/** `a < b` for timestamps (naive = UTC, the store's convention). */
export function fetchedEarlier(a: DateTime, b: DateTime): boolean {
  return toStorage(a) < toStorage(b);
}

/**
 * True when bars dated before `splitDate` were stored before the split took effect (fetched before
 * the end of the split day, UTC), so the source's adjusted history differs from them.
 */
function storedUnadjusted(
  stored: StoredMarketData,
  instrumentId: InstrumentId,
  first: CalendarDate | null,
  splitDate: CalendarDate,
): boolean {
  if (first === null || first >= splitDate) return false;
  return stored.hasBarsFetchedBefore(instrumentId, splitDate, startOfNextUtcDay(splitDate));
}

/** The distinct sources of `bars` in first-seen order (`", "`-joined). */
function sourcesOf(bars: readonly PriceBar[]): string {
  return [...new Set(bars.map((bar) => bar.source))].join(", ");
}

/**
 * Incremental refresh of instrument bars and PLN rates (port of the Kompas `MarketDataService` without
 * the repository writes).
 *
 * Range per instrument / currency: from the last stored date (re-fetching `refetchDays` stored days)
 * or `asOf - backfillDays` when nothing is stored, up to `asOf`. Nothing is requested when the stored
 * data already reaches past that range. Instruments that do not fetch market data (delisted, frozen)
 * are skipped. Every failure is an entry in the report, never a rejection.
 *
 * Splits (R6): sources serve split-adjusted closes (Yahoo adjusts its whole history), so bars stored
 * before a split are unadjusted. When the source reports a split inside the fetched window, or the
 * portfolio has a split transaction of the instrument (`splitDates`), and bars dated before that split
 * were fetched before the end of the split day (UTC), the whole stored window (oldest stored bar ..
 * asOf) is fetched again and returned with `replaceFrom` set. A re-fetch without bars is an error and
 * the stored bars stay.
 */
export class MarketDataRefresher {
  readonly backfillDays: number;
  readonly refetchDays: number;
  readonly workers: number;
  private readonly prices: PriceSource;
  private readonly fx: FxSource;
  private readonly log: MarketLog;

  constructor(prices: PriceSource, fx: FxSource, options: RefresherOptions = {}) {
    const refetchDays = options.refetchDays ?? 1;
    const workers = options.workers ?? 1;
    if (refetchDays < 0) throw new RangeError("refetch_days must not be negative");
    if (workers < 1) throw new RangeError("workers must be positive");
    this.prices = prices;
    this.fx = fx;
    this.backfillDays = options.backfillDays ?? 400;
    this.refetchDays = refetchDays;
    this.workers = workers;
    this.log = options.log ?? SILENT;
  }

  /** Fetches bars of `instruments` and PLN rates of `currencies` up to `asOf`; PLN is skipped. */
  async refresh(
    stored: StoredMarketData,
    instruments: Iterable<Instrument>,
    currencies: Iterable<Currency>,
    asOf: CalendarDate,
    options: RefreshOptions = {},
  ): Promise<FetchReport> {
    const historyFrom = options.fxHistoryFrom ?? new Map<Currency, CalendarDate>();
    const splits = options.splitDates ?? new Map<InstrumentId, CalendarDate>();
    const byId = new Map<InstrumentId, Instrument>();
    for (const instrument of instruments) byId.set(instrument.id, instrument);
    const unique = [...byId.values()];
    const quotes = [...new Set(currencies)].filter((c) => c !== Currencies.PLN);
    const jobs: (() => Promise<InstrumentFetch | FxFetch>)[] = [
      ...unique.map(
        (instrument) => () =>
          this.refreshInstrument(stored, instrument, asOf, splits.get(instrument.id) ?? null),
      ),
      ...quotes.map(
        (currency) => () =>
          this.refreshCurrency(stored, currency, asOf, historyFrom.get(currency) ?? null),
      ),
    ];
    const results = await boundedAll(jobs, this.workers > 1 && jobs.length > 1 ? this.workers : 1);
    const report = fetchReport(
      asOf,
      results.slice(0, unique.length) as InstrumentFetch[],
      results.slice(unique.length) as FxFetch[],
    );
    this.log.info(`market refresh ${asOf}: ${JSON.stringify(reportStats(report))}`);
    return report;
  }

  private start(last: CalendarDate | null, asOf: CalendarDate): CalendarDate {
    return last === null ? addDays(asOf, -this.backfillDays) : addDays(last, 1 - this.refetchDays);
  }

  private async refreshInstrument(
    stored: StoredMarketData,
    instrument: Instrument,
    asOf: CalendarDate,
    splitDate: CalendarDate | null,
  ): Promise<InstrumentFetch> {
    const label = instrument.symbol || instrument.name;
    const result = (
      status: FetchStatus,
      start: CalendarDate | null = null,
      fields: Omit<Partial<InstrumentFetchInit>, "status" | "start" | "end"> = {},
    ): InstrumentFetch =>
      instrumentFetch({
        instrumentId: instrument.id,
        label,
        status,
        start,
        end: start === null ? null : asOf,
        ...fields,
      });

    if (!fetchesMarketData(instrument)) {
      return result(FetchStatus.SKIPPED, null, {
        message: `not fetched: instrument is ${instrument.status}`,
      });
    }
    const last = stored.lastBarDate(instrument.id);
    const first = stored.firstBarDate(instrument.id);
    let start = this.start(last, asOf);
    try {
      let reason: string | null = null;
      if (splitDate !== null && storedUnadjusted(stored, instrument.id, first, splitDate)) {
        reason = `split transaction on ${splitDate}`;
      }
      if (reason === null && start > asOf) {
        return result(FetchStatus.OK, null, { message: `up to date (last bar ${last})` });
      }

      let answer: PriceHistory | null = null;
      if (reason === null) {
        answer = await this.fetchBars(instrument, start, asOf);
        for (const split of answer.splits) {
          if (storedUnadjusted(stored, instrument.id, first, split.date)) {
            reason = `split ${split.ratio.toString()}:1 on ${split.date} reported by the source`;
            break;
          }
        }
      }
      if (reason !== null && first !== null) {
        start = first;
        const full = await this.fetchBars(instrument, start, asOf);
        if (full.bars.length === 0) {
          return result(FetchStatus.ERROR, start, {
            message: `${reason}: re-fetching ${start}..${asOf} returned no bars; stored bars kept`,
          });
        }
        this.log.info(
          `prices ${label} (${instrument.id}): ${reason}, re-fetched ${start}..${asOf}`,
        );
        return result(FetchStatus.OK, start, {
          bars: full.bars,
          source: sourcesOf(full.bars),
          message: `${reason}: re-fetched the stored window`,
          currency: full.currency,
          refetchedForSplit: true,
          replaceFrom: start,
        });
      }

      if (answer === null) throw new Error("unreachable: no answer without a split reason");
      if (answer.bars.length === 0) {
        return result(FetchStatus.NO_DATA, start, { message: `no bars for ${start}..${asOf}` });
      }
      return result(FetchStatus.OK, start, {
        bars: answer.bars,
        source: sourcesOf(answer.bars),
        currency: answer.currency,
      });
    } catch (error) {
      if (error instanceof NoPriceSourceException) {
        return result(FetchStatus.NO_DATA, start, { message: error.detail });
      }
      if (error instanceof SourceException) {
        this.log.warn(`prices ${label} (${instrument.id}) failed: ${error.toString()}`);
        return result(FetchStatus.ERROR, start, { message: `${error.sourceId}: ${error.detail}` });
      }
      // one broken instrument never aborts the refresh
      this.log.warn(`prices ${label} (${instrument.id}) failed unexpectedly`);
      return result(FetchStatus.ERROR, start, { message: describeError(error) });
    }
  }

  /** `PriceSource.fetch` restricted to bars of `instrument` within `start..end`. */
  private async fetchBars(
    instrument: Instrument,
    start: CalendarDate,
    end: CalendarDate,
  ): Promise<PriceHistory> {
    const answer = await this.prices.fetch(instrument, start, end);
    return priceHistory({
      bars: answer.bars.filter(
        (bar) => bar.instrumentId === instrument.id && start <= bar.date && bar.date <= end,
      ),
      splits: answer.splits,
      currency: answer.currency,
    });
  }

  private async refreshCurrency(
    stored: StoredMarketData,
    currency: Currency,
    asOf: CalendarDate,
    historyFrom: CalendarDate | null,
  ): Promise<FxFetch> {
    let start: CalendarDate | null = null;
    const fetched = new Map<CalendarDate, FxRate>();

    const result = (status: FetchStatus, message: string | null = null): FxFetch => {
      const rates = [...fetched.keys()].sort().map((on) => fetched.get(on) as FxRate);
      return fxFetch({
        currency,
        status,
        start,
        end: start === null ? null : asOf,
        rates,
        source: rates.length > 0 ? this.fx.id : null,
        message,
      });
    };
    const fetch = async (begin: CalendarDate, end: CalendarDate): Promise<void> => {
      for (const rate of await this.fx.rates(currency, begin, end)) {
        if (rate.quote === currency && begin <= rate.date && rate.date <= end)
          fetched.set(rate.date, rate);
      }
    };

    try {
      const last = stored.lastRateDate(currency);
      const incremental = this.start(last, asOf);
      let requested = false;
      if (incremental <= asOf) {
        start = incremental;
        requested = true;
        await fetch(incremental, asOf);
      }
      if (
        historyFrom !== null &&
        !(
          stored.hasRateOnOrBefore(currency, historyFrom) ||
          [...fetched.keys()].some((on) => on <= historyFrom)
        )
      ) {
        const historyStart = addDays(historyFrom, -7);
        const firsts = [stored.firstRateDate(currency), ...fetched.keys()].filter(
          (d): d is CalendarDate => d !== null,
        );
        const historyEnd = firsts.length > 0 ? addDays(firsts.sort()[0] as CalendarDate, -1) : asOf;
        if (historyStart <= historyEnd) {
          start = historyStart;
          requested = true;
          await fetch(historyStart, historyEnd);
        }
      }
      if (!requested) return result(FetchStatus.OK, `up to date (last rate ${last})`);
      if (fetched.size === 0) return result(FetchStatus.NO_DATA, `no rates for ${start}..${asOf}`);
      return result(FetchStatus.OK);
    } catch (error) {
      fetched.clear();
      if (error instanceof SourceException) {
        this.log.warn(`fx ${currency} failed: ${error.toString()}`);
        return result(FetchStatus.ERROR, `${error.sourceId}: ${error.detail}`);
      }
      // one broken currency never aborts the refresh
      this.log.warn(`fx ${currency} failed unexpectedly`);
      return result(FetchStatus.ERROR, describeError(error));
    }
  }
}

/**
 * Bars and rates in memory: a `StoredMarketData` for tests and small tools, and the reference
 * semantics of applying a `FetchReport` per instrument (`InMemoryMarketData`). The device's price
 * cache is keyed by provider + market symbol instead (`PriceCache`); `applyFetchReport` maps a report
 * onto it.
 */
export class InMemoryMarketData implements StoredMarketData {
  readonly bars = new Map<InstrumentId, Map<CalendarDate, PriceBar>>();
  readonly rates = new Map<Currency, Map<CalendarDate, FxRate>>();

  constructor(bars: Iterable<PriceBar> = [], rates: Iterable<FxRate> = []) {
    this.upsertBars(bars);
    this.upsertRates(rates);
  }

  upsertBars(bars: Iterable<PriceBar>): void {
    for (const bar of bars) {
      let series = this.bars.get(bar.instrumentId);
      if (series === undefined) {
        series = new Map();
        this.bars.set(bar.instrumentId, series);
      }
      series.set(bar.date, bar);
    }
  }

  upsertRates(rates: Iterable<FxRate>): void {
    for (const rate of rates) {
      if (rate.base !== Currencies.PLN) continue;
      let series = this.rates.get(rate.quote);
      if (series === undefined) {
        series = new Map();
        this.rates.set(rate.quote, series);
      }
      series.set(rate.date, rate);
    }
  }

  /** Stores a report's data: replace the window for split re-fetches, upsert otherwise. */
  apply(report: FetchReport): void {
    for (const item of report.instruments) {
      if (item.replaceFrom !== null) {
        const series = this.bars.get(item.instrumentId) ?? new Map<CalendarDate, PriceBar>();
        this.bars.set(item.instrumentId, series);
        const end = item.end ?? report.asOf;
        for (const on of [...series.keys()]) {
          if (item.replaceFrom <= on && on <= end) series.delete(on);
        }
      }
      this.upsertBars(item.bars);
    }
    for (const item of report.fx) this.upsertRates(item.rates);
  }

  lastBarDate(instrumentId: InstrumentId): CalendarDate | null {
    return extreme(this.bars.get(instrumentId), "max");
  }

  firstBarDate(instrumentId: InstrumentId): CalendarDate | null {
    return extreme(this.bars.get(instrumentId), "min");
  }

  hasBarsFetchedBefore(
    instrumentId: InstrumentId,
    datedBefore: CalendarDate,
    fetchedBefore: DateTime,
  ): boolean {
    for (const [on, bar] of this.bars.get(instrumentId) ?? []) {
      if (
        on < datedBefore &&
        (bar.fetchedAt === null || fetchedEarlier(bar.fetchedAt, fetchedBefore))
      ) {
        return true;
      }
    }
    return false;
  }

  lastRateDate(quote: Currency): CalendarDate | null {
    return extreme(this.rates.get(quote), "max");
  }

  firstRateDate(quote: Currency): CalendarDate | null {
    return extreme(this.rates.get(quote), "min");
  }

  hasRateOnOrBefore(quote: Currency, on: CalendarDate): boolean {
    return [...(this.rates.get(quote)?.keys() ?? [])].some((day) => day <= on);
  }

  /** A `MarketView` with the stored bars of `instruments` dated on/before `asOf`. */
  marketView(
    asOf: CalendarDate,
    instruments: Iterable<Instrument>,
    manualValuations: Iterable<ManualValuation> = [],
  ): MarketView {
    const listed = new Map<InstrumentId, Instrument>();
    for (const instrument of instruments) listed.set(instrument.id, instrument);
    const valuations = new Map<InstrumentId, ManualValuation[]>();
    for (const valuation of manualValuations) {
      const list = valuations.get(valuation.instrumentId) ?? [];
      list.push(valuation);
      valuations.set(valuation.instrumentId, list);
    }
    const bars = new Map<InstrumentId, readonly PriceBar[]>();
    for (const [instrumentId, series] of this.bars) {
      if (!listed.has(instrumentId)) continue;
      bars.set(
        instrumentId,
        [...series.keys()]
          .sort()
          .filter((on) => on <= asOf)
          .map((on) => series.get(on) as PriceBar),
      );
    }
    const manual = new Map<InstrumentId, readonly ManualValuation[]>();
    for (const [key, list] of valuations) {
      manual.set(
        key,
        [...list].sort((a, b) => (a.asOf < b.asOf ? -1 : a.asOf > b.asOf ? 1 : 0)),
      );
    }
    return marketView({ asOf, instruments: listed, bars, manualValuations: manual });
  }

  fxLookup(): InMemoryFxLookup {
    return new InMemoryFxLookup([...this.rates.values()].flatMap((series) => [...series.values()]));
  }
}

function extreme(
  series: ReadonlyMap<CalendarDate, unknown> | undefined,
  which: "min" | "max",
): CalendarDate | null {
  if (series === undefined || series.size === 0) return null;
  const days = [...series.keys()].sort();
  return (which === "max" ? days[days.length - 1] : days[0]) as CalendarDate;
}
