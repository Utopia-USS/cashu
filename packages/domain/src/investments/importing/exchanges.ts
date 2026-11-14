/**
 * Exchange hints found in broker exports (`GPW`, `XWAR`, `.PL` suffixes) and the market data symbol
 * conventions derived from them (Yahoo / stooq ticker suffixes, default trading currency). Port of
 * `importing/exchanges.py`.
 *
 * Everything derived here is a guess: aliases built from it are stored with `guessed: true`.
 */

import { type Currency, toCurrency } from "../../money.js";
import { pyLower, pyStrip, pyUpper } from "../../text.js";

/** A market an exchange hint points to, plus how Yahoo and stooq spell its tickers. */
export interface ExchangeInfo {
  /** ISO 10383 MIC (`XWAR`), or null for a hint naming several markets (`US`) or crypto. */
  readonly mic: string | null;
  /** Yahoo ticker suffix (`.WA`; empty for US listings; `-USD` for crypto), null when unknown. */
  readonly yahooSuffix: string | null;
  /** stooq ticker suffix (empty for GPW, `.us`, `.de`, `.uk`), null when unknown. */
  readonly stooqSuffix: string | null;
  /** Usual trading currency of the market (a default only; rows carry the real currency). */
  readonly currency: Currency | null;
  /** True for the crypto pseudo-market (no MIC; Yahoo pairs such as `BTC-USD`). */
  readonly crypto: boolean;
  /** Yahoo pads numeric tickers of this market to this many digits (Hong Kong: `700` -> `0700.HK`). */
  readonly yahooDigits: number | null;
}

const ASCII_DIGITS = /^[0-9]+$/u;

/** `ExchangeInfo.yahoo_symbol`: the guessed Yahoo symbol of `symbol` here (`PKN` -> `PKN.WA`), or null. */
export function yahooSymbol(market: ExchangeInfo, symbol: string): string | null {
  if (market.yahooSuffix === null) return null;
  let ticker = pyUpper(pyStrip(symbol));
  if (market.yahooDigits !== null && ASCII_DIGITS.test(ticker)) {
    // str(int(ticker)).zfill(digits): leading zeros dropped, then padded
    ticker = BigInt(ticker).toString().padStart(market.yahooDigits, "0");
  }
  return `${ticker}${market.yahooSuffix}`;
}

/** `ExchangeInfo.stooq_symbol`: the guessed stooq symbol of `symbol` here (`PKN` -> `pkn`), or null. */
export function stooqSymbol(market: ExchangeInfo, symbol: string): string | null {
  if (market.stooqSuffix === null) return null;
  return `${pyLower(pyStrip(symbol))}${market.stooqSuffix}`;
}

function exchangeInfo(init: Partial<ExchangeInfo>): ExchangeInfo {
  return Object.freeze({
    mic: null,
    yahooSuffix: null,
    stooqSuffix: null,
    currency: null,
    crypto: false,
    yahooDigits: null,
    ...init,
  });
}

function market(
  mic: string,
  yahoo: string,
  currency: string,
  stooq: string | null = null,
  digits: number | null = null,
): ExchangeInfo {
  return exchangeInfo({
    mic,
    yahooSuffix: yahoo,
    stooqSuffix: stooq,
    currency: toCurrency(currency),
    yahooDigits: digits,
  });
}

/**
 * Markets by MIC, in Python's order (first match wins for Yahoo suffixes). Yahoo suffixes per Yahoo
 * Finance conventions; stooq suffixes only where stooq lists the market with a stable suffix.
 */
export const MARKETS: ReadonlyMap<string, ExchangeInfo> = new Map([
  ["XNAS", market("XNAS", "", "USD", ".us")],
  ["XNYS", market("XNYS", "", "USD", ".us")],
  ["ARCX", market("ARCX", "", "USD", ".us")],
  ["BATS", market("BATS", "", "USD", ".us")],
  ["XASE", market("XASE", "", "USD", ".us")],
  ["IEXG", market("IEXG", "", "USD", ".us")],
  ["XWAR", market("XWAR", ".WA", "PLN", "")],
  ["XNCO", market("XNCO", ".WA", "PLN", "")],
  ["XLON", market("XLON", ".L", "GBP", ".uk")],
  ["XASX", market("XASX", ".AX", "AUD")],
  ["XTSE", market("XTSE", ".TO", "CAD")],
  ["XTSX", market("XTSX", ".V", "CAD")],
  ["XHKG", market("XHKG", ".HK", "HKD", null, 4)],
  ["XPAR", market("XPAR", ".PA", "EUR")],
  ["XAMS", market("XAMS", ".AS", "EUR")],
  ["XBRU", market("XBRU", ".BR", "EUR")],
  ["XETR", market("XETR", ".DE", "EUR", ".de")],
  ["XMIL", market("XMIL", ".MI", "EUR")],
  ["XMAD", market("XMAD", ".MC", "EUR")],
  ["XSWX", market("XSWX", ".SW", "CHF")],
  ["XSTO", market("XSTO", ".ST", "SEK")],
  ["XCSE", market("XCSE", ".CO", "DKK")],
  ["XOSL", market("XOSL", ".OL", "NOK")],
  ["XHEL", market("XHEL", ".HE", "EUR")],
]);

