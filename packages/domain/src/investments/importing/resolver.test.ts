import { expect, it } from "vitest";
import {
  AssetClass,
  aliasOf,
  asInstrumentId,
  Currencies,
  type Currency,
  type Instrument,
  InvariantError,
  instrumentAlias,
  TxnType,
} from "../domain/index.js";
import {
  CurrencyEvidence,
  hintFromTxn,
  hintIsEmpty,
  InMemoryInstrumentLookup,
  type InstrumentHint,
  InstrumentMatch,
  InstrumentResolver,
  instrumentHint,
  isNewInstrument,
} from "./resolver.js";
import { counterInstrumentIds, instrumentOf, parsedTxnOf } from "./testing/support.js";

// Translation of tests/investments/importing/test_imp_resolver.py (instrument resolution: port of
// instrument_resolver_test, incl. R10, plus crypto and find). Synthetic data only.
const { PLN, USD, EUR, GBP } = Currencies;
const id = asInstrumentId;

function hint(
  options: {
    readonly symbol?: string | null;
    readonly isin?: string | null;
    readonly name?: string | null;
    readonly exchange?: string | null;
    readonly currency?: Currency;
    readonly evidence?: CurrencyEvidence;
  } = {},
): InstrumentHint {
  return instrumentHint({
    symbol: options.symbol ?? null,
    isin: options.isin ?? null,
    name: options.name ?? null,
    exchangeHint: options.exchange ?? null,
    currency: options.currency ?? PLN,
    evidence: options.evidence ?? CurrencyEvidence.WEAK,
  });
}

function resolverOver(instruments: Instrument[] = [], brokerId = "generic_csv") {
  return new InstrumentResolver(
    new InMemoryInstrumentLookup(instruments),
    brokerId,
    counterInstrumentIds("new"),
  );
}

/** The current state of a resolved instrument (Python returns it directly; null is a failure here). */
function stateOf(resolver: InstrumentResolver, instrumentId: string): Instrument {
  const found = resolver.instrument(id(instrumentId));
  if (found === null) throw new Error(`instrument ${instrumentId} was never resolved`);
  return found;
}

// test_isin_beats_broker_alias
it("ISIN beats broker alias", () => {
  const byIsin = instrumentOf("i1", { name: "By ISIN", symbol: "AAA", isin: "PLAAA0000011" });
  const byAlias = instrumentOf("i2", {
    name: "By alias",
    symbol: "BBB",
    aliases: [instrumentAlias("generic_csv", "AAA.PL")],
  });
  const resolver = resolverOver([byIsin, byAlias]);
  const resolved = resolver.resolve(hint({ symbol: "AAA.PL", isin: "plaaa0000011" }));
  expect(resolved.match).toBe(InstrumentMatch.ISIN);
  expect(resolved.instrumentId).toBe("i1");
  expect(resolved.notes).toHaveLength(1);
  expect(resolved.notes[0]).toContain("Broker symbol AAA.PL belongs to By alias");
  // the broker symbol is owned by another instrument
  expect(resolver.newAliases).toEqual(new Map());
});

// test_broker_alias_beats_symbol_and_exchange
it("broker alias beats symbol and exchange", () => {
  const resolver = resolverOver([
    instrumentOf("alias", {
      name: "By alias",
      symbol: "XYZ",
      aliases: [instrumentAlias("generic_csv", "PKN")],
    }),
    instrumentOf("symbol", { name: "By symbol" }),
  ]);
  const resolved = resolver.resolve(hint({ symbol: "PKN", exchange: "GPW" }));
  expect([resolved.match, resolved.instrumentId]).toEqual([InstrumentMatch.BROKER_ALIAS, "alias"]);
});

// test_symbol_and_exchange_then_guessed_market_aliases
it("symbol and exchange, then guessed market aliases", () => {
  const orlen = instrumentOf("orlen");
  const vanguard = instrumentOf("vwce", {
    name: "Vanguard",
    symbol: "VWRL",
    mic: null,
    aliases: [instrumentAlias("yahoo", "VWCE.DE")],
  });
  const resolver = resolverOver([orlen, vanguard]);
  const first = resolver.resolve(hint({ symbol: "PKN.PL" }));
  expect([first.match, first.instrumentId]).toEqual([InstrumentMatch.SYMBOL_EXCHANGE, "orlen"]);
  const second = resolver.resolve(hint({ symbol: "VWCE", exchange: "XETRA" }));
  expect([second.match, second.instrumentId]).toEqual([InstrumentMatch.SYMBOL_EXCHANGE, "vwce"]);
  expect(resolver.newAliases.get(id("orlen"))).toEqual([instrumentAlias("generic_csv", "PKN.PL")]);
});

