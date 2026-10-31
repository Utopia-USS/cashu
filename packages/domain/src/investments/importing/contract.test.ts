import { expect, it } from "vitest";
import { Currencies, TxnType, toCurrency } from "../domain/index.js";
import { CanonicalImporter } from "./canonical/index.js";
import {
  type BrokerImporter,
  effectiveBrokerId,
  hasBlockingWarnings,
  IMPORT_WARNING_KINDS,
  type ImportFile,
  type ImportParseResult,
  ImportWarningKind,
  importFileExtension,
  importParseResult,
  importWarning,
  instrumentNamed,
  type ParsedCorporateAction,
  parsedDelisting,
  parsedRename,
  warningCode,
  warningText,
} from "./contract.js";
import {
  CRYPTO,
  cryptoBase,
  type ExchangeInfo,
  exchangeForHint,
  exchangeForMic,
  isCryptoSymbol,
  MARKETS,
  splitBrokerSymbol,
  stooqSymbol,
  yahooSymbol,
} from "./exchanges.js";
import { GenericCsvImporter } from "./genericCsv.js";
import { DuplicateImporterError, defaultRegistry, ImporterRegistry } from "./registry.js";
import { csvFile, d, day, parsedTxnOf, plMapping } from "./testing/support.js";

// Translation of tests/investments/importing/test_imp_contract.py: contract types, the registry
// (with the default registry) and the exchange hints of exchanges.py, test-for-test. Python's
// `isinstance(x, BrokerImporter)` (a runtime-checkable Protocol) is the TypeScript structural check
// plus the members the Protocol names; hashing and `isinstance(..., tuple)` have no TS counterpart and
// are replaced by the frozen / defaults checks noted on each test.
const file = (name: string): ImportFile => ({ name, content: new Uint8Array() });

// test_import_file_extension
it("import file extension", () => {
  expect(importFileExtension(file("Export.CSV"))).toBe("csv");
  expect(importFileExtension(file("archive.tar.gz"))).toBe("gz");
  expect(importFileExtension(file("noext"))).toBe("");
  expect(importFileExtension(file(".hidden"))).toBe("");
});

// test_parse_result_converts_lists_and_reports_blocking
it("parse result copies sequences and reports blocking", () => {
  const txn = parsedTxnOf(TxnType.BUY, { price: "10" });
  const list = [txn];
  const result = importParseResult({
    txns: list,
    warnings: [
      importWarning({ message: "a" }),
      importWarning({ message: "b", row: 3, blocking: true }),
    ],
  });
  list.length = 0;
  expect(result.txns).toHaveLength(1);
  expect(Object.isFrozen(result.warnings)).toBe(true);
  expect(hasBlockingWarnings(result)).toBe(true);
  expect(warningText(result.warnings[1] as never)).toBe("row 3: b (blocking)");
  expect(warningText(result.warnings[0] as never)).toBe("a");
  expect(hasBlockingWarnings(importParseResult())).toBe(false);
  expect(() => {
    (result as { accountHint: string | null }).accountHint = "x";
  }).toThrow(TypeError);
});

// test_parsed_txn_is_hashable_and_raw_row_is_not_part_of_the_hash
it("parsed txn defaults and instrument naming (hashing is Python-only)", () => {
  const txn = parsedTxnOf(TxnType.BUY);
  expect(txn.fee.isZero() && txn.tax.isZero()).toBe(true);
  expect(instrumentNamed(txn)).toBe(true);
  expect(instrumentNamed(parsedTxnOf(TxnType.DEPOSIT, { symbol: "  " }))).toBe(false);
  expect(Object.isFrozen(txn)).toBe(true);
});

// test_corporate_actions_are_one_family
it("corporate actions are one family", () => {
  const rename = parsedRename({ date: day("2026-02-01"), oldSymbol: "ABC", newSymbol: "ABCN" });
  const delisting = parsedDelisting({ date: day("2026-02-02"), symbol: "ZZZ", frozen: true });
  const family: ParsedCorporateAction[] = [rename, delisting];
  expect(family.map((action) => action.kind)).toEqual(["rename", "delisting"]);
  expect([rename.rowIndex, delisting.frozen]).toEqual([null, true]);
});

// test_importers_satisfy_the_protocol
it("importers satisfy the protocol", () => {
  const importers: BrokerImporter[] = [
    new GenericCsvImporter(plMapping()),
    new CanonicalImporter(),
  ];
  for (const importer of importers) {
    expect(typeof importer.brokerId).toBe("string");
    expect(typeof importer.displayName).toBe("string");
    expect(typeof importer.version).toBe("number");
    expect(typeof importer.canParse).toBe("function");
    expect(typeof importer.parse).toBe("function");
  }
  expect(importers.map((importer) => importer.brokerId)).toEqual(["generic_csv", "cashu"]);
});

