/** Market projection of the shared native public prices for one vault's instruments. */
import { type Instrument, market } from "@cashu/domain/investments";
import type { SqlPriceCache } from "@cashu/store/investments/local";

/** A snapshot identity is the cache version; the caller supplies one vault's instruments. */
export function cachedInstrumentMarketData(
  instruments: readonly Instrument[],
  prices: SqlPriceCache,
) {
  return { data: market.cachedMarketData(prices, instruments), version: prices.version() };
}
