/**
 * Instrument search over free public sources (F12), the pure part (`market/search.py`): Yahoo's symbol
 * search for tickers, names, ISINs and crypto, and OpenFIGI's ISIN mapping, which adds the other
 * listings of an ISIN (Yahoo shows one or two). The HTTP adapters are `@cashu/market`
 * `YahooSymbolSearch` / `OpenFigiIsinLookup`; parsing is here and unit-tested on recorded responses.
 *
 * A hit is a candidate listing, never stored as is: its `currencyHint` is the market's usual currency
 * (wrong for e.g. VWRA.L, which trades in USD on the LSE), so adding a pick verifies the symbol and
 * takes the currency from the Yahoo chart meta first. Stooq has no usable search.
 */

import { type Currency, tryCurrency } from "../../money.js";
import { isRecord, PyJsonError, parsePyJson } from "../../pyJson.js";
import { pySplit, pyStrip, pyUpper } from "../../text.js";
import { AssetClass } from "../domain/enums.js";
import {
  CRYPTO,
  type ExchangeInfo,
  exchangeForMic,
  exchangeForYahooSuffix,
  US_LISTING,
  yahooSymbol,
} from "../importing/exchanges.js";
import { bodySnippet, SourceBlockedException, SourceException } from "./sources.js";

/** Seconds one remote search request may take (typing must stay responsive). */
export const SEARCH_TIMEOUT = 5.0;
export type SearchSource = "yahoo" | "openfigi";
const ISIN = /^[A-Z]{2}[A-Z0-9]{9}[0-9]$/u;

/**
 * Short exchange labels of the known markets (stored instruments and OpenFIGI hits; Yahoo hits carry
 * Yahoo's own `exchDisp`).
 */
export const MIC_LABELS: ReadonlyMap<string, string> = new Map([
  ["XWAR", "GPW"],
  ["XNCO", "NewConnect"],
  ["XETR", "XETRA"],
  ["XNAS", "NASDAQ"],
  ["XNYS", "NYSE"],
  ["ARCX", "NYSE Arca"],
  ["BATS", "Cboe"],
  ["XASE", "NYSE American"],
  ["IEXG", "IEX"],
  ["XLON", "LSE"],
  ["XASX", "ASX"],
  ["XTSE", "TSX"],
  ["XTSX", "TSXV"],
  ["XHKG", "HKEX"],
  ["XPAR", "Paris"],
  ["XAMS", "Amsterdam"],
  ["XBRU", "Brussels"],
  ["XMIL", "Milan"],
  ["XMAD", "Madrid"],
  ["XSWX", "SIX"],
  ["XSTO", "Stockholm"],
  ["XCSE", "Copenhagen"],
  ["XOSL", "Oslo"],
  ["XHEL", "Helsinki"],
]);

/** One listing a remote source found. */
export interface SearchHit {
  readonly yahooSymbol: string | null;
  /** Display symbol: `VWCE`, `PKN`, `NVDA`, `BTC` (crypto: the base coin). */
  readonly ticker: string;
  readonly name: string;
  /** The source's type (Yahoo `quoteType`; OpenFIGI `securityType`). */
  readonly quoteType: string;
  readonly assetClass: AssetClass;
  /** Human exchange name (Yahoo `exchDisp`: XETRA, WSE, NASDAQ; OpenFIGI: `MIC_LABELS`). */
  readonly exchangeLabel: string | null;
  /**
   * ISO MIC when the listing maps to a known market (never invented: null for `.MU`, `.SG`, a US
   * listing without a known exchange or crypto).
   */
  readonly mic: string | null;
  /**
   * The market's usual currency (crypto: the pair's quote currency). A hint only: never stored
   * without the chart meta check.
   */
  readonly currencyHint: Currency | null;
  readonly isin: string | null;
  readonly source: SearchSource;
  /** The market the listing maps to (`US_LISTING` / `CRYPTO` without a MIC), null when unknown. */
  readonly market: ExchangeInfo | null;
}

/** `SearchHit.known_market`. */
export function isKnownMarket(hit: SearchHit): boolean {
  return hit.market !== null;
}

/** A symbol search over a remote source (`SymbolSearch`). */
export interface SymbolSearch {
  search(query: string): Promise<readonly SearchHit[]>;
}

/** The other listings of an ISIN (`IsinLookup`). */
export interface IsinLookup {
  lookup(isin: string): Promise<readonly SearchHit[]>;
}

export function isIsin(text: string): boolean {
  return ISIN.test(pyUpper(pyStrip(text)));
}

/** `_text`: a JSON string with whitespace runs collapsed, null for anything else or blank. */
function textOf(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return pySplit(value).join(" ") || null;
}

