import { expect, it } from "vitest";
import { toCurrency } from "../domain/index.js";
import { CanonicalImporter } from "./canonical/index.js";
import {
  type BrokerImporter,
  effectiveBrokerId,
  hasBlockingWarnings,
  type ImportFile,
  type ImportParseResult,
  ImportWarningKind,
  importFileExtension,
  importParseResult,
  importWarning,
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
import { DuplicateImporterError, defaultRegistry, ImporterRegistry } from "./registry.js";
import { csvFile, plMapping } from "./testing/support.js";

// The importer contract (extension, blocking warnings, registry, broker id) and the exchange hints.
const file = (name: string): ImportFile => ({ name, content: new Uint8Array() });

it("import file extension", () => {
  expect(importFileExtension(file("Export.CSV"))).toBe("csv");
  expect(importFileExtension(file("archive.tar.gz"))).toBe("gz");
  expect(importFileExtension(file("noext"))).toBe("");
  expect(importFileExtension(file(".hidden"))).toBe("");
});

it("a blocking warning blocks the result, and warnings render with their row", () => {
  const result = importParseResult({
    warnings: [
      importWarning({ message: "a" }),
      importWarning({ message: "b", row: 3, blocking: true }),
    ],
  });
  expect(hasBlockingWarnings(result)).toBe(true);
  expect(warningText(result.warnings[1] as never)).toBe("row 3: b (blocking)");
  expect(warningText(result.warnings[0] as never)).toBe("a");
  expect(hasBlockingWarnings(importParseResult())).toBe(false);
});

class Fake implements BrokerImporter {
  readonly displayName: string;
  readonly version = 1;
  readonly brokerId: string;
  private readonly accepts: boolean;
  private readonly explode: boolean;
  constructor(brokerId: string, accepts = true, explode = false) {
    this.brokerId = brokerId;
    this.accepts = accepts;
    this.explode = explode;
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
});

it("default registry puts the canonical importer first", () => {
  const registry = defaultRegistry(plMapping());
  expect(registry.importers.map((importer) => importer.brokerId)).toEqual(["cashu", "generic_csv"]);
});

it("effective broker id prefers the file source", () => {
  const importer = new CanonicalImporter();
  expect(effectiveBrokerId(importer, importParseResult())).toBe("cashu");
  expect(effectiveBrokerId(importer, importParseResult({ source: "examplebroker" }))).toBe(
    "examplebroker",
  );
});

it("derives stable warning codes from the kind", () => {
  expect(importWarning({ message: "m" }).kind).toBe(ImportWarningKind.OTHER);
  const warning = importWarning({ message: "m", kind: ImportWarningKind.FX_MISSING });
  expect(warningCode(warning)).toBe("import.fx_missing");
  expect(warningCode(importWarning({ message: "m" }))).toBe("import.other");
  expect(warningCode(importWarning({ message: "m", kind: "" }))).toBe("import.other");
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

it.each([
  ["XWAR", ".WA", "PLN"],
  ["XLON", ".L", "GBP"],
  ["XETR", ".DE", "EUR"],
  ["XHKG", ".HK", "HKD"],
  ["XSWX", ".SW", "CHF"],
])("market table %s", (mic, suffix, currency) => {
  const market = MARKETS.get(mic);
  expect(market).toBeDefined();
  expect(market?.yahooSuffix).toBe(suffix);
  expect(market?.currency).toBe(toCurrency(currency));
  expect(exchangeForHint(mic)).toBe(market);
});

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