// test_nothing_known_plans_a_new_instrument_with_guessed_aliases
it("nothing known plans a new instrument with guessed aliases", () => {
  const resolver = resolverOver();
  const resolved = resolver.resolve(
    hint({ symbol: "PKN", isin: "PLPKN0000018", name: "Orlen SA", exchange: "GPW" }),
  );
  expect(resolved.match).toBe(InstrumentMatch.CREATED);
  expect(isNewInstrument(resolved)).toBe(true);
  const planned = stateOf(resolver, resolved.instrumentId);
  expect(resolver.isPlanned(planned.id)).toBe(true);
  expect(planned.id).toBe("new-1");
  expect(planned.needsClassification).toBe(true);
  expect([planned.name, planned.symbol, planned.isin, planned.mic]).toEqual([
    "Orlen SA",
    "PKN",
    "PLPKN0000018",
    "XWAR",
  ]);
  expect(planned.currency).toBe(PLN);
  expect(planned.assetClass).toBe(AssetClass.EQUITY);
  expect(planned.aliases).toEqual([
    instrumentAlias("generic_csv", "PKN"),
    instrumentAlias("stooq", "pkn", true),
    instrumentAlias("yahoo", "PKN.WA", true),
  ]);
  expect(resolver.newInstruments).toEqual([planned]);
});

// test_asset_class_guess_etf_ucits_and_unknown_market
it("asset class guess: ETF / UCITS and unknown market", () => {
  const resolver = resolverOver();
  const etf = resolver.resolve(
    hint({ name: "iShares Core MSCI World UCITS ETF USD (Acc)", isin: "IE00TEST0001" }),
  );
  const plannedEtf = stateOf(resolver, etf.instrumentId);
  expect(plannedEtf.assetClass).toBe(AssetClass.ETF);
  expect(plannedEtf.symbol).toBeNull();
  const unknown = resolver.resolve(hint({ symbol: "ABC" }));
  const planned = stateOf(resolver, unknown.instrumentId);
  expect(planned.assetClass).toBe(AssetClass.OTHER);
  expect(planned.mic).toBeNull();
  // no market, no guesses
  expect(planned.aliases).toEqual([instrumentAlias("generic_csv", "ABC")]);
});

// test_crypto_symbols_are_guessed_as_crypto_with_a_yahoo_pair
it("crypto symbols are guessed as crypto with a Yahoo pair", () => {
  const resolver = resolverOver();
  const btc = stateOf(
    resolver,
    resolver.resolve(hint({ symbol: "BTC", currency: USD })).instrumentId,
  );
  expect(btc.assetClass).toBe(AssetClass.CRYPTO);
  expect(btc.symbol).toBe("BTC");
  expect(btc.mic).toBeNull();
  expect(aliasOf(btc, "yahoo")).toBe("BTC-USD");
  const pair = stateOf(
    resolver,
    resolver.resolve(hint({ symbol: "ETH-USD", exchange: "crypto" })).instrumentId,
  );
  expect(pair.assetClass).toBe(AssetClass.CRYPTO);
  expect(pair.symbol).toBe("ETH");
  const onMarket = stateOf(
    resolver,
    resolver.resolve(hint({ symbol: "LINK", exchange: "XNYS" })).instrumentId,
  );
  // a real market wins over the crypto guess
  expect(onMarket.assetClass).toBe(AssetClass.EQUITY);
  const etf = stateOf(
    resolver,
    resolver.resolve(hint({ symbol: "SOL", name: "Solana UCITS ETF" })).instrumentId,
  );
  expect(etf.assetClass).toBe(AssetClass.ETF);
});

