/**
 * The device's price cache: daily bars keyed by provider + market symbol (`yahoo:VWCE.DE`,
 * `stooq:pkn`) and FX rates keyed by provider + quote currency (`nbp:USD`, PLN per unit).
 *
 * Lead decision (2026-10-31): prices are public market data, so the cache is device-local, NEVER
 * synced, and shared by every profile on the device; it is keyed by the provider's symbol, never by an
 * instrument id (instrument ids differ per vault, the market symbol does not). This file holds the
 * contract (`PriceCache`), its reference semantics (`InMemoryPriceCache`), the per-instrument view the
 * refresher plans against (`cachedMarketData`) and how a `FetchReport` is written to it
 * (`applyFetchReport`). The SQLite implementation belongs to the leader's store (S22c).
 */

import type { DateTime } from "../../dates.js";
import type { Decimal } from "../../decimal.js";
import { AliasNamespace, aliasOf, type Instrument } from "../domain/instrument.js";
import { type FxRate, fxRate, type PriceBar, priceBar } from "../domain/marketData.js";
import {
  type CalendarDate,
  Currencies,
  type Currency,
  type InstrumentId,
} from "../domain/values.js";
import { defaultPriceSourceOrder, type PriceSourceOrder } from "./composite.js";
import type { FetchReport } from "./fetchReport.js";
import { NBP_SOURCE_ID } from "./nbp.js";
import { fetchedEarlier, type StoredMarketData } from "./refresh.js";

/** A symbol at one market data provider (= the alias namespace and the `PriceBar.source`). */
export interface MarketSymbol {
  readonly provider: string;
  readonly symbol: string;
}

export function marketSymbol(provider: string, symbol: string): MarketSymbol {
  return Object.freeze({ provider, symbol });
}

/** The cache key text `provider:symbol`. */
export function marketSymbolKey(key: MarketSymbol): string {
  return `${key.provider}:${key.symbol}`;
}

/** Providers whose symbols the cache holds bars for. */
export const PRICE_PROVIDERS: readonly string[] = Object.freeze([
  AliasNamespace.YAHOO,
  AliasNamespace.STOOQ,
]);

/** The instrument's market symbols, one per provider it has an alias for, in `providers` order. */
export function marketSymbolsOf(
  instrument: Instrument,
  providers: readonly string[] = PRICE_PROVIDERS,
): MarketSymbol[] {
  const out: MarketSymbol[] = [];
  for (const provider of providers) {
    const symbol = aliasOf(instrument, provider);
    if (symbol !== null) out.push(marketSymbol(provider, symbol));
  }
  return out;
}

/** One cached daily bar of a market symbol: no instrument id, the provider is the key's. */
export interface CachedBar {
  readonly date: CalendarDate;
  readonly close: Decimal;
  readonly open: Decimal | null;
  readonly high: Decimal | null;
  readonly low: Decimal | null;
  readonly volume: number | null;
  /** Quote currency the provider reported (minor units normalized), null when it reports none. */
  readonly currency: Currency | null;
  /** When the bar was fetched; never null once stored (the upsert fills in its `now`). */
  readonly fetchedAt: DateTime | null;
}

/** One cached FX rate: PLN per 1 unit of the key's quote currency. */
export interface CachedRate {
  readonly date: CalendarDate;
  readonly rate: Decimal;
  readonly fetchedAt: DateTime | null;
}

/**
 * Device-local price cache. Reads are synchronous (the leader's store runs in-process).
 *
 * Write semantics (`market.upsert_bars` / `upsert_rates`):
 * - bars upsert by (key, date): close, currency and fetch time are replaced; a close-only bar (the
 *   batched refresh) never erases the stored open / high / low / volume of that day;
 * - a bar or rate without a fetch time is stored with `now` (the split check needs to know);
 * - `deleteBars` removes a date window (a split re-fetch deletes before it upserts, so nothing
 *   unadjusted survives).
 */
export interface PriceCache {
  /** Bars of `key`, oldest first. */
  bars(key: MarketSymbol): readonly CachedBar[];
  upsertBars(key: MarketSymbol, bars: readonly CachedBar[], now: DateTime): void;
  deleteBars(key: MarketSymbol, from: CalendarDate, to: CalendarDate): void;
  /** Rates of `quote` from `provider`, oldest first. */
  rates(provider: string, quote: Currency): readonly CachedRate[];
  upsertRates(provider: string, quote: Currency, rates: readonly CachedRate[], now: DateTime): void;
}

