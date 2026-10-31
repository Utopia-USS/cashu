// Yahoo chart source incl. R3 quote currency and R6 splits
// (tests/investments/market/test_inv_yahoo_source.py).

import {
  AssetClass,
  Currencies,
  type Currency,
  instrumentAlias,
  market as m,
  type macro,
  priceBar,
  toCurrency,
} from "@cashu/domain/investments";
import { describe, expect, it } from "vitest";
import { YahooPriceSource } from "./sources.js";
import {
  buildInstrument,
  d,
  FETCHED_AT,
  fakeClock,
  fixture,
  makeHttp,
  orlen,
  recording,
  respond,
  type SeenRequest,
  utc,
  vwce,
} from "./testing/support.js";

const FROM = "2026-09-14";
const TO = "2026-09-25";

/** A minimal chart response; `currency` is omitted from `meta` when null (no check). */
function chart(
  gmtoffset: number,
  timestamps: number[],
  closes: (number | null)[],
  options: { volumes?: (number | null)[]; currency?: string | null; events?: unknown } = {},
): string {
  const meta: Record<string, unknown> = { symbol: "TEST", gmtoffset, priceHint: 2 };
  if (options.currency != null) meta.currency = options.currency;
  const result: Record<string, unknown> = {
    meta,
    timestamp: timestamps,
    indicators: {
      quote: [
        {
          open: closes,
          high: closes,
          low: closes,
          close: closes,
          volume: options.volumes ?? closes.map(() => 1),
        },
      ],
    },
  };
  if (options.events !== undefined) result.events = options.events;
  return JSON.stringify({ chart: { result: [result], error: null } });
}

class Yahoo {
  readonly requests: SeenRequest[] = [];
  readonly source: YahooPriceSource;
  constructor(body: string, status = 200, contentType = "application/json") {
    this.source = new YahooPriceSource(
      makeHttp(recording(this.requests, () => respond(body, status, contentType))),
      {
        clock: fakeClock,
      },
    );
  }
}

async function failure(yahoo: Yahoo): Promise<m.SourceException> {
  try {
    await yahoo.source.fetch(vwce(), FROM, TO);
  } catch (error) {
    if (error instanceof m.SourceException) return error;
    throw error;
  }
  throw new Error("expected a SourceException");
}

const closes = (bars: readonly { close: { toString(): string } }[]) =>
  bars.map((b) => b.close.toString());
/** Closes compared by value (Python `Decimal.__eq__`: `95.30 == 95.3`). */
const sameValues = (
  values: readonly ({ eq(o: ReturnType<typeof d>): boolean } | null | undefined)[],
  expected: string[],
) =>
  values.length === expected.length &&
  values.every((v, i) => v?.eq(d(expected[i] as string)) === true);
const dates = (bars: readonly { date: string }[]) => bars.map((b) => b.date);

describe("Yahoo chart source", () => {
  it("parses the recorded XETRA response into exchange dates and exact prices", async () => {
    const etf = vwce();
    const yahoo = new Yahoo(fixture("yahoo_vwce_de.json"));
    const bars = (await yahoo.source.fetch(etf, FROM, TO)).bars;

    expect(yahoo.requests).toHaveLength(1);
    const request = yahoo.requests[0] as SeenRequest;
    expect(request.url.hostname).toBe("query1.finance.yahoo.com");
    expect(request.url.pathname).toBe("/v8/finance/chart/VWCE.DE");
    expect(Object.fromEntries(request.url.searchParams)).toEqual({
      period1: String(utc(2026, 9, 13)), // one day of slack on each side for any UTC offset
      period2: String(utc(2026, 9, 27)),
      interval: "1d",
      events: "split", // R6: split events come with the bars
    });
    expect(request.headers["User-Agent"]).toBe(YahooPriceSource.DEFAULT_USER_AGENT);
    expect(request.headers["User-Agent"]?.startsWith("Mozilla/5.0")).toBe(true);

    expect(dates(bars)).toEqual(["2026-09-14", "2026-09-15", "2026-09-16", "2026-09-17"]);
    expect(bars[0]).toEqual(
      priceBar({
        instrumentId: etf.id,
        date: "2026-09-14",
        open: d("166.06"),
        high: d("166.4"),
        low: d("165.68"),
        close: d("166.22"),
        volume: 221018,
        source: "yahoo",
        fetchedAt: FETCHED_AT,
        currency: Currencies.EUR, // meta.currency, recorded on the bar (R3)
      }),
    );
    expect(closes(bars)).toEqual(["166.22", "165.36", "166.3", "167.66"]);
  });

  it("parses the recorded NASDAQ response", async () => {
    const aapl = buildInstrument({
      name: "Apple",
      symbol: "AAPL",
      mic: "XNAS",
      currency: Currencies.USD,
      aliases: [instrumentAlias("yahoo", "AAPL")],
    });
    const bars = (await new Yahoo(fixture("yahoo_aapl.json")).source.fetch(aapl, FROM, TO)).bars;
    expect(dates(bars)).toEqual(["2026-09-14", "2026-09-15", "2026-09-16", "2026-09-17"]);
    expect(closes(bars)).toEqual(["333.08", "331.34", "332.41", "337"]);
    expect(bars[0]?.volume).toBe(39269100);
  });
});