/** A US listing without a known exchange (hint `US`). */
export const US_LISTING: ExchangeInfo = exchangeInfo({
  yahooSuffix: "",
  stooqSuffix: ".us",
  currency: toCurrency("USD"),
});

/** Crypto pseudo-market: Yahoo pairs against USD (`BTC` -> `BTC-USD`). */
export const CRYPTO: ExchangeInfo = exchangeInfo({
  yahooSuffix: "-USD",
  currency: toCurrency("USD"),
  crypto: true,
});

/**
 * Upper-case hint (MIC, exchange name, broker suffix without the dot) -> market. Ambiguous suffixes
 * are left out on purpose (`BE` is Belgium at some brokers but Berlin at Yahoo).
 */
const ALIASES: ReadonlyMap<string, string> = new Map([
  ["GPW", "XWAR"],
  ["WSE", "XWAR"],
  ["WAR", "XWAR"],
  ["WA", "XWAR"],
  ["PL", "XWAR"],
  ["NEWCONNECT", "XNCO"],
  ["NC", "XNCO"],
  ["XETRA", "XETR"],
  ["ETR", "XETR"],
  ["GER", "XETR"],
  ["DE", "XETR"],
  ["NASDAQ", "XNAS"],
  ["NYSE", "XNYS"],
  ["NYSEARCA", "ARCX"],
  ["ARCA", "ARCX"],
  ["CBOE", "BATS"],
  ["AMEX", "XASE"],
  ["NYSEAMERICAN", "XASE"],
  ["NYSEMKT", "XASE"],
  ["IEX", "IEXG"],
  ["LSE", "XLON"],
  ["UK", "XLON"],
  ["L", "XLON"],
  ["ASX", "XASX"],
  ["AX", "XASX"],
  ["TSX", "XTSE"],
  ["TO", "XTSE"],
  ["TSXV", "XTSX"],
  ["V", "XTSX"],
  ["HKEX", "XHKG"],
  ["HK", "XHKG"],
  ["AEB", "XAMS"],
  ["NL", "XAMS"],
  ["AS", "XAMS"],
  ["FR", "XPAR"],
  ["PA", "XPAR"],
  ["BR", "XBRU"],
  ["IT", "XMIL"],
  ["MI", "XMIL"],
  ["BME", "XMAD"],
  ["ES", "XMAD"],
  ["MC", "XMAD"],
  ["SIX", "XSWX"],
  ["CH", "XSWX"],
  ["SW", "XSWX"],
  ["ST", "XSTO"],
  ["SE", "XSTO"],
  ["CO", "XCSE"],
  ["DK", "XCSE"],
  ["OL", "XOSL"],
  ["NO", "XOSL"],
  ["HE", "XHEL"],
  ["FI", "XHEL"],
]);

const SPECIAL: ReadonlyMap<string, ExchangeInfo> = new Map([
  ["US", US_LISTING],
  ["CRYPTO", CRYPTO],
]);

/** The market of `mic` (case-insensitive), or null when unknown. */
export function exchangeForMic(mic: string | null): ExchangeInfo | null {
  if (mic === null) return null;
  return MARKETS.get(pyUpper(pyStrip(mic))) ?? null;
}

/** The market of `hint` (`GPW`, `xwar`, `.PL`, `crypto`), or null when unknown or blank. */
export function exchangeForHint(hint: string | null): ExchangeInfo | null {
  if (hint === null) return null;
  let key = pyUpper(pyStrip(hint));
  if (key.startsWith(".")) key = key.slice(1);
  if (key === "") return null;
  const direct = MARKETS.get(key) ?? SPECIAL.get(key);
  if (direct !== undefined) return direct;
  const mic = ALIASES.get(key);
  return mic === undefined ? null : (MARKETS.get(mic) ?? null);
}

