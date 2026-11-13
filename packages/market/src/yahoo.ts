/**
 * `@cashu/market/yahoo`: the Yahoo chart / spark source, the standard composite (stooq + Yahoo) and the
 * HTTP client they run on, without the calendar feeds and the instrument search of the root entry (the
 * phone's Metro bundle does not tree-shake). Yahoo sees only the ticker symbols it is asked for.
 */
import { market } from "@cashu/domain/investments";

export { type FetchLike, MarketHttp } from "./http.js";
export { standardCompositeSource, type UtcClock, YahooPriceSource } from "./sources.js";

/** A source refused us (HTTP 401 / 403, or 429 after every retry): skipped until the next run. */
export const SourceBlockedException = market.SourceBlockedException;
export type SourceBlockedException = InstanceType<typeof market.SourceBlockedException>;
