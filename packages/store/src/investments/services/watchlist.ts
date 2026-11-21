// Resolving what to add to the watchlist (Python `service/watchlist.py`: `resolve_pick`,
// `_create_pick`, `resolve_instrument` / `_resolve_text`, `_search_fallback`, `_clean_pick`,
// `WatchWarning`). The instrument is resolved by read-only lookups over the vault's view, then over the
// network through the caller's search / chart answers (pick verification against the Yahoo chart, the
// free-text search fallback), ALL before the one command batch (`addToWatchlist`) the caller runs.
// Failures are coded results (`reason` + `params`), never thrown texts; UI copy lives in catalogs.
import { addDays, tryCurrency } from "@cashu/domain";
import {
  AliasNamespace,
  ASSET_CLASSES,
  AssetClass,
  type CalendarDate,
  market,
} from "@cashu/domain/investments";
import {
  exchangeForHint,
  exchangeForMic,
  guessAssetClass,
  splitBrokerSymbol,
  stooqSymbol,
  yahooSymbol,
} from "@cashu/domain/investments/importing";
import { isPySpace, pyLen, pyLower, pyStrip, pyUpper } from "@cashu/domain/text";
import type { WATCHLIST_SOURCES } from "../../events/v1/research.js";
import { type InstrumentSpec, instrumentSpec } from "../commands/instruments.js";
import { cleanNote, cleanTags, MAX_ITEMS, type WatchAddResult } from "../commands/watchlist.js";
import { watchlist } from "../queries/alerts.js";
import {
  instrumentByAlias,
  instrumentByIsin,
  instrumentsBySymbol,
  loadInstruments,
  vaultInstrumentGids,
} from "../queries/instruments.js";
import type { Read } from "../queries/shared.js";
import { storedByYahoo } from "../queries/watchlist.js";

export const MAX_NAME_LENGTH = 120;
/** Days of daily bars fetched with a verified pick (price, 30-day sparkline and 52-week high at once). */
export const PICK_HISTORY_DAYS = 366;
/** Listings a `several_listings` failure names. */
export const MAX_CANDIDATES = 5;
/** Shortest text sent to the remote search (Python `instrument_search.REMOTE_MIN`). */
export const REMOTE_MIN = 2;

const ISIN = /^[A-Z]{2}[A-Z0-9]{9}[0-9]$/;
const SYMBOL = /^[A-Za-z0-9][A-Za-z0-9.:\-_^=]{0,39}$/;
/** Yahoo symbols and tickers of a pick: `VWCE.DE`, `BRK-B`, `M&M.NS`, `BTC-USD`, `^GSPC`, `BRK/B`. */
const PICK_SYMBOL = /^\^?[A-Za-z0-9][A-Za-z0-9.\-_^=&/]{0,39}$/;
/** Asset classes a pick is trusted with (`needsClassification` false); anything else is reviewed. */
const CLASSIFIED: ReadonlySet<string> = new Set([
  AssetClass.EQUITY,
  AssetClass.ETF,
  AssetClass.FUND,
  AssetClass.CRYPTO,
]);

/** The network of one add (leader or not: the search and the chart are public market data). */
export interface WatchlistMarket {
  /**
   * The Yahoo chart of `symbol` over `start..end` (daily bars); null (or a throw) when it cannot be
   * verified: network error, unknown symbol.
   */
  chart(symbol: string, start: CalendarDate, end: CalendarDate): Promise<market.ChartQuote | null>;
  /**
   * Remote listings of `text` (Python `instrument_search.remote_hits`: Yahoo, for an ISIN also
   * OpenFIGI); empty (or a throw) when the sources are unavailable.
   */
  search(text: string): Promise<readonly market.SearchHit[]>;
}

/**
 * A listing chosen from the search: the Yahoo symbol is required, the rest is a hint from the chosen
 * hit (the chart meta wins for the currency).
 */
export interface SearchPick {
  readonly yahooSymbol: string | null;
  readonly ticker?: string | null;
  readonly name?: string | null;
  readonly assetClass?: string | null;
  readonly mic?: string | null;
  readonly isin?: string | null;
}

/** Python `SearchPick.of_hit`. */
export function pickOfHit(hit: market.SearchHit): SearchPick {
  return {
    yahooSymbol: hit.yahooSymbol,
    ticker: hit.ticker,
    name: hit.name,
    assetClass: hit.assetClass,
    mic: hit.mic,
    isin: hit.isin,
  };
}