// test_crypto_resolves_to_an_existing_instrument_by_its_yahoo_pair
it("crypto resolves to an existing instrument by its Yahoo pair", () => {
  const stored = instrumentOf("btc", {
    name: "Bitcoin",
    symbol: "BTC",
    mic: null,
    currency: USD,
    assetClass: AssetClass.CRYPTO,
    aliases: [instrumentAlias("yahoo", "BTC-USD")],
  });
  const resolver = resolverOver([stored]);
  const resolved = resolver.resolve(hint({ symbol: "btcusd", currency: USD }));
  expect([resolved.match, resolved.instrumentId]).toEqual([InstrumentMatch.SYMBOL_EXCHANGE, "btc"]);
});

// test_us_suffix_guesses_yahoo_and_stooq_without_a_mic
it("US suffix guesses Yahoo and stooq without a MIC", () => {
  const resolver = resolverOver();
  const planned = stateOf(
    resolver,
    resolver.resolve(hint({ symbol: "AAPL.US", currency: USD })).instrumentId,
  );
  expect(planned.symbol).toBe("AAPL");
  expect(planned.mic).toBeNull();
  expect(aliasOf(planned, "yahoo")).toBe("AAPL");
  expect(aliasOf(planned, "stooq")).toBe("aapl.us");
  expect(aliasOf(planned, "generic_csv")).toBe("AAPL.US");
});

// test_one_new_instrument_per_import_later_rows_add_its_isin
it("one new instrument per import; later rows add its ISIN", () => {
  const resolver = resolverOver();
  const first = resolver.resolve(hint({ symbol: "ZGJ", exchange: "GPW", name: "ZGJ" }));
  const again = resolver.resolve(hint({ symbol: "ZGJ", exchange: "GPW", name: "ZGJ" }));
  const withIsin = resolver.resolve(hint({ symbol: "ZGJ", isin: "PLZGJ0000010", exchange: "GPW" }));
  const byIsinOnly = resolver.resolve(hint({ isin: "PLZGJ0000010" }));
  expect(again).toEqual(first);
  expect([withIsin.instrumentId, withIsin.match]).toEqual([
    first.instrumentId,
    InstrumentMatch.BROKER_ALIAS,
  ]);
  expect([byIsinOnly.instrumentId, byIsinOnly.match]).toEqual([
    first.instrumentId,
    InstrumentMatch.ISIN,
  ]);
  expect(resolver.newInstruments).toHaveLength(1);
  expect(resolver.newInstruments[0]?.isin).toBe("PLZGJ0000010");
});

// test_planned_instrument_takes_the_currency_of_priced_trades_whatever_the_order_r10
it("planned instrument takes the currency of priced trades whatever the order (R10)", () => {
  const resolver = resolverOver();
  const row = (currency: Currency, evidence: CurrencyEvidence, name = "Apple") =>
    instrumentHint({ symbol: "AAPL.US", name, currency, evidence });
  const currencyNow = () => resolver.newInstruments[0]?.currency;

  // Newest-first export: withholding tax and dividend (booked in PLN) before the USD buy.
  const tax = resolver.resolve(row(PLN, CurrencyEvidence.CASH_FLOW));
  expect(stateOf(resolver, tax.instrumentId).currency).toBe(PLN);
  const buy = resolver.resolve(row(USD, CurrencyEvidence.TRADE));
  expect(buy.instrumentId).toBe(tax.instrumentId);
  expect(currencyNow()).toBe(USD);
  // aliases are kept
  expect(aliasOf(stateOf(resolver, tax.instrumentId), "yahoo")).toBe("AAPL");
  // A later cash row (or a weaker position line) in PLN does not undo it.
  resolver.resolve(row(PLN, CurrencyEvidence.WEAK));
  resolver.resolve(row(PLN, CurrencyEvidence.CASH_FLOW, "Apple Inc"));
  expect(currencyNow()).toBe(USD);
  // Trade rows that disagree keep the first trade currency and say so once.
  const eur = resolver.resolve(row(EUR, CurrencyEvidence.TRADE));
  expect(currencyNow()).toBe(USD);
  expect(eur.notes).toEqual([
    "Trade rows of Apple use several currencies (USD, EUR); created it in USD",
  ]);
  const again = resolver.resolve(row(GBP, CurrencyEvidence.TRADE));
  expect(again.notes).toEqual([]); // noted once
});

