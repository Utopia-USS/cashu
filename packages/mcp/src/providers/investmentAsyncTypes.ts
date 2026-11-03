/** Pure public I/O only. These capabilities never receive a tool/read/store context. */
import type { market } from "@cashu/domain/investments";
import type {
  InstrumentSearch,
  InstrumentSearchSources,
  WatchlistMarket,
} from "@cashu/store/investments/services";
import type { NativeAsyncIo } from "../runtime/io.js";

export interface InvestmentSearchAnswer {
  readonly hits: readonly market.SearchHit[];
  readonly status: "skipped" | "unavailable" | "ok";
}
export interface InvestmentSearchIo extends NativeAsyncIo {
  remoteHits(query: string, signal: AbortSignal): Promise<InvestmentSearchAnswer>;
}
export interface InvestmentWatchIo extends NativeAsyncIo {
  chart(
    symbol: Parameters<WatchlistMarket["chart"]>[0],
    start: Parameters<WatchlistMarket["chart"]>[1],
    end: Parameters<WatchlistMarket["chart"]>[2],
    signal: AbortSignal,
  ): ReturnType<WatchlistMarket["chart"]>;
  search(query: string, signal: AbortSignal): ReturnType<WatchlistMarket["search"]>;
  publishBars?: (...args: Parameters<market.PriceCache["upsertBars"]>) => void;
}
export interface InvestmentAsyncCapabilities {
  readonly vault: string;
  readonly search?: InvestmentSearchIo;
  readonly watch?: InvestmentWatchIo;
  readonly imports?: import("@cashu/store/investments/services").ImportPublication;
}
/** Existing real source algorithm and successful-public-result LRU, not a replayed response. */
export function investmentSearchIo(
  vault: string,
  service: InstrumentSearch,
  sources: () => InstrumentSearchSources,
  isCurrent: () => boolean,
): InvestmentSearchIo {
  return Object.freeze({
    vault,
    binding: Object.freeze({}),
    isCurrent,
    async remoteHits(query: string, signal: AbortSignal) {
      if (signal.aborted || !isCurrent()) throw new Error("inactive search capability");
      const result = await service.remoteHits(query, sources);
      if (signal.aborted || !isCurrent()) throw new Error("inactive search capability");
      return result;
    },
  });
}

/** Whitelisted public transport and bounded cache writer; no context/read/store escapes. */
export function investmentWatchIo(
  vault: string,
  port: WatchlistMarket,
  prices: Pick<market.PriceCache, "upsertBars"> | undefined,
  isCurrent: () => boolean,
): InvestmentWatchIo {
  const io: InvestmentWatchIo = {
    vault,
    binding: Object.freeze({}),
    isCurrent,
    chart: (symbol, start, end, signal) => {
      if (signal.aborted || !isCurrent()) throw new Error("inactive watch capability");
      return port.chart(symbol, start, end);
    },
    search: (query, signal) => {
      if (signal.aborted || !isCurrent()) throw new Error("inactive watch capability");
      return port.search(query);
    },
    ...(prices === undefined ? {} : { publishBars: prices.upsertBars.bind(prices) }),
  };
  return Object.freeze(io);
}