class Fake implements BrokerImporter {
  readonly displayName: string;
  readonly version = 1;
  constructor(
    readonly brokerId: string,
    private readonly accepts = true,
    private readonly explode = false,
  ) {
    this.displayName = brokerId.toUpperCase();
  }

  canParse(): boolean {
    if (this.explode) throw new Error("sniff failed");
    return this.accepts;
  }

  parse(): ImportParseResult {
    return importParseResult();
  }
}

// test_registry_register_get_detect
it("registry register, get, detect", () => {
  const [first, second, broken, other] = [
    new Fake("a"),
    new Fake("b"),
    new Fake("c", true, true),
    new Fake("d", false),
  ];
  const registry = new ImporterRegistry([first, broken, second, other]);
  expect(registry.importers).toEqual([first, broken, second, other]);
  expect(registry.get("b")).toBe(second);
  expect(registry.get("zzz")).toBeUndefined();
  expect(registry.has("a") && registry.size === 4).toBe(true);
  expect(registry.detect(csvFile("x")), "throwing sniffs are no match").toEqual([first, second]);
  expect(() => registry.register(new Fake("a"))).toThrow(DuplicateImporterError);
  expect(() => registry.register(new Fake("a"))).toThrow(
    "An importer with broker id 'a' is already registered",
  );
});

// test_default_registry_puts_the_canonical_importer_first
it("default registry puts the canonical importer first", () => {
  const registry = defaultRegistry(plMapping());
  expect(registry.importers.map((importer) => importer.brokerId)).toEqual(["cashu", "generic_csv"]);
});

// test_effective_broker_id_prefers_the_file_source
it("effective broker id prefers the file source", () => {
  const importer = new CanonicalImporter();
  expect(effectiveBrokerId(importer, importParseResult())).toBe("cashu");
  expect(effectiveBrokerId(importer, importParseResult({ source: "examplebroker" }))).toBe(
    "examplebroker",
  );
});

// test_warning_values
it("warning values", () => {
  expect(importWarning({ message: "m" })).toEqual(
    importWarning({ message: "m", row: null, blocking: false }),
  );
  expect(d("1").eq(d("1.0"))).toBe(true);
});

// test_warning_kinds
it("warning kinds", () => {
  expect(importWarning({ message: "m" }).kind).toBe(ImportWarningKind.OTHER);
  expect(ImportWarningKind.OTHER).toBe("other");
  const warning = importWarning({ message: "m", kind: ImportWarningKind.FX_MISSING });
  expect(warning.kind).toBe("fx_missing");
  expect(warningCode(warning)).toBe("import.fx_missing");
  expect(IMPORT_WARNING_KINDS.includes("unmapped_type" as ImportWarningKind)).toBe(true);
  for (const kind of ["unknown_split_ratio", "history_gap_hint", "fx_missing"]) {
    expect(IMPORT_WARNING_KINDS as readonly string[]).toContain(kind);
  }
  expect(warningCode(importWarning({ message: "m", kind: "" }))).toBe("import.other");
});

// A reminder that the contract uses the domain currency type (no raw strings).
it("currencies come from the domain", () => {
  expect(parsedTxnOf(TxnType.BUY, { currency: Currencies.PLN }).currency).toBe("PLN");
});

/** The market a hint names; a missing market fails the test (Python's `None.attr` raises). */
function hinted(hint: string | null): ExchangeInfo {
  const market = exchangeForHint(hint);
  if (market === null) throw new Error(`no market for hint ${hint}`);
  return market;
}

function byMic(mic: string): ExchangeInfo {
  const market = exchangeForMic(mic);
  if (market === null) throw new Error(`no market for MIC ${mic}`);
  return market;
}

// test_exchange_hints
it("exchange hints", () => {
  expect(hinted("gpw").mic).toBe("XWAR");
  expect(hinted(".PL").mic).toBe("XWAR");
  expect(stooqSymbol(hinted("NASDAQ"), "AAPL")).toBe("aapl.us");
  expect(yahooSymbol(hinted("LSE"), "vusa")).toBe("VUSA.L");
  expect(exchangeForHint("Mars")).toBeNull();
  expect(exchangeForHint("  ")).toBeNull();
  expect(exchangeForHint(null)).toBeNull();
  // Belgium at some brokers, Berlin at Yahoo
  expect(exchangeForHint("BE")).toBeNull();
  expect(byMic("xetr").yahooSuffix).toBe(".DE");
  expect(hinted("US").mic).toBeNull();
  expect(yahooSymbol(hinted("US"), "x")).toBe("X");
});

