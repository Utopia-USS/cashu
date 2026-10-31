/// <reference types="node" />
// Search response parsing on recorded responses (public market data, probed 2026-10-08) and the
// reverse Yahoo suffix lookup (tests/investments/market/test_f12_search_sources.py, the pure parts).
// The chart of a pick and the HTTP adapters are in @cashu/market (yahoo.test.ts, search.test.ts).

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AssetClass } from "../domain/enums.js";
import { Currencies } from "../domain/values.js";
import { exchangeForYahooSuffix } from "../importing/exchanges.js";
import { isKnownMarket, parseOpenFigiMapping, parseYahooSearch, type SearchHit } from "./search.js";
import { SourceException } from "./sources.js";

const SEARCH = new URL("../../../../../tests/investments/fixtures/market/search/", import.meta.url);
const body = (name: string): string => readFileSync(new URL(name, SEARCH), "utf8");

const rows = (hits: readonly SearchHit[]) =>
  hits.map((h) => [h.yahooSymbol, h.ticker, h.mic, h.currencyHint, h.assetClass]);

describe("Yahoo search", () => {
  // test_yahoo_ticker_query_keeps_every_listing_and_maps_known_suffixes
  it("a ticker query keeps every listing and maps known suffixes", () => {
    const hits = parseYahooSearch(body("yq_VWCE.json"), "VWCE");
    expect(rows(hits).slice(0, 3)).toEqual([
      ["VWCE.DE", "VWCE", "XETR", Currencies.EUR, AssetClass.ETF],
      ["VWCE.MI", "VWCE", "XMIL", Currencies.EUR, AssetClass.ETF],
      ["VWCE.AS", "VWCE", "XAMS", Currencies.EUR, AssetClass.ETF],
    ]);
    const [first] = hits;
    expect([first?.exchangeLabel, first?.isin, first?.source]).toEqual(["XETRA", null, "yahoo"]);
    // unknown suffixes stay as hits without an invented MIC or currency
    const munich = hits.find((h) => h.yahooSymbol === "VWCE.MU") as SearchHit;
    expect([munich.mic, munich.currencyHint, isKnownMarket(munich)]).toEqual([null, null, false]);
    expect(new Set(hits.filter((h) => h.mic === null).map((h) => h.yahooSymbol))).toEqual(
      new Set(["VWCE.MU", "VWCED.XD", "VWCE.DU", "VWCEA.XD"]),
    );
  });

  // test_yahoo_name_query_drops_futures_and_maps_us_exchange_codes
  it("a name query drops futures and maps US exchange codes", () => {
    const hits = parseYahooSearch(body("yq_nvidia.json"), "nvidia");
    expect(hits.map((h) => h.yahooSymbol)).toEqual([
      "NVDA",
      "NVDX",
      "NVDA.TO",
      "NVD.DE",
      "NVDA.NE",
    ]);
    const by = new Map(hits.map((h) => [h.yahooSymbol, h]));
    const nvda = by.get("NVDA") as SearchHit;
    expect([nvda.mic, nvda.exchangeLabel, nvda.ticker]).toEqual(["XNAS", "NASDAQ", "NVDA"]);
    expect(by.get("NVDX")?.mic).toBe("BATS");
    expect(by.get("NVD.DE")?.mic).toBe("XETR");
    expect(by.get("NVDA.TO")?.mic).toBe("XTSE"); // .TO is a known market (TSX)
    expect(by.get("NVDA.NE")?.mic).toBeNull();
    const gdxj = parseYahooSearch(body("yq_GDXJ.json"), "GDXJ");
    expect(gdxj.map((h) => [h.yahooSymbol, h.mic])).toEqual([
      ["GDXJ", "ARCX"],
      ["GDXJ.L", "XLON"],
      ["GDXJ.MI", "XMIL"],
    ]); // options dropped
    const orlen = new Map(parseYahooSearch(body("yq_orlen.json")).map((h) => [h.yahooSymbol, h]));
    expect(orlen.get("PKN.WA")?.mic).toBe("XWAR");
    expect(orlen.get("PKN.WA")?.name).toBe("Orlen S.A.");
    // an OTC code is a US listing without a MIC
    const otc = orlen.get("PSKOF") as SearchHit;
    expect([otc.mic, isKnownMarket(otc)]).toEqual([null, true]);
  });

  // test_yahoo_crypto_and_isin_queries
  it("crypto and ISIN queries", () => {
    const hits = parseYahooSearch(body("yq_bitcoin.json"), "bitcoin");
    expect(rows(hits)).toEqual([
      ["BTC-USD", "BTC", null, Currencies.USD, AssetClass.CRYPTO],
      ["IBIT", "IBIT", "XNAS", Currencies.USD, AssetClass.ETF],
      ["BCH-USD", "BCH", null, Currencies.USD, AssetClass.CRYPTO],
    ]);
    expect(isKnownMarket(hits[0] as SearchHit)).toBe(true); // the crypto pseudo-market
    const isin = parseYahooSearch(body("yq_IE00BK5BQT80.json"), "IE00BK5BQT80");
    expect(isin.map((h) => [h.yahooSymbol, h.mic, h.assetClass, h.isin])).toEqual([
      ["VWRA.L", "XLON", AssetClass.ETF, "IE00BK5BQT80"],
      ["IE00BK5BQT80.SG", null, AssetClass.FUND, "IE00BK5BQT80"],
    ]);
    const nvda = parseYahooSearch(body("yq_US67066G1040.json"), "US67066G1040");
    expect(nvda.map((h) => [h.yahooSymbol, h.mic])).toEqual([["NVDA", "XNAS"]]);
  });

  // test_yahoo_drops_non_finance_and_unknown_types
  it("drops non-finance and unknown types", () => {
    const data = {
      quotes: [
        { symbol: "EURUSD=X", quoteType: "CURRENCY", isYahooFinance: true },
        { symbol: "ABC", quoteType: "EQUITY", isYahooFinance: false },
        { symbol: "^WIG20", quoteType: "INDEX", isYahooFinance: true, shortname: "WIG20" },
        { symbol: "ABC.WA", quoteType: "EQUITY", exchange: "WSE", shortname: "  A  B  " },
        { symbol: "abc.wa", quoteType: "EQUITY" },
      ],
    };
    const hits = parseYahooSearch(JSON.stringify(data));
    expect(hits.map((h) => [h.yahooSymbol, h.assetClass, h.mic, h.name])).toEqual([
      ["^WIG20", AssetClass.OTHER, null, "WIG20"],
      ["ABC.WA", AssetClass.EQUITY, "XWAR", "A B"],
    ]);
    expect(() => parseYahooSearch("<html>blocked</html>")).toThrow(SourceException);
  });
});