/** What to watch: a search pick, an instrument the vault references, or free text. */
export type WatchRequestTarget =
  | { readonly pick: SearchPick }
  | { readonly instrument: string }
  | {
      /** A ticker with its market (`VWCE.DE`, `PKN.WA`, `NVDA:XNAS`) or an ISIN. */
      readonly text: string | null;
      readonly name?: string | null;
      readonly currency?: string | null;
      readonly exchange?: string | null;
    };

export interface WatchAddRequest {
  readonly target: WatchRequestTarget;
  readonly note?: string | null;
  readonly tags?: readonly string[] | null;
  readonly source?: (typeof WATCHLIST_SOURCES)[number];
  readonly keepExistingNote?: boolean;
  /** Today (the chart window of a verified pick ends here). */
  readonly today: CalendarDate;
}

/** Python `WatchWarning`: a stable code (`watchlist.<name>` label) + its params. */
export interface WatchWarning {
  readonly code:
    | "watchlist.unverified_price_symbol"
    | "watchlist.no_price_symbol"
    | "watchlist.guessed_price_symbol";
  readonly params: Readonly<Record<string, string | null>>;
}

/** A failure: a stable code plus what its text needs (the symbol typed, the candidates, a limit). */
export interface WatchFailure {
  readonly ok: false;
  readonly reason: string;
  readonly params: Readonly<Record<string, unknown>>;
}

type Outcome<T> = { readonly ok: true; readonly value: T } | WatchFailure;

export type WatchAddOutcome =
  | {
      readonly ok: true;
      readonly value: WatchAddResult & { readonly warnings: readonly WatchWarning[] };
    }
  | WatchFailure;

const fail = (reason: string, params: Readonly<Record<string, unknown>> = {}): WatchFailure => ({
  ok: false,
  reason,
  params,
});
const done = <T>(value: T): Outcome<T> => ({ ok: true, value });

export type WatchQuote = Pick<
  market.ChartQuote,
  "symbol" | "currency" | "instrumentType" | "longName" | "bars"
>;

export type WatchResolution =
  | { readonly kind: "stored"; readonly instrument: string }
  | {
      readonly kind: "planned";
      readonly planned: InstrumentSpec;
      /** Set where Python inserts with `_insert_once` (a pick): the holder of this alias wins. */
      readonly yahooSymbol: string | null;
      /** The verifying chart answer (its bars go to the price cache when the instrument is created). */
      readonly quote: WatchQuote | null;
      /** Warnings of a created instrument (none when another instrument turned out to hold it). */
      readonly warnings: readonly WatchWarning[];
    };

const stored = (instrument: string): Outcome<WatchResolution> =>
  done({ kind: "stored", instrument });

function clean(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return pyStrip(value) || null;
}

/** Python `text[:n]` (code points). */
function head(text: string, n: number): string {
  return Array.from(text).slice(0, n).join("");
}

/** Python `str.rstrip()`. */
function rstrip(text: string): string {
  const cps = Array.from(text);
  let end = cps.length;
  while (end > 0 && isPySpace((cps[end - 1] as string).codePointAt(0) as number)) end--;
  return cps.slice(0, end).join("");
}

function unverified(symbol: string): WatchWarning {
  return { code: "watchlist.unverified_price_symbol", params: { symbol } };
}

interface CleanPick {
  readonly yahooSymbol: string;
  readonly ticker: string | null;
  readonly name: string | null;
  readonly assetClass: AssetClass | null;
  readonly mic: string | null;
  readonly isin: string | null;
}

/** Python `_clean_pick`. */
export function cleanPick(pick: SearchPick): Outcome<CleanPick> {
  const symbol = clean(pick.yahooSymbol);
  if (symbol === null || !PICK_SYMBOL.test(symbol)) return fail("pick_symbol_invalid");
  const ticker = clean(pick.ticker);
  if (ticker !== null && !PICK_SYMBOL.test(ticker)) return fail("pick_ticker_invalid");
  let name = clean(pick.name);
  if (name !== null && pyLen(name) > MAX_NAME_LENGTH) name = rstrip(head(name, MAX_NAME_LENGTH));
  const assetText = clean(pick.assetClass);
  let assetClass: AssetClass | null = null;
  if (assetText !== null) {
    const lower = pyLower(assetText);
    const known = ASSET_CLASSES.find((c) => c === lower);
    if (known === undefined) return fail("unknown_asset_class", { asset_class: assetText });
    assetClass = known;
  }
  let mic = clean(pick.mic);
  if (mic !== null) {
    if (exchangeForMic(mic) === null) return fail("unknown_market", { mic });
    mic = pyUpper(mic);
  }
  let isin = clean(pick.isin);
  if (isin !== null) {
    isin = pyUpper(isin);
    if (!ISIN.test(isin)) return fail("pick_isin_invalid");
  }
  return done({
    yahooSymbol: pyUpper(symbol),
    ticker: ticker === null ? null : pyUpper(ticker),
    name,
    assetClass,
    mic,
    isin,
  });
}

