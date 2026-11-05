/** Per-vault market projection of exact imported history and shared native public prices. */
import {
  type Currency,
  type FxRate,
  fxRate,
  type Instrument,
  type InstrumentId,
  market,
  type PriceBar,
  priceBar,
} from "@cashu/domain/investments";
import type { SqlPriceCache } from "@cashu/store/investments/local";

function byDate<T extends { readonly date: string }>(rows: readonly T[]): readonly T[] {
  return [...rows].sort((a, b) => a.date.localeCompare(b.date));
}

/** A snapshot identity is the cache version; the caller supplies one vault's instruments. */
export function cachedInstrumentMarketData(
  instruments: readonly Instrument[],
  vault: string,
  prices: SqlPriceCache,
) {
  const nativeOnly: market.PriceCache = {
    version: () => prices.version(),
    bars: (key) => prices.nativeBars(key),
    rates: (provider, quote) => prices.rates(provider, quote),
    upsertBars: (...args) => prices.upsertBars(...args),
    deleteBars: (...args) => prices.deleteBars(...args),
    upsertRates: (...args) => prices.upsertRates(...args),
  };
  const native = market.cachedMarketData(nativeOnly, instruments);
  const byId = new Map<InstrumentId, Instrument>(
    instruments.map((instrument) => [instrument.id, instrument]),
  );
  const series = (id: InstrumentId) => {
    const instrument = byId.get(id);
    if (instrument === undefined) return [];
    const sources = [
      ...market.defaultPriceSourceOrder(instrument),
      ...market.PRICE_PROVIDERS.filter(
        (source) => !market.defaultPriceSourceOrder(instrument).includes(source),
      ),
    ];
    const rank = (source: string) => {
      const index = sources.indexOf(source);
      return index < 0 ? sources.length : index;
    };
    const best = new Map<string, { bar: PriceBar; native: boolean; id: number }>();
    const newer = (candidate: PriceBar, prior: PriceBar) =>
      candidate.fetchedAt !== null &&
      (prior.fetchedAt === null || market.fetchedEarlier(prior.fetchedAt, candidate.fetchedAt));
    const sameFetch = (candidate: PriceBar, prior: PriceBar) =>
      (candidate.fetchedAt === null && prior.fetchedAt === null) ||
      (candidate.fetchedAt !== null &&
        prior.fetchedAt !== null &&
        !market.fetchedEarlier(candidate.fetchedAt, prior.fetchedAt) &&
        !market.fetchedEarlier(prior.fetchedAt, candidate.fetchedAt));
    for (const row of prices.effectiveBarsForInstrument(vault, id)) {
      const bar = priceBar({ ...row, instrumentId: id, source: row.source });
      const current = best.get(row.date);
      if (
        current === undefined ||
        newer(bar, current.bar) ||
        (sameFetch(bar, current.bar) &&
          (rank(row.source) < rank(current.bar.source) ||
            (rank(row.source) === rank(current.bar.source) && row.id > current.id)))
      )
        best.set(row.date, { bar, native: false, id: row.id });
    }
    for (const bar of native.series(id)) {
      const current = best.get(bar.date);
      if (
        current === undefined ||
        newer(bar, current.bar) ||
        (sameFetch(bar, current.bar) && rank(bar.source) <= rank(current.bar.source))
      )
        best.set(bar.date, { bar, native: true, id: 0 });
    }
    return byDate([...best.values()].map((entry) => entry.bar));
  };
  // NBP rates (native refreshes) win a day; an imported day of another provider fills a gap, as
  // Python valued with its one stored rate per day whatever the source.
  const fxRates = (quote: Currency): readonly FxRate[] => {
    const nbp = native.fxRates(quote);
    const days = new Set(nbp.map((rate) => rate.date));
    const imported: FxRate[] = [];
    for (const row of prices.ratesOfEveryProvider("PLN", quote)) {
      if (days.has(row.date)) continue;
      days.add(row.date);
      imported.push(fxRate({ ...row, quote, source: row.provider }));
    }
    return imported.length === 0 ? nbp : byDate([...nbp, ...imported]);
  };
  const data: market.CachedMarketData = {
    series,
    fxRates,
    lastBarDate: (id) => series(id).at(-1)?.date ?? null,
    firstBarDate: (id) => series(id)[0]?.date ?? null,
    hasBarsFetchedBefore: (id, before, fetchedBefore) =>
      series(id).some(
        (bar) =>
          bar.date < before &&
          (bar.fetchedAt === null || market.fetchedEarlier(bar.fetchedAt, fetchedBefore)),
      ),
    lastRateDate: (quote) => fxRates(quote).at(-1)?.date ?? null,
    firstRateDate: (quote) => fxRates(quote)[0]?.date ?? null,
    hasRateOnOrBefore: (quote, on) => fxRates(quote).some((rate) => rate.date <= on),
  };
  return { data, version: prices.version() };
}