/** Markets by upper-case Yahoo suffix; the first market wins (`.WA` is GPW, not NewConnect). */
const BY_YAHOO_SUFFIX: ReadonlyMap<string, ExchangeInfo> = (() => {
  const out = new Map<string, ExchangeInfo>();
  for (const info of MARKETS.values()) {
    if (!info.yahooSuffix) continue;
    const key = pyUpper(info.yahooSuffix);
    if (!out.has(key)) out.set(key, info);
  }
  return out;
})();

/**
 * The market whose Yahoo ticker suffix is `suffix` (`.DE` / `DE` -> XETR, `.WA` -> XWAR, `.L` ->
 * XLON), or null for a suffix no market in `MARKETS` uses (`.MU`, `.SG`, `.F`): never an invented MIC.
 */
export function exchangeForYahooSuffix(suffix: string | null): ExchangeInfo | null {
  if (suffix === null) return null;
  const key = pyUpper(pyStrip(suffix));
  if (key === "") return null;
  return BY_YAHOO_SUFFIX.get(key.startsWith(".") ? key : `.${key}`) ?? null;
}

/** A broker symbol split into the bare ticker and its market. */
export interface SplitSymbol {
  readonly symbol: string;
  readonly exchange: ExchangeInfo | null;
}

/**
 * Split a broker symbol into ticker and market.
 *
 * Understood forms (case-insensitive market part): `PKN.PL` / `VWCE.DE` (suffix after a dot) and
 * `NVDA:xnas` / `CDR:XWAR` (market after a colon). Without a hint `PKN.PL` becomes (`PKN`, Warsaw);
 * `PKN` with hint `GPW` becomes (`PKN`, Warsaw). A suffix that is not a known market (`BRK.B`) stays
 * part of the ticker, and so does a suffix naming another market than the hint.
 */
export function splitBrokerSymbol(symbol: string, exchangeHint: string | null): SplitSymbol {
  const trimmed = pyStrip(symbol);
  const fromHint = exchangeForHint(exchangeHint);
  for (const separator of [":", "."]) {
    const cut = trimmed.lastIndexOf(separator);
    if (!(cut > 0 && cut < trimmed.length - 1)) continue;
    const fromSuffix = exchangeForHint(trimmed.slice(cut + 1));
    if (
      fromSuffix !== null &&
      (fromHint === null || fromHint.mic === fromSuffix.mic || fromSuffix.mic === null)
    ) {
      return Object.freeze({
        symbol: pyStrip(trimmed.slice(0, cut)),
        exchange: fromHint ?? fromSuffix,
      });
    }
    // a colon form names its market explicitly; never fall back to a dot suffix
    if (separator === ":") break;
  }
  return Object.freeze({ symbol: trimmed, exchange: fromHint });
}

/**
 * Well-known crypto asset tickers (base symbols). A guess helper only: a broker alias or ISIN always
 * wins in resolution.
 */
export const CRYPTO_TICKERS: ReadonlySet<string> = new Set([
  "BTC",
  "ETH",
  "SOL",
  "ADA",
  "XRP",
  "DOGE",
  "DOT",
  "LTC",
  "BCH",
  "BNB",
  "AVAX",
  "MATIC",
  "POL",
  "LINK",
  "XLM",
  "ATOM",
  "TRX",
  "ETC",
  "XMR",
  "UNI",
  "SHIB",
  "TON",
  "NEAR",
  "ALGO",
  "USDT",
  "USDC",
  "DAI",
]);

const CRYPTO_QUOTES: readonly string[] = ["USDT", "USDC", "USD", "EUR", "PLN", "GBP", "CHF"];

/**
 * The crypto base ticker of `symbol` (`BTC`, `btc-usd`, `ETH/EUR`, `BTCUSD`), or null when it does not
 * look like a well-known crypto asset.
 */
export function cryptoBase(symbol: string | null): string | null {
  if (symbol === null) return null;
  const text = pyUpper(pyStrip(symbol));
  if (CRYPTO_TICKERS.has(text)) return text;
  for (const separator of ["-", "/"]) {
    const cut = text.indexOf(separator);
    if (cut === -1) continue;
    const base = text.slice(0, cut);
    const quote = text.slice(cut + 1);
    return CRYPTO_TICKERS.has(base) && CRYPTO_QUOTES.includes(quote) ? base : null;
  }
  for (const quote of CRYPTO_QUOTES) {
    if (text.length > quote.length && text.endsWith(quote)) {
      const base = text.slice(0, -quote.length);
      if (CRYPTO_TICKERS.has(base)) return base;
    }
  }
  return null;
}

/** True when `symbol` names a well-known crypto asset (see `cryptoBase`). */
export function isCryptoSymbol(symbol: string | null): boolean {
  return cryptoBase(symbol) !== null;
}