/**
 * Python `_verify`: the Yahoo chart of `symbol` (PICK_HISTORY_DAYS of daily bars up to `today`), null
 * when it cannot be verified (a failing source, an unknown symbol, no bars): never a failed add.
 */
export interface WatchResolutionAnswers {
  readonly unavailable?: boolean;
  readonly search?: { readonly query: string; readonly hits: readonly market.SearchHit[] };
  readonly chart?: { readonly symbol: string; readonly quote: WatchQuote | null };
}
export type WatchResolutionOperation =
  | { readonly kind: "search"; readonly query: string }
  | {
      readonly kind: "chart";
      readonly symbol: string;
      readonly start: CalendarDate;
      readonly end: CalendarDate;
    };
export interface WatchResolutionIo extends WatchFailure {
  readonly reason: "remote_required";
  readonly operation: WatchResolutionOperation;
}
export function needsWatchIo(result: WatchFailure): result is WatchResolutionIo {
  return result.reason === "remote_required" && "operation" in result;
}
const need = (operation: WatchResolutionOperation): WatchResolutionIo => ({
  ok: false,
  reason: "remote_required",
  params: {},
  operation,
});
function verify(
  answers: WatchResolutionAnswers,
  symbol: string,
  today: CalendarDate,
): Outcome<WatchQuote | null> {
  if (answers.chart?.symbol === symbol) {
    const quote = answers.chart.quote;
    return done(quote !== null && quote.bars.length > 0 ? quote : null);
  }
  if (answers.unavailable) return done(null);
  return need({ kind: "chart", symbol, start: addDays(today, -PICK_HISTORY_DAYS), end: today });
}

/**
 * Python `_create_pick`: a new instrument for a cleaned pick with the chart `quote` when it verified
 * (its currency, a confirmed Yahoo alias, its bars); unverified, the pick data with a guessed Yahoo
 * alias, the market currency and a warning. No network here.
 */
function createPick(
  read: Read,
  pick: CleanPick,
  quote: WatchQuote | null,
): Outcome<WatchResolution> {
  const metaType = quote?.instrumentType ? pyUpper(quote.instrumentType) : "";
  const crypto = pick.assetClass === AssetClass.CRYPTO || metaType === "CRYPTOCURRENCY";
  let [ticker, info] = market.yahooMarket(pick.yahooSymbol, crypto ? "CRYPTOCURRENCY" : metaType);
  if (pick.mic !== null) info = exchangeForMic(pick.mic);
  ticker = pick.ticker || ticker;
  let currency: string | null;
  if (quote !== null) currency = quote.currency;
  else if (info?.crypto) currency = market.cryptoCurrency(pick.yahooSymbol);
  else currency = info?.currency ?? null;
  if (currency === null) return fail("unknown_currency", { symbol: pick.yahooSymbol });
  const name = pick.name || quote?.longName || ticker;
  const assetClass =
    pick.assetClass ?? market.YAHOO_TYPES.get(metaType) ?? guessAssetClass(name, ticker, info);
  // one ISIN, many listings (an ETF on two exchanges): the first stored keeps it
  const isin =
    pick.isin !== null && instrumentByIsin(read, pick.isin) === undefined ? pick.isin : null;
  const aliases: { namespace: string; value: string; guessed: boolean }[] = [
    { namespace: AliasNamespace.YAHOO, value: pick.yahooSymbol, guessed: quote === null },
  ];
  const stooq = info === null ? null : stooqSymbol(info, ticker);
  if (stooq) aliases.push({ namespace: AliasNamespace.STOOQ, value: stooq, guessed: true });
  if (isin !== null) aliases.push({ namespace: AliasNamespace.ISIN, value: isin, guessed: false });
  return done({
    kind: "planned",
    planned: instrumentSpec.parse({
      name: head(name, MAX_NAME_LENGTH),
      currency,
      assetClass,
      symbol: ticker,
      isin,
      mic: info?.mic ?? null,
      needsClassification: !CLASSIFIED.has(assetClass),
      aliases,
    }),
    yahooSymbol: pick.yahooSymbol,
    quote,
    warnings: quote === null ? [unverified(pick.yahooSymbol)] : [],
  });
}