describe("exchange calendar date", () => {
  it("a session opening before midnight UTC belongs to the next local day", () => {
    // 10:00 AEDT on 6 Oct is 23:00 UTC on 5 Oct (Sydney, +11 h).
    expect(m.exchangeDate(utc(2026, 10, 5, 23), 39600)).toBe("2026-10-06");
  });

  it("Tokyo, New York and Warsaw opens", () => {
    expect(m.exchangeDate(utc(2026, 10, 6), 32400)).toBe("2026-10-06");
    expect(m.exchangeDate(utc(2026, 9, 14, 13, 30), -14400)).toBe("2026-09-14");
    expect(m.exchangeDate(utc(2026, 9, 14, 7), 7200)).toBe("2026-09-14");
  });

  it("a local midnight stamp read with the other DST offset keeps its date", () => {
    // Midnight EDT (04:00 UTC) of 1 Jul read with the winter offset (-5 h) shifts to 23:00 on 30 Jun.
    expect(m.exchangeDate(utc(2026, 7, 1, 4), -18000)).toBe("2026-07-01");
    // Midnight EST (05:00 UTC) of 2 Mar read with the summer offset (-4 h) shifts to 01:00.
    expect(m.exchangeDate(utc(2026, 3, 2, 5), -14400)).toBe("2026-03-02");
    // Midnight CET (23:00 UTC the day before) read with CEST (+2 h) shifts to 01:00.
    expect(m.exchangeDate(utc(2026, 1, 14, 23), 7200)).toBe("2026-01-15");
  });

  it("parse uses gmtoffset, so the same instants land on different dates", async () => {
    const instants = [utc(2026, 10, 5, 23), utc(2026, 10, 6, 23)];
    const sydney = (
      await new Yahoo(chart(39600, instants, [10, 11])).source.fetch(
        vwce(),
        "2026-10-01",
        "2026-10-10",
      )
    ).bars;
    expect(dates(sydney)).toEqual(["2026-10-06", "2026-10-07"]);
    const utcExchange = (
      await new Yahoo(chart(0, [utc(2026, 10, 5), utc(2026, 10, 6)], [10, 11])).source.fetch(
        vwce(),
        "2026-10-01",
        "2026-10-10",
      )
    ).bars;
    expect(dates(utcExchange)).toEqual(["2026-10-05", "2026-10-06"]);
  });

  it("bars outside the range by exchange date are dropped", async () => {
    const body = chart(39600, [utc(2026, 10, 4, 23), utc(2026, 10, 5, 23)], [10, 11]);
    const bars = (await new Yahoo(body).source.fetch(vwce(), "2026-10-06", "2026-10-06")).bars;
    expect(dates(bars)).toEqual(["2026-10-06"]);
  });

  it("rows without a close are skipped and a repeated date keeps the later row", async () => {
    const body = chart(
      0,
      [utc(2026, 9, 14, 8), utc(2026, 9, 15, 8), utc(2026, 9, 16, 8), utc(2026, 9, 16, 15, 5)],
      [10.5, null, 11, 11.25],
      { volumes: [100, null, 200, null] },
    );
    const bars = (await new Yahoo(body).source.fetch(vwce(), FROM, TO)).bars;
    expect(dates(bars)).toEqual(["2026-09-14", "2026-09-16"]);
    expect(bars.at(-1)?.close.toString()).toBe("11.25");
    expect(bars.at(-1)?.volume).toBeNull();
  });

  it("a range without sessions is an empty answer", async () => {
    const body = JSON.stringify({
      chart: { result: [{ meta: { gmtoffset: 7200 }, indicators: { quote: [{}] } }], error: null },
    });
    expect((await new Yahoo(body).source.fetch(vwce(), "2026-09-19", "2026-09-20")).bars).toEqual(
      [],
    );
  });
});