describe("OpenFIGI mapping", () => {
  // test_openfigi_mapping_of_three_isins
  it("maps three ISINs to their listings", () => {
    const jobs = JSON.parse(body("figi_map.json")) as unknown[];
    const hits = (index: number, isin: string) =>
      parseOpenFigiMapping(JSON.stringify([jobs[index]]), isin);

    const vwce = hits(0, "IE00BK5BQT80");
    expect(vwce.slice(0, 4).map((h) => [h.yahooSymbol, h.mic])).toEqual([
      ["VWRA.L", "XLON"],
      ["VWRP.L", "XLON"],
      ["VWCE.DE", "XETR"],
      ["VWCE.MI", "XMIL"],
    ]);
    expect(new Set(vwce.map((h) => h.assetClass))).toEqual(new Set([AssetClass.ETF]));
    expect(new Set(vwce.map((h) => h.isin))).toEqual(new Set(["IE00BK5BQT80"]));
    expect(new Set(vwce.map((h) => h.source))).toEqual(new Set(["openfigi"]));
    const pkn = hits(1, "PLPKN0000018");
    expect(pkn.slice(0, 1).map((h) => [h.yahooSymbol, h.mic, h.assetClass])).toEqual([
      ["PKN.WA", "XWAR", AssetClass.EQUITY],
    ]);
    const nvda = hits(2, "US67066G1040");
    const [first] = nvda;
    expect(first?.yahooSymbol).toBe("NVDA");
    expect(first?.mic).toBeNull();
    expect(isKnownMarket(first as SearchHit)).toBe(true);
    const symbols = nvda.map((h) => h.yahooSymbol);
    expect(symbols.length).toBe(new Set(symbols).size); // deduplicated (US, UN, UW, ... are one NVDA)
    expect(hits(3, "XS0000000000")).toEqual([]); // a job answered with a warning
  });
});

// test_reverse_yahoo_suffix_lookup
it("reverse Yahoo suffix lookup", () => {
  expect(exchangeForYahooSuffix(".DE")?.mic).toBe("XETR");
  expect(exchangeForYahooSuffix("wa")?.mic).toBe("XWAR"); // GPW main market, not NewConnect
  expect(exchangeForYahooSuffix(".L")?.mic).toBe("XLON");
  expect(exchangeForYahooSuffix(".HK")?.mic).toBe("XHKG");
  for (const unknown of [".MU", ".SG", ".XD", ".DU", ".F", "", null]) {
    expect(exchangeForYahooSuffix(unknown)).toBeNull();
  }
});