/**
 * Python `resolve_pick`: a stored instrument with that Yahoo alias (no network; a guessed alias stays
 * guessed), else a new one verified against the chart first.
 */
function resolvePick(
  read: Read,
  answers: WatchResolutionAnswers,
  pick: SearchPick,
  today: CalendarDate,
): Outcome<WatchResolution> {
  const cleaned = cleanPick(pick);
  if (!cleaned.ok) return cleaned;
  const found = storedByYahoo(read, [cleaned.value.yahooSymbol]).get(cleaned.value.yahooSymbol);
  if (found !== undefined) return stored(found);
  const verified = verify(answers, cleaned.value.yahooSymbol, today);
  if (!verified.ok) return verified;
  return createPick(read, cleaned.value, verified.value);
}

/**
 * Python `_search_fallback`: where the deterministic paths cannot tell the market (a bare ticker) or
 * the currency (an unknown ISIN), one listing on a known market becomes a pick (an exact Yahoo symbol
 * first); several fail naming them (`several_listings`); none (or no search) is null.
 */
function searchFallback(
  read: Read,
  answers: WatchResolutionAnswers,
  text: string,
  isin: boolean,
  today: CalendarDate,
): Outcome<WatchResolution | null> {
  let hits: readonly market.SearchHit[] = [];
  if (pyLen(text) >= REMOTE_MIN) {
    if (answers.search?.query === text) hits = answers.search.hits;
    else if (!answers.unavailable) return need({ kind: "search", query: text });
  }
  const known = hits.filter((h) => market.isKnownMarket(h) && h.yahooSymbol);
  const wanted = pyUpper(text);
  let matching: market.SearchHit[];
  if (isin) {
    // Yahoo's listing(s) of the ISIN first; OpenFIGI's many listings only without one
    const yahoo = known.filter((h) => h.source === "yahoo");
    matching = yahoo.length > 0 ? yahoo : known;
  } else {
    const exact = known.filter((h) => pyUpper(h.yahooSymbol ?? "") === wanted);
    matching = exact.length > 0 ? exact : known.filter((h) => pyUpper(h.ticker) === wanted);
  }
  const [only] = matching;
  if (matching.length === 1 && only !== undefined) {
    return resolvePick(read, answers, pickOfHit(only), today);
  }
  if (matching.length > 1) {
    return fail("several_listings", {
      text,
      candidates: matching.slice(0, MAX_CANDIDATES).map((h) => ({
        symbol: h.yahooSymbol,
        exchange: h.exchangeLabel || h.mic || null,
      })),
      more: Math.max(0, matching.length - MAX_CANDIDATES),
    });
  }
  return done(null);
}

type TextTarget = Extract<WatchRequestTarget, { readonly text: string | null }>;

/**
 * Python `_resolve_text`: a stored instrument (ISIN, Yahoo alias, symbol + market, or a symbol among
 * the vault's instruments), else a new one with guessed Yahoo / stooq aliases from the market suffix
 * or `exchange` (a listing with its market is verified like a pick); its currency comes from the
 * market or `currency`. Only where none of that works the remote search is asked.
 */
