/** Inject a device cache or an explicitly versioned, already selected stored-market snapshot. */
import { type Instrument, market } from "@cashu/domain/investments";

export interface VersionedMarketData {
  readonly data: market.CachedMarketData;
  readonly version: string | number;
}
export type MarketInput =
  | { readonly prices: market.PriceCache; readonly marketData?: never }
  | { readonly marketData: VersionedMarketData; readonly prices?: never };

/** Source identity and version are independent: replacing either invalidates heavy computations. */
export function marketInputFingerprint(input: MarketInput): {
  readonly source: object;
  readonly version: string;
} {
  if (input.marketData !== undefined) {
    if (input.prices !== undefined) throw new Error("ambiguous market input");
    return {
      source: input.marketData.data,
      version: `snapshot:${JSON.stringify([typeof input.marketData.version, input.marketData.version])}`,
    };
  }
  if (input.prices === undefined) throw new Error("missing market input");
  return { source: input.prices, version: `cache:${input.prices.version()}` };
}

export function resolveMarketInput(
  input: MarketInput,
  instruments: Iterable<Instrument>,
  options: market.CachedViewOptions = {},
): market.CachedMarketData {
  marketInputFingerprint(input);
  return input.marketData === undefined
    ? market.cachedMarketData(input.prices, instruments, options)
    : input.marketData.data;
}
