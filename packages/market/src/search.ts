/**
 * Instrument search over free public sources (F12, `market/search.py`): Yahoo's symbol search and
 * OpenFIGI's ISIN mapping over `MarketHttp`. Parsing is the pure part in `@cashu/domain`
 * (`investments.market.parseYahooSearch` / `parseOpenFigiMapping`).
 */

import { market } from "@cashu/domain/investments";
import type { MarketHttp } from "./http.js";

export interface YahooSearchOptions {
  readonly host?: string;
  readonly userAgent?: string;
  /** How many quotes Yahoo returns (`quotesCount`). */
  readonly count?: number;
}

/**
 * `GET https://query1.finance.yahoo.com/v1/finance/search` (no key; the short user agent of
 * `YahooPriceSource`: a full browser string got HTTP 429 in live tries).
 */
export class YahooSymbolSearch implements market.SymbolSearch {
  readonly host: string;
  readonly userAgent: string;
  readonly count: number;
  private readonly http: MarketHttp;

  constructor(http: MarketHttp, options: YahooSearchOptions = {}) {
    this.http = http;
    this.host = options.host ?? "query1.finance.yahoo.com";
    this.userAgent = options.userAgent ?? market.YAHOO_USER_AGENT;
    this.count = options.count ?? 10;
  }

  async search(query: string): Promise<readonly market.SearchHit[]> {
    const response = await this.http.get(`https://${this.host}/v1/finance/search`, "yahoo", {
      params: market.yahooSearchParams(query, this.count),
      headers: { "User-Agent": this.userAgent, Accept: "application/json" },
    });
    market.checkSearchStatus("yahoo", response.status, response.text);
    return market.parseYahooSearch(response.text, query);
  }
}

/** `POST https://api.openfigi.com/v3/mapping` without a key (low rate limit; interactive ISIN queries). */
export class OpenFigiIsinLookup implements market.IsinLookup {
  readonly host: string;
  private readonly http: MarketHttp;

  constructor(http: MarketHttp, options: { readonly host?: string } = {}) {
    this.http = http;
    this.host = options.host ?? "api.openfigi.com";
  }

  async lookup(isin: string): Promise<readonly market.SearchHit[]> {
    const jobs = market.openFigiJobs(isin);
    const response = await this.http.post(`https://${this.host}/v3/mapping`, "openfigi", jobs, {
      "Content-Type": "application/json",
      Accept: "application/json",
    });
    market.checkSearchStatus("openfigi", response.status, response.text);
    return market.parseOpenFigiMapping(response.text, isin);
  }
}