// test_market_table
it.each([
  ["XNAS", "", "USD"],
  ["XNYS", "", "USD"],
  ["ARCX", "", "USD"],
  ["BATS", "", "USD"],
  ["XWAR", ".WA", "PLN"],
  ["XLON", ".L", "GBP"],
  ["XASX", ".AX", "AUD"],
  ["XTSE", ".TO", "CAD"],
  ["XTSX", ".V", "CAD"],
  ["XHKG", ".HK", "HKD"],
  ["XPAR", ".PA", "EUR"],
  ["XAMS", ".AS", "EUR"],
  ["XBRU", ".BR", "EUR"],
  ["XETR", ".DE", "EUR"],
  ["XMIL", ".MI", "EUR"],
  ["XMAD", ".MC", "EUR"],
  ["XSWX", ".SW", "CHF"],
  ["XSTO", ".ST", "SEK"],
  ["XCSE", ".CO", "DKK"],
  ["XOSL", ".OL", "NOK"],
  ["XHEL", ".HE", "EUR"],
])("market table %s", (mic, suffix, currency) => {
  const market = MARKETS.get(mic);
  expect(market).toBeDefined();
  expect(market?.yahooSuffix).toBe(suffix);
  expect(market?.currency).toBe(toCurrency(currency));
  expect(exchangeForHint(mic)).toBe(market);
});

// test_crypto_pseudo_market_and_symbols
it("crypto pseudo-market and symbols", () => {
  expect(exchangeForHint("crypto")).toBe(CRYPTO);
  expect(yahooSymbol(CRYPTO, "btc")).toBe("BTC-USD");
  expect(CRYPTO.mic).toBeNull();
  expect(CRYPTO.crypto).toBe(true);
  expect(cryptoBase("BTC")).toBe("BTC");
  expect(cryptoBase("btc-usd")).toBe("BTC");
  expect(cryptoBase("ETH/EUR")).toBe("ETH");
  expect(cryptoBase("BTCUSD")).toBe("BTC");
  expect(cryptoBase("USDC")).toBe("USDC");
  expect(cryptoBase("AAPL")).toBeNull();
  expect(cryptoBase("BTC-XYZ")).toBeNull();
  expect(isCryptoSymbol(null)).toBe(false);
});

// test_split_broker_symbol
it("split broker symbol", () => {
  expect(splitBrokerSymbol("PKN.PL", null).symbol).toBe("PKN");
  expect(splitBrokerSymbol("PKN.PL", null).exchange?.mic).toBe("XWAR");
  expect(splitBrokerSymbol("BRK.B", null).symbol).toBe("BRK.B");
  expect(splitBrokerSymbol("BRK.B", null).exchange).toBeNull();
  expect(splitBrokerSymbol("VWCE.DE", "XETRA").symbol).toBe("VWCE");
  // suffix contradicts the hint
  expect(splitBrokerSymbol("VWCE.DE", "GPW").symbol).toBe("VWCE.DE");
  // US suffix has no MIC
  expect(splitBrokerSymbol("AAPL.US", "NASDAQ").exchange?.mic).toBe("XNAS");
  expect(splitBrokerSymbol(" PKN ", "GPW").symbol).toBe("PKN");
});

// test_us_venues_are_complete
it("US venues are complete", () => {
  for (const mic of ["XNAS", "XNYS", "ARCX", "BATS", "XASE", "IEXG"]) {
    const market = exchangeForHint(mic);
    expect(market?.mic).toBe(mic);
    expect([market?.yahooSuffix, market?.stooqSuffix, market?.currency]).toEqual([
      "",
      ".us",
      "USD",
    ]);
  }
  expect(hinted("AMEX").mic).toBe("XASE");
  expect(hinted("NYSE American".replace(" ", "")).mic).toBe("XASE");
  expect(hinted("IEX").mic).toBe("IEXG");
});

// test_ticker_colon_mic_form
it("ticker:MIC form", () => {
  const nvda = splitBrokerSymbol("NVDA:xnas", null);
  expect([nvda.symbol, nvda.exchange?.mic]).toEqual(["NVDA", "XNAS"]);
  const cdr = splitBrokerSymbol("CDR:XWAR", "gpw");
  expect([cdr.symbol, cdr.exchange?.mic]).toEqual(["CDR", "XWAR"]);
  // contradicts the hint
  expect(splitBrokerSymbol("CDR:xwar", "XNAS").symbol).toBe("CDR:xwar");
  expect(splitBrokerSymbol("BRK.B:xnys", null).symbol).toBe("BRK.B");
  expect(splitBrokerSymbol("ABC:FOO", null).symbol).toBe("ABC:FOO");
});

// test_hong_kong_yahoo_symbols_are_padded_to_four_digits
it("Hong Kong Yahoo symbols are padded to four digits", () => {
  const hk = byMic("XHKG");
  expect(yahooSymbol(hk, "700")).toBe("0700.HK");
  expect(yahooSymbol(hk, "00700")).toBe("0700.HK");
  expect(yahooSymbol(hk, "9988")).toBe("9988.HK");
  expect(yahooSymbol(hk, "12345")).toBe("12345.HK");
  expect(yahooSymbol(hk, "ABC")).toBe("ABC.HK");
  // only Hong Kong pads
  expect(yahooSymbol(byMic("XWAR"), "700")).toBe("700.WA");
});