function resolveText(
  read: Read,
  answers: WatchResolutionAnswers,
  target: TextTarget,
  today: CalendarDate,
): Outcome<WatchResolution> {
  const text = clean(target.text);
  if (text === null) return fail("symbol_required");
  if (!SYMBOL.test(text)) return fail("symbol_invalid");
  const displayName = clean(target.name);
  if (displayName !== null && pyLen(displayName) > MAX_NAME_LENGTH) {
    return fail("name_too_long", { max: MAX_NAME_LENGTH });
  }
  const currencyText = clean(target.currency);
  const wanted = currencyText === null ? null : tryCurrency(currencyText);
  if (currencyText !== null && wanted === null) return fail("currency_invalid");

  const upper = pyUpper(text);
  if (ISIN.test(upper)) {
    const found = instrumentByIsin(read, upper);
    if (found !== undefined) return stored(found.id);
    if (wanted === null) {
      const searched = searchFallback(read, answers, upper, true, today);
      if (!searched.ok) return searched;
      if (searched.value !== null) return done(searched.value);
      return fail("unknown_isin", { isin: upper });
    }
    return done({
      kind: "planned",
      planned: instrumentSpec.parse({
        name: displayName || upper,
        currency: wanted,
        assetClass: guessAssetClass(displayName, null, null),
        isin: upper,
        needsClassification: true,
        aliases: [{ namespace: AliasNamespace.ISIN, value: upper }],
      }),
      yahooSymbol: null,
      quote: null,
      warnings: [{ code: "watchlist.no_price_symbol", params: { isin: upper } }],
    });
  }

  const exchange = target.exchange ?? null;
  const exchangeText = clean(exchange);
  if (exchangeText !== null && exchangeForHint(exchange) === null) {
    return fail("unknown_exchange", { exchange: exchangeText });
  }
  const split = splitBrokerSymbol(text, exchange);
  const info = split.exchange;
  const ticker = pyUpper(pyStrip(split.symbol));
  const yahoo = info === null ? upper : yahooSymbol(info, ticker);
  for (const value of new Set([upper, text, ...(yahoo ? [yahoo] : [])])) {
    const found = instrumentByAlias(read, AliasNamespace.YAHOO, value);
    if (found !== undefined) return stored(found.id);
  }
  if (info?.mic) {
    const same = instrumentsBySymbol(read, ticker, info.mic);
    const [one] = same;
    if (same.length === 1 && one !== undefined) return stored(one.id);
  }
  const mine = [...loadInstruments(read, vaultInstrumentGids(read)).values()].filter(
    (i) =>
      pyUpper(i.symbol ?? "") === ticker &&
      (info === null || info.mic === null || i.mic === info.mic),
  );
  const [own] = mine;
  if (mine.length === 1 && own !== undefined) return stored(own.id);

  const currency = wanted ?? info?.currency ?? null;
  if (currency === null) {
    if (exchangeText === null && !text.includes(":") && !text.includes(".")) {
      const searched = searchFallback(read, answers, text, false, today);
      if (!searched.ok) return searched;
      if (searched.value !== null) return done(searched.value);
    }
    return fail("unknown_market", { text, ticker });
  }
  let verifyFailed = false;
  if (yahoo && info !== null && wanted === null) {
    // a new listing with its market: verified like a pick (the real quote currency, a confirmed
    // alias and bars)
    const verified = verify(answers, yahoo, today);
    if (!verified.ok) return verified;
    const quote = verified.value;
    if (quote !== null) {
      const pick = cleanPick({ yahooSymbol: yahoo, ticker, name: displayName, mic: info.mic });
      if (!pick.ok) return pick;
      return createPick(read, pick.value, quote);
    }
    verifyFailed = true;
  }
  const aliases: { namespace: string; value: string; guessed: boolean }[] = [];
  if (yahoo) aliases.push({ namespace: AliasNamespace.YAHOO, value: yahoo, guessed: true });
  const stooq = info === null ? null : stooqSymbol(info, ticker);
  if (stooq) aliases.push({ namespace: AliasNamespace.STOOQ, value: stooq, guessed: true });
  const warnings: WatchWarning[] = [
    {
      code: "watchlist.guessed_price_symbol",
      params: { symbol: ticker, currency, price_symbol: yahoo },
    },
  ];
  if (verifyFailed && yahoo) warnings.push(unverified(yahoo));
  return done({
    kind: "planned",
    planned: instrumentSpec.parse({
      name: displayName || ticker,
      currency,
      assetClass: guessAssetClass(displayName || ticker, ticker, info),
      symbol: ticker,
      mic: info?.mic ?? null,
      needsClassification: true,
      aliases,
    }),
    yahooSymbol: null,
    quote: null,
    warnings,
  });
}

/** A synchronous decision over current local facts and previously owned public answers. */
export function prepareWatchResolution(
  read: Read,
  request: WatchAddRequest,
  answers: WatchResolutionAnswers = {},
): Outcome<WatchResolution> {
  if (request.note != null) {
    const checked = cleanNote(request.note);
    if (!checked.ok) return fail(checked.reason);
  }
  if (request.tags != null) {
    const checked = cleanTags(request.tags);
    if (!checked.ok) return fail(checked.reason);
  }
  if (watchlist(read).length >= MAX_ITEMS) return fail("watchlist_full", { max: MAX_ITEMS });
  const target = request.target;
  if ("pick" in target) return resolvePick(read, answers, target.pick, request.today);
  if ("instrument" in target) return stored(target.instrument);
  return resolveText(read, answers, target, request.today);
}
