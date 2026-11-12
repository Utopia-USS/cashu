/**
 * `@cashu/market/nbp`: the NBP table A source and the HTTP client it runs on, without the calendar
 * feeds and the instrument search of the root entry (the phone's Metro bundle does not tree-shake).
 */
export { type FetchLike, MarketHttp } from "./http.js";
export { NbpFxSource } from "./sources.js";