describe("Yahoo errors", () => {
  it("the recorded unknown symbol 404 is a non-retryable SourceException", async () => {
    const error = await failure(new Yahoo(fixture("yahoo_not_found.json"), 404));
    expect(error).not.toBeInstanceOf(m.SourceBlockedException);
    expect(error.retryable).toBe(false);
    expect(error.detail).toContain("no such symbol");
    expect(error.detail).toContain("symbol may be delisted");
  });

  it("401 / 403 block the source; other statuses and non-JSON are SourceExceptions", async () => {
    expect(await failure(new Yahoo("Unauthorized", 401))).toBeInstanceOf(m.SourceBlockedException);
    expect(await failure(new Yahoo("Forbidden", 403))).toBeInstanceOf(m.SourceBlockedException);
    expect((await failure(new Yahoo("teapot", 418))).detail).toContain("HTTP 418");
    const html = await failure(new Yahoo("<html>consent</html>", 200, "text/html"));
    expect(html.detail).toContain("unexpected response");
    expect((await failure(new Yahoo('{"chart":{"result":[]}}'))).detail).toContain(
      "no chart result",
    );
  });

  it("float32 noise is removed, genuine doubles keep their digits", async () => {
    const body = chart(
      0,
      [utc(2026, 9, 14, 8), utc(2026, 9, 15, 8), utc(2026, 9, 16, 8)],
      [10000.2998046875, 0.1, 0.012299999594688416],
    );
    const bars = (await new Yahoo(body).source.fetch(vwce(), FROM, TO)).bars;
    expect(closes(bars)).toEqual(["10000.3", "0.1", "0.0123"]);
  });

  it("an instrument without a yahoo alias cannot be priced here", async () => {
    const yahoo = new Yahoo("{}");
    await expect(
      yahoo.source.fetch(orlen([instrumentAlias("stooq", "pkn")]), FROM, TO),
    ).rejects.toBeInstanceOf(m.NoPriceSourceException);
    expect(yahoo.requests).toEqual([]);
  });

  it("an empty range makes no request", async () => {
    const yahoo = new Yahoo("{}");
    expect((await yahoo.source.fetch(vwce(), TO, FROM)).bars).toEqual([]);
    expect(yahoo.requests).toEqual([]);
  });
});

// --- quote currency (R3) ------------------------------------------------------------------------

function vusa(currency: Currency = Currencies.GBP) {
  return buildInstrument({
    name: "Vanguard S&P 500 UCITS ETF",
    symbol: "VUSA",
    mic: "XLON",
    currency,
    assetClass: AssetClass.ETF,
    aliases: [instrumentAlias("yahoo", "VUSA.L", true)],
  });
}

describe("quote currency (R3)", () => {
  it("GBP pence quotes are divided by 100 and recorded as GBP", async () => {
    const answer = await new Yahoo(fixture("yahoo_vusa_l_gbp_synthetic.json")).source.fetch(
      vusa(),
      FROM,
      TO,
    );
    expect(answer.currency).toBe(Currencies.GBP);
    expect(dates(answer.bars)).toEqual(["2026-09-14", "2026-09-15", "2026-09-16", "2026-09-17"]);
    expect(
      sameValues(
        answer.bars.map((b) => b.close),
        ["95.125", "94.88", "95.0125", "95.3"],
      ),
    ).toBe(true);
    const first = answer.bars[0];
    expect(sameValues([first?.open, first?.high, first?.low], ["94.9", "95.2", "94.7"])).toBe(true);
    expect(first?.volume).toBe(120345); // volume is not a price
    expect(answer.bars.every((b) => b.currency === Currencies.GBP)).toBe(true);
  });

  it("a quote currency other than the instrument currency is a non-retryable error", async () => {
    const yahoo = new Yahoo(fixture("yahoo_vusa_l_gbp_synthetic.json"));
    const error = await yahoo.source.fetch(vusa(Currencies.USD), FROM, TO).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(m.QuoteCurrencyMismatchException);
    const mismatch = error as m.QuoteCurrencyMismatchException;
    expect([mismatch.quoteCurrency, mismatch.instrumentCurrency, mismatch.retryable]).toEqual([
      Currencies.GBP,
      Currencies.USD,
      false,
    ]);
    expect(mismatch.detail).toContain(
      'quote currency GBP for "VUSA.L" differs from the instrument currency USD',
    );
  });

  it("ZAc and ILA are minor units, a missing currency is unchecked, garbage is an error", () => {
    const yahoo = new Yahoo("{}").source;
    const zar = buildInstrument({
      currency: toCurrency("ZAR"),
      aliases: [instrumentAlias("yahoo", "X.JO")],
    });
    const ils = buildInstrument({
      currency: toCurrency("ILS"),
      aliases: [instrumentAlias("yahoo", "X.TA")],
    });
    const body = (currency: string | null) => chart(0, [utc(2026, 9, 14, 8)], [1234], { currency });

    expect(yahoo.parseHistory(body("ZAc"), zar, FROM, TO).bars[0]?.close.toString()).toBe("12.34");
    expect(yahoo.parseHistory(body("ILA"), ils, FROM, TO).bars[0]?.close.toString()).toBe("12.34");
    const unchecked = yahoo.parseHistory(body(null), zar, FROM, TO);
    expect([
      unchecked.currency,
      unchecked.bars[0]?.close.toString(),
      unchecked.bars[0]?.currency,
    ]).toEqual([null, "1234", null]);
    expect(() => yahoo.parseHistory(body("pounds"), zar, FROM, TO)).toThrow(
      'quote currency "pounds"',
    );
  });
});