/** The reference `PriceCache` in memory (tests, and the semantics the SQLite one must match). */
export class InMemoryPriceCache implements PriceCache {
  private readonly barSeries = new Map<string, Map<CalendarDate, CachedBar>>();
  private readonly rateSeries = new Map<string, Map<CalendarDate, CachedRate>>();

  bars(key: MarketSymbol): readonly CachedBar[] {
    return sortedValues(this.barSeries.get(marketSymbolKey(key)));
  }

  upsertBars(key: MarketSymbol, bars: readonly CachedBar[], now: DateTime): void {
    const series = getOrCreate(this.barSeries, marketSymbolKey(key));
    for (const bar of bars) {
      const old = series.get(bar.date);
      series.set(
        bar.date,
        Object.freeze({
          date: bar.date,
          close: bar.close,
          currency: bar.currency,
          fetchedAt: bar.fetchedAt ?? now,
          open: bar.open ?? old?.open ?? null,
          high: bar.high ?? old?.high ?? null,
          low: bar.low ?? old?.low ?? null,
          volume: bar.volume ?? old?.volume ?? null,
        }),
      );
    }
  }

  deleteBars(key: MarketSymbol, from: CalendarDate, to: CalendarDate): void {
    const series = this.barSeries.get(marketSymbolKey(key));
    if (series === undefined) return;
    for (const on of [...series.keys()]) if (from <= on && on <= to) series.delete(on);
  }

  rates(provider: string, quote: Currency): readonly CachedRate[] {
    return sortedValues(this.rateSeries.get(`${provider}:${quote}`));
  }

  upsertRates(
    provider: string,
    quote: Currency,
    rates: readonly CachedRate[],
    now: DateTime,
  ): void {
    const series = getOrCreate(this.rateSeries, `${provider}:${quote}`);
    for (const rate of rates) {
      series.set(rate.date, Object.freeze({ ...rate, fetchedAt: rate.fetchedAt ?? now }));
    }
  }
}

function getOrCreate<V>(map: Map<string, Map<CalendarDate, V>>, key: string): Map<CalendarDate, V> {
  let series = map.get(key);
  if (series === undefined) {
    series = new Map();
    map.set(key, series);
  }
  return series;
}

function sortedValues<V>(series: ReadonlyMap<CalendarDate, V> | undefined): readonly V[] {
  if (series === undefined) return [];
  return [...series.keys()].sort().map((on) => series.get(on) as V);
}

export interface CachedViewOptions {
  /** Provider preference for a tie (same day, same fetch time); default `defaultPriceSourceOrder`. */
  readonly order?: PriceSourceOrder;
  /** Provider of the PLN rates (default `nbp`). */
  readonly fxProvider?: string;
}

/**
 * A per-instrument `StoredMarketData` over the cache: an instrument's series is every day any of its
 * market symbols has, the newest-fetched bar winning a day (the store's "last write wins" per
 * (instrument, date)), ties broken by the instrument's source order.
 */
export interface CachedMarketData extends StoredMarketData {
  /** The instrument's merged series as price bars (`source` = provider), oldest first. */
  series(instrumentId: InstrumentId): readonly PriceBar[];
  /** Every PLN rate of `quote` from the FX provider, oldest first. */
  fxRates(quote: Currency): readonly FxRate[];
}