function payload(body: string, sourceId: string): unknown {
  try {
    return parsePyJson(body);
  } catch (error) {
    if (!(error instanceof PyJsonError)) throw error;
    throw new SourceException(sourceId, `unexpected response: ${bodySnippet(body)}`, {
      cause: error,
    });
  }
}

/** `_check_status`: 401 / 403 block the source, any other non-200 status fails the request. */
export function checkSearchStatus(sourceId: string, status: number, body: string): void {
  if (status === 401 || status === 403) {
    throw new SourceBlockedException(sourceId, `HTTP ${status}: ${bodySnippet(body)}`);
  }
  if (status !== 200) throw new SourceException(sourceId, `HTTP ${status}: ${bodySnippet(body)}`);
}

// --- Yahoo ---------------------------------------------------------------------------------------

/** Kept Yahoo quote types; FUTURE, OPTION, CURRENCY and anything else are dropped. */
export const YAHOO_TYPES: ReadonlyMap<string, AssetClass> = new Map([
  ["EQUITY", AssetClass.EQUITY],
  ["ETF", AssetClass.ETF],
  ["MUTUALFUND", AssetClass.FUND],
  ["CRYPTOCURRENCY", AssetClass.CRYPTO],
  ["INDEX", AssetClass.OTHER],
]);

/** Yahoo exchange codes of suffix-less US listings -> MIC (any other code: a US listing, MIC null). */
export const YAHOO_US_EXCHANGES: ReadonlyMap<string, string> = new Map([
  ["NMS", "XNAS"],
  ["NGM", "XNAS"],
  ["NCM", "XNAS"],
  ["NYQ", "XNYS"],
  ["PCX", "ARCX"],
  ["BTS", "BATS"],
  ["ASE", "XASE"],
]);

/** Python `str.partition(sep)`. */
function partition(text: string, sep: string): [string, string] {
  const cut = text.indexOf(sep);
  return cut === -1 ? [text, ""] : [text.slice(0, cut), text.slice(cut + sep.length)];
}

/**
 * The display ticker and the market of a Yahoo symbol (`VWCE.DE` -> VWCE on XETR, `BTC-USD` -> BTC on
 * the crypto pseudo-market, a suffix-less symbol -> a US listing, its MIC from Yahoo's `exchange` code
 * when known); the market is null for a suffix no known market uses.
 */
export function yahooMarket(
  symbol: string,
  quoteType: string,
  exchange: string | null = null,
): [string, ExchangeInfo | null] {
  if (quoteType === "CRYPTOCURRENCY") {
    const [base, quote] = partition(symbol, "-");
    return [base || symbol, quote ? CRYPTO : null];
  }
  if (quoteType === "INDEX" || symbol.startsWith("^")) return [symbol, null];
  const cut = symbol.lastIndexOf(".");
  if (cut > 0 && cut < symbol.length - 1) {
    return [symbol.slice(0, cut), exchangeForYahooSuffix(symbol.slice(cut))];
  }
  const mic = YAHOO_US_EXCHANGES.get(pyUpper(exchange ?? ""));
  return [symbol, mic ? exchangeForMic(mic) : US_LISTING];
}

/** The quote currency of a Yahoo crypto pair (`BTC-USD` -> USD), or null. */
export function cryptoCurrency(symbol: string): Currency | null {
  const [, quote] = partition(symbol, "-");
  return quote ? tryCurrency(pyUpper(quote)) : null;
}

/**
 * Hits of a Yahoo search response, in Yahoo's order (types filtered, duplicates dropped). With an
 * ISIN `query` every hit carries that ISIN (Yahoo matched it by ISIN).
 */
export function parseYahooSearch(body: string, query: string | null = null): SearchHit[] {
  const data = payload(body, "yahoo");
  const quotes = isRecord(data) ? data.quotes : undefined;
  if (!Array.isArray(quotes)) {
    throw new SourceException("yahoo", `unexpected search response: ${bodySnippet(body)}`);
  }
  const isin = query && isIsin(query) ? pyUpper(pyStrip(query)) : null;
  const hits: SearchHit[] = [];
  const seen = new Set<string>();
  for (const quote of quotes) {
    if (!isRecord(quote) || quote.isYahooFinance === false) continue;
    const symbol = textOf(quote.symbol);
    const quoteType = pyUpper(textOf(quote.quoteType) ?? "");
    const assetClass = YAHOO_TYPES.get(quoteType);
    if (symbol === null || assetClass === undefined || seen.has(pyUpper(symbol))) continue;
    seen.add(pyUpper(symbol));
    const exchange = textOf(quote.exchange);
    const [ticker, market] = yahooMarket(symbol, quoteType, exchange);
    const currency = market?.crypto ? cryptoCurrency(symbol) : (market?.currency ?? null);
    hits.push(
      Object.freeze({
        yahooSymbol: symbol,
        ticker,
        name: textOf(quote.longname) ?? textOf(quote.shortname) ?? symbol,
        quoteType,
        assetClass,
        exchangeLabel: textOf(quote.exchDisp) ?? exchange,
        mic: market === null ? null : market.mic,
        currencyHint: currency,
        isin,
        source: "yahoo",
        market,
      }),
    );
  }
  return hits;
}