// --- split events (R6) --------------------------------------------------------------------------

const SPLITTER = buildInstrument({
  name: "Splitter Inc",
  symbol: "SPLT",
  mic: "XNAS",
  currency: Currencies.USD,
  aliases: [instrumentAlias("yahoo", "SPLT")],
});

describe("split events (R6)", () => {
  it("splits in the range come back with the adjusted bars", async () => {
    const yahoo = new Yahoo(fixture("yahoo_split_4for1_synthetic.json"));
    const answer = await yahoo.source.fetch(SPLITTER, FROM, TO);
    expect(answer.splits.map((s) => [s.date, s.ratio.toString()])).toEqual([["2026-09-16", "4"]]);
    expect(closes(answer.bars)).toEqual(["100", "99.5", "101", "101.5"]);
    expect(yahoo.requests[0]?.url.searchParams.get("events")).toBe("split");
  });

  it("splits outside the range are dropped and malformed entries ignored", () => {
    const body = chart(-14400, [utc(2026, 9, 14, 13, 30)], [10], {
      currency: "USD",
      events: {
        splits: {
          a: { date: utc(2026, 9, 1, 13, 30), numerator: 2, denominator: 1 },
          b: { date: utc(2026, 9, 14, 13, 30), numerator: 1, denominator: 10 },
          c: { date: utc(2026, 9, 15, 13, 30), numerator: 0, denominator: 1 },
        },
      },
    });
    const answer = new Yahoo("{}").source.parseHistory(body, SPLITTER, "2026-09-10", TO);
    expect(answer.splits.map((s) => [s.date, s.ratio.toString()])).toEqual([["2026-09-14", "0.1"]]); // reverse 1:10
  });
});

// --- chart of a pick (tests/investments/market/test_f12_search_sources.py, the parts without exchanges) --

const searchFixture = (name: string) => fixture(`search/${name}`);

describe("chart of a search pick", () => {
  it("the chart meta gives the pick currency", () => {
    const source = new Yahoo("{}").source;
    const quote = source.parseChart(
      searchFixture("chart_VWRA.L.json"),
      "VWRA.L",
      "2025-10-01",
      "2026-10-08",
    );
    expect(quote.currency).toBe(Currencies.USD); // not GBP: VWRA trades in USD on the LSE
    expect([quote.instrumentType, quote.exchangeName]).toEqual(["ETF", "LSE"]);
    expect(quote.longName).toBe("Vanguard FTSE All-World UCITS ETF USD Accumulation");
    expect(quote.bars.length).toBeGreaterThan(200);
    expect(new Set(quote.bars.map((b) => b.currency))).toEqual(new Set([Currencies.USD]));
    expect(new Set(quote.bars.map((b) => b.instrumentId))).toEqual(new Set(["chart"]));
    const btc = source.parseChart(
      searchFixture("chart_BTC-USD.json"),
      "BTC-USD",
      "2025-10-01",
      "2026-10-08",
    );
    expect([btc.currency, btc.instrumentType]).toEqual([Currencies.USD, "CRYPTOCURRENCY"]);
    expect(() =>
      source.parseChart(fixture("yahoo_not_found.json"), "NOPE.DE", "2026-01-01", "2026-02-01"),
    ).toThrow("no such symbol");
  });

  it("chart() requests the symbol and serves the macro refresh's chart source", async () => {
    const yahoo = new Yahoo(searchFixture("chart_VWCE.DE.json"));
    const quote = await yahoo.source.chart("VWCE.DE", "2025-10-01", "2026-10-08");
    expect(quote.currency).toBe(Currencies.EUR);
    expect(quote.bars.length).toBeGreaterThan(0);
    expect(quote.adjusted.length).toBeGreaterThan(0); // indicators.adjclose, read by the macro refresh
    expect(yahoo.requests.at(-1)?.url.pathname).toBe("/v8/finance/chart/VWCE.DE");
    const asMacroSource: macro.MacroChartSource = yahoo.source;
    expect(asMacroSource).toBe(yahoo.source);
  });
});