export function cachedMarketData(
  cache: PriceCache,
  instruments: Iterable<Instrument>,
  options: CachedViewOptions = {},
): CachedMarketData {
  const order = options.order ?? defaultPriceSourceOrder;
  const fxProvider = options.fxProvider ?? NBP_SOURCE_ID;
  const byId = new Map<InstrumentId, Instrument>();
  for (const instrument of instruments) byId.set(instrument.id, instrument);

  const series = (instrumentId: InstrumentId): readonly PriceBar[] => {
    const instrument = byId.get(instrumentId);
    if (instrument === undefined) return [];
    const providers = [
      ...order(instrument),
      ...PRICE_PROVIDERS.filter((p) => !order(instrument).includes(p)),
    ];
    const best = new Map<CalendarDate, PriceBar>();
    for (const key of marketSymbolsOf(instrument, providers)) {
      for (const bar of cache.bars(key)) {
        const current = best.get(bar.date);
        const newer =
          current === undefined ||
          (bar.fetchedAt !== null &&
            (current.fetchedAt === null || fetchedEarlier(current.fetchedAt, bar.fetchedAt)));
        if (!newer) continue;
        best.set(bar.date, priceBar({ ...bar, instrumentId, source: key.provider }));
      }
    }
    return sortedValues(best);
  };
  const fxRates = (quote: Currency): readonly FxRate[] =>
    cache.rates(fxProvider, quote).map((r) => fxRate({ ...r, quote, source: fxProvider }));
  const dates = (items: readonly { readonly date: CalendarDate }[]) => items.map((i) => i.date);

  return {
    series,
    fxRates,
    lastBarDate: (id) => dates(series(id)).at(-1) ?? null,
    firstBarDate: (id) => dates(series(id))[0] ?? null,
    hasBarsFetchedBefore: (id, datedBefore, fetchedBefore) =>
      series(id).some(
        (bar) =>
          bar.date < datedBefore &&
          (bar.fetchedAt === null || fetchedEarlier(bar.fetchedAt, fetchedBefore)),
      ),
    lastRateDate: (quote) => dates(fxRates(quote)).at(-1) ?? null,
    firstRateDate: (quote) => dates(fxRates(quote))[0] ?? null,
    hasRateOnOrBefore: (quote, on) => fxRates(quote).some((r) => r.date <= on),
  };
}

export interface CacheWriteStats {
  readonly bars: number;
  readonly rates: number; // float-ok: a count (Python int), not money
  /**
   * Bars whose source has no alias on their instrument (cannot be keyed). The composite only asks a
   * source the instrument has an alias for, so this stays 0 outside hand-made reports.
   */
  readonly unkeyed: number;
}

/**
 * Writes a report to the cache (`InMemoryMarketData.apply` keyed by market symbol): a split re-fetch
 * first deletes `replaceFrom..end` in every market symbol of the instrument; bars upsert under
 * (their source, the instrument's alias there); PLN rates upsert under (their source, quote).
 */
export function applyFetchReport(
  cache: PriceCache,
  report: FetchReport,
  instruments: Iterable<Instrument>,
  now: DateTime,
): CacheWriteStats {
  const byId = new Map<InstrumentId, Instrument>();
  for (const instrument of instruments) byId.set(instrument.id, instrument);
  let bars = 0;
  let rates = 0;
  let unkeyed = 0;
  for (const item of report.instruments) {
    const instrument = byId.get(item.instrumentId);
    if (instrument === undefined) {
      unkeyed += item.bars.length;
      continue;
    }
    if (item.replaceFrom !== null) {
      const end = item.end ?? report.asOf;
      for (const key of marketSymbolsOf(instrument)) cache.deleteBars(key, item.replaceFrom, end);
    }
    const bySource = new Map<string, PriceBar[]>();
    for (const bar of item.bars) {
      const list = bySource.get(bar.source) ?? [];
      list.push(bar);
      bySource.set(bar.source, list);
    }
    for (const [source, list] of bySource) {
      const symbol = aliasOf(instrument, source);
      if (symbol === null) {
        unkeyed += list.length;
        continue;
      }
      cache.upsertBars(marketSymbol(source, symbol), list.map(toCachedBar), now);
      bars += list.length;
    }
  }
  for (const item of report.fx) {
    const byProvider = new Map<string, CachedRate[]>();
    for (const rate of item.rates) {
      if (rate.base !== Currencies.PLN) continue;
      const list = byProvider.get(rate.source) ?? [];
      list.push({ date: rate.date, rate: rate.rate, fetchedAt: rate.fetchedAt });
      byProvider.set(rate.source, list);
    }
    for (const [provider, list] of byProvider) {
      cache.upsertRates(provider, item.currency, list, now);
      rates += list.length;
    }
  }
  return { bars, rates, unkeyed };
}

function toCachedBar(bar: PriceBar): CachedBar {
  return {
    date: bar.date,
    close: bar.close,
    open: bar.open,
    high: bar.high,
    low: bar.low,
    volume: bar.volume,
    currency: bar.currency,
    fetchedAt: bar.fetchedAt,
  };
}