// test_hint_from_txn_evidence
it("hint from txn evidence", () => {
  const evidence = (type: TxnType, price?: string) =>
    hintFromTxn(parsedTxnOf(type, price === undefined ? {} : { price })).evidence;
  expect(evidence(TxnType.BUY, "10")).toBe(CurrencyEvidence.TRADE);
  expect(evidence(TxnType.TRANSFER_IN, "10")).toBe(CurrencyEvidence.TRADE);
  expect(evidence(TxnType.TRANSFER_IN)).toBe(CurrencyEvidence.WEAK);
  expect(evidence(TxnType.BUY, "0")).toBe(CurrencyEvidence.WEAK);
  expect(evidence(TxnType.SPLIT)).toBe(CurrencyEvidence.WEAK);
  expect(evidence(TxnType.DIVIDEND)).toBe(CurrencyEvidence.CASH_FLOW);
  expect(evidence(TxnType.TAX)).toBe(CurrencyEvidence.CASH_FLOW);
});

// test_matching_an_existing_instrument_plans_its_missing_isin_and_broker_alias
it("matching an existing instrument plans its missing ISIN and broker alias", () => {
  const existing = instrumentOf("orlen", { aliases: [instrumentAlias("generic_csv", "PKN")] });
  const resolver = resolverOver([existing]);
  const resolved = resolver.resolve(hint({ symbol: "PKN", isin: "PLPKN0000018" }));
  expect(resolved.match).toBe(InstrumentMatch.BROKER_ALIAS);
  expect(resolver.newAliases).toEqual(
    new Map([[id("orlen"), [instrumentAlias("isin", "PLPKN0000018")]]]),
  );

  const withIsin = instrumentOf("orlen", {
    aliases: [instrumentAlias("generic_csv", "PKN"), instrumentAlias("isin", "PLPKN0000018")],
  });
  const conflicting = resolverOver([withIsin]);
  const other = conflicting.resolve(hint({ symbol: "PKN", isin: "PLOTHER00019" }));
  expect(other.match).toBe(InstrumentMatch.BROKER_ALIAS);
  expect(other.notes[0]).toContain("ISIN PLOTHER00019 of the row differs from Orlen");
  expect(conflicting.newAliases).toEqual(new Map());
});

// test_ambiguous_symbol_and_mic_uses_the_oldest_and_says_so
it("ambiguous symbol and MIC uses the oldest and says so", () => {
  const resolver = resolverOver([
    instrumentOf("old", { name: "Old", symbol: "DUP" }),
    instrumentOf("new", { name: "New", symbol: "DUP" }),
  ]);
  const resolved = resolver.resolve(hint({ symbol: "DUP", exchange: "XWAR" }));
  expect(resolved.instrumentId).toBe("old");
  expect(resolved.notes[0]).toContain("matches 2 instruments");
});

// test_an_empty_hint_is_rejected
it("an empty hint is rejected", () => {
  expect(() => resolverOver().resolve(hint({ symbol: " " }))).toThrow(InvariantError);
  expect(hintIsEmpty(hint({ symbol: " ", isin: "", name: null }))).toBe(true);
});

// test_find_never_plans
it("find never plans", () => {
  const resolver = resolverOver([instrumentOf("orlen", { isin: "PLPKN0000018" })]);
  expect(resolver.find({ symbol: "XYZ" })).toBeNull();
  expect(resolver.newInstruments).toEqual([]);
  const found = resolver.find({ symbol: "ignored", isin: "plpkn0000018" });
  expect(found?.instrumentId).toBe("orlen");
  expect(resolver.find()).toBeNull();
  const planned = resolver.resolve(hint({ symbol: "NEW", exchange: "GPW" }));
  expect(resolver.find({ symbol: "NEW" })?.instrumentId).toBe(planned.instrumentId);
});

// test_in_memory_lookup
it("in-memory lookup", () => {
  const lookup = new InMemoryInstrumentLookup([
    instrumentOf("a", { isin: "PLAAA0000011", aliases: [instrumentAlias("isin", "PLAAA0000029")] }),
  ]);
  expect(lookup.byIsin("plaaa0000011")?.id).toBe("a");
  expect(lookup.byAlias("isin", "PLAAA0000029")?.id).toBe("a");
  expect(lookup.bySymbol("pkn", "XWAR")[0]?.id).toBe("a");
  expect(lookup.bySymbol("pkn", "XNAS")).toEqual([]);
  lookup.add(instrumentOf("b", { symbol: "B", aliases: [instrumentAlias("xtb", "B.US")] }));
  expect(lookup.byAlias("xtb", "B.US")?.id).toBe("b");
});