/** The Yahoo search request (`YahooSymbolSearch.search`): path and query parameters. */
export function yahooSearchParams(query: string, count: number): Readonly<Record<string, string>> {
  return {
    q: query,
    quotesCount: String(count),
    newsCount: "0",
    listsCount: "0",
    enableFuzzyQuery: "false",
  };
}

// --- OpenFIGI ------------------------------------------------------------------------------------

/**
 * Bloomberg exchange codes -> MIC (null: a US listing without a MIC). `GR` (the German composite) is
 * read as XETRA: its ticker is the Xetra one (VWCE), which Yahoo spells `.DE`. Unmapped codes are
 * dropped.
 */
export const FIGI_EXCHANGES: ReadonlyMap<string, string | null> = new Map<string, string | null>([
  ...["US", "UN", "UW", "UQ", "UR", "UA", "UP"].map((code) => [code, null] as const),
  ["PW", "XWAR"],
  ["GY", "XETR"],
  ["GR", "XETR"],
  ["LN", "XLON"],
  ["NA", "XAMS"],
  ["IM", "XMIL"],
  ["FP", "XPAR"],
  ["BB", "XBRU"],
  ["SM", "XMAD"],
  ["SW", "XSWX"],
  ["SS", "XSTO"],
  ["DC", "XCSE"],
  ["NO", "XOSL"],
  ["FH", "XHEL"],
  ["CT", "XTSE"],
  ["AT", "XASX"],
  ["HK", "XHKG"],
]);

function figiAssetClass(row: Record<string, unknown>): AssetClass {
  const kinds = new Set([textOf(row.securityType), textOf(row.securityType2)]);
  if (kinds.has("ETP")) return AssetClass.ETF;
  if (kinds.has("Common Stock")) return AssetClass.EQUITY;
  return AssetClass.OTHER;
}

/**
 * Hits of an OpenFIGI mapping response for one ISIN job, deduplicated by Yahoo symbol, in the
 * response's order. A job answered with `warning` / `error` (no such ISIN) has no hits.
 */
export function parseOpenFigiMapping(body: string, isin: string): SearchHit[] {
  const data = payload(body, "openfigi");
  if (!Array.isArray(data)) {
    throw new SourceException("openfigi", `unexpected mapping response: ${bodySnippet(body)}`);
  }
  const wanted = pyUpper(pyStrip(isin));
  const hits: SearchHit[] = [];
  const seen = new Set<string>();
  for (const job of data) {
    const rows = isRecord(job) ? job.data : undefined;
    if (!Array.isArray(rows)) continue;
    for (const row of rows) {
      if (!isRecord(row)) continue;
      const code = textOf(row.exchCode);
      const ticker = textOf(row.ticker);
      if (code === null || !FIGI_EXCHANGES.has(code) || ticker === null) continue;
      const mic = FIGI_EXCHANGES.get(code) ?? null;
      const market = mic ? exchangeForMic(mic) : US_LISTING;
      if (market === null) continue;
      const dashed = ticker.replaceAll("/", "-");
      const symbol = yahooSymbol(market, dashed);
      if (symbol === null || seen.has(pyUpper(symbol))) continue;
      seen.add(pyUpper(symbol));
      hits.push(
        Object.freeze({
          yahooSymbol: symbol,
          ticker: pyUpper(dashed), // BRK/B -> BRK-B, as Yahoo
          name: textOf(row.name) ?? ticker,
          quoteType: textOf(row.securityType) ?? "",
          assetClass: figiAssetClass(row),
          exchangeLabel: MIC_LABELS.get(mic ?? "") ?? "US",
          mic,
          currencyHint: market.currency,
          isin: wanted,
          source: "openfigi",
          market,
        }),
      );
    }
  }
  return hits;
}

/** The OpenFIGI mapping request body for one ISIN (`OpenFigiIsinLookup.lookup`). */
export function openFigiJobs(isin: string): readonly unknown[] {
  return [{ idType: "ID_ISIN", idValue: pyUpper(pyStrip(isin)) }];
}
