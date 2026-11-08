// The refresher and the composite over Yahoo / stooq / NBP responses through MarketHttp, R3 (GBp listing,
// valuation) and R6 (split re-fetch, valuation), the bounded worker pool.

import type { DateTime } from "@cashu/domain";
import {
  AssetClass,
  asAccountId,
  asProfileId,
  asTxnId,
  buildSnapshot,
  type CalendarDate,
  Currencies,
  type Currency,
  type FxRate,
  fxRate,
  type Instrument,
  instrumentAlias,
  market as m,
  priceBar,
  type Transaction,
  TxnType,
  transaction,
  valuePortfolio,
  viewLastBars,
  viewSeries,
} from "@cashu/domain/investments";
import { describe, expect, it } from "vitest";
import { NbpFxSource, standardCompositeSource, YahooPriceSource } from "./sources.js";
import {
  buildInstrument,
  d,
  fakeClock,
  fixture,
  makeHttp,
  orlen,
  recording,
  respond,
  type SeenRequest,
  vwce,
  weekdays,
  yahooChartFetch,
} from "./testing/support.js";

const AS_OF = "2026-10-02";

/** One rate (4) per weekday. */
class FakeFx implements m.FxSource {
  readonly id = "nbp";
  async rates(quote: Currency, start: CalendarDate, end: CalendarDate): Promise<FxRate[]> {
    return weekdays(start, end).map((on) =>
      fxRate({ quote, date: on, rate: d("4"), source: "nbp" }),
    );
  }
}

describe("composite over recorded responses", () => {
  it("standard composite: stooq bot page, then yahoo", async () => {
    const requests: SeenRequest[] = [];
    const standard = standardCompositeSource(
      makeHttp(
        recording(requests, (request) =>
          request.url.hostname === "stooq.pl"
            ? respond(fixture("stooq_challenge.html"), 200, "text/html; charset=utf-8")
            : respond(fixture("yahoo_vwce_de.json")),
        ),
      ),
      { clock: fakeClock },
    );
    // XWAR (stooq first); its yahoo alias quotes in EUR, so the instrument currency is EUR (R3).
    const gpwEtf = buildInstrument({
      name: "Vanguard FTSE All-World (GPW listing)",
      symbol: "VWCE",
      currency: Currencies.EUR,
      aliases: [instrumentAlias("stooq", "vwce"), instrumentAlias("yahoo", "VWCE.DE")],
    });
    const bars = (await standard.fetch(gpwEtf, "2026-09-14", "2026-09-25")).bars;
    expect(bars).toHaveLength(4);
    expect(bars.every((b) => b.source === "yahoo" && b.instrumentId === gpwEtf.id)).toBe(true);
    expect(requests.map((r) => r.url.hostname)).toEqual(["stooq.pl", "query1.finance.yahoo.com"]);
    expect(standard.health.get("stooq")?.blocked).toBe(true);

    await standard.fetch(gpwEtf, "2026-09-14", "2026-09-25");
    expect(requests.filter((r) => r.url.hostname === "stooq.pl")).toHaveLength(1);
  });
});

describe("refresh end to end", () => {
  it("composite and NBP through MarketHttp", async () => {
    const requests: SeenRequest[] = [];
    const http = makeHttp(
      recording(requests, (request) => {
        const host = request.url.hostname;
        if (host === "stooq.pl")
          return respond(fixture("stooq_challenge.html"), 200, "text/html; charset=utf-8");
        if (host === "query1.finance.yahoo.com") return respond(fixture("yahoo_vwce_de.json"));
        if (request.url.pathname.includes("/usd/")) return respond(fixture("nbp_usd.json"));
        return respond(fixture("nbp_no_data_404.txt"), 404, "text/plain");
      }),
    );
    const real = new m.MarketDataRefresher(
      standardCompositeSource(http, { clock: fakeClock }),
      new NbpFxSource(http, { clock: fakeClock }),
    );
    const etf = vwce();
    const pkn = orlen();
    const store = new m.InMemoryMarketData(
      [
        priceBar({ instrumentId: etf.id, date: "2026-09-14", close: d("1"), source: "yahoo" }),
        priceBar({ instrumentId: pkn.id, date: "2026-09-14", close: d("1"), source: "stooq" }),
      ],
      [fxRate({ quote: Currencies.USD, date: "2026-09-14", rate: d("1"), source: "nbp" })],
    );

    const report = await real.refresh(
      store,
      [etf, pkn],
      [Currencies.USD, Currencies.EUR],
      "2026-09-25",
    );
    store.apply(report);

    const [etfResult, pknResult] = report.instruments;
    expect([etfResult?.status, etfResult?.source, etfResult?.bars.length]).toEqual([
      m.FetchStatus.OK,
      "yahoo",
      4,
    ]);
    expect(etfResult?.currency).toBe(Currencies.EUR);
    // PKN (XWAR, PLN): stooq first -> bot page -> yahoo, but the fake answers with the EUR-quoted VWCE
    // fixture for any symbol: a quote currency mismatch is an error and nothing is stored (R3).
    expect([pknResult?.status, pknResult?.source, pknResult?.bars.length]).toEqual([
      m.FetchStatus.ERROR,
      null,
      0,
    ]);
    expect(pknResult?.message).toContain(
      'quote currency EUR for "PKN.WA" differs from the instrument currency PLN',
    );
    expect(store.lastBarDate(pkn.id)).toBe("2026-09-14");
    expect(requests.filter((r) => r.url.hostname === "stooq.pl")).toHaveLength(1);
    expect(store.bars.get(etf.id)?.get("2026-09-14")?.close.toString()).toBe("166.22");
    expect(report.fx.map((f) => f.status)).toEqual([m.FetchStatus.OK, m.FetchStatus.NO_DATA]);
    expect(store.fxLookup().rateOnOrBefore(Currencies.USD, "2026-09-14")?.toString()).toBe(
      "3.7607",
    );
  });
});

// --- R3: GBp listing through Yahoo, the refresher and valuation ---------------------------------

const vusa = (currency: Currency) =>
  buildInstrument({
    name: "Vanguard S&P 500 UCITS ETF",
    symbol: "VUSA",
    mic: "XLON",
    currency,
    assetClass: AssetClass.ETF,
    aliases: [instrumentAlias("yahoo", "VUSA.L", true)],
  });

let txnCounter = 0;
const txnId = () => asTxnId(`t${++txnCounter}`);

function buyHistory(account: string, target: Instrument, currency: Currency): Transaction[] {
  return [
    transaction({
      id: txnId(),
      accountId: asAccountId(account),
      type: TxnType.DEPOSIT,
      tradeDate: "2026-09-01",
      currency,
      grossAmount: d("1000"),
      cashAmount: d("1000"),
      cashCurrency: currency,
    }),
    transaction({
      id: txnId(),
      accountId: asAccountId(account),
      type: TxnType.BUY,
      tradeDate: "2026-09-02",
      instrumentId: target.id,
      quantity: d("10"),
      price: d("95"),
      currency,
      grossAmount: d("950"),
      cashAmount: d("-950"),
      cashCurrency: currency,
    }),
  ];
}

const dailyRates = (quote: Currency, start: string, end: string, rate: string) =>
  weekdays(start, end).map((on) => fxRate({ quote, date: on, rate: d(rate), source: "test" }));

const yahooGbpRefresher = () =>
  new m.MarketDataRefresher(
    new YahooPriceSource(
      makeHttp(recording([], () => respond(fixture("yahoo_vusa_l_gbp_synthetic.json")))),
      {
        clock: fakeClock,
      },
    ),
    new FakeFx(),
  );

describe("R3", () => {
  it("GBp closes are stored in GBP and valued correctly", async () => {
    const asOf = "2026-09-17"; // the fixture's last session
    const etf = vusa(Currencies.GBP);
    const store = new m.InMemoryMarketData(
      [],
      dailyRates(Currencies.GBP, "2026-09-01", asOf, "5.00"),
    );

    const report = await yahooGbpRefresher().refresh(store, [etf], [], asOf);
    expect(report.instruments[0]?.status).toBe(m.FetchStatus.OK);
    expect(report.instruments[0]?.currency).toBe(Currencies.GBP);
    store.apply(report);
    const series = viewSeries(store.marketView(asOf, [etf]), etf.id);
    expect(
      series.map((b) =>
        b.close.eq(d(["95.125", "94.88", "95.0125", "95.3"][series.indexOf(b)] as string)),
      ),
    ).toEqual([true, true, true, true]);

    const snapshot = buildSnapshot(
      asProfileId("profile"),
      buyHistory("acc", etf, Currencies.GBP),
      asOf,
    );
    const valued = valuePortfolio(
      snapshot,
      store.marketView(asOf, [etf]),
      store.fxLookup(),
      Currencies.PLN,
      5,
    );
    expect(valued.valued).toHaveLength(1);
    const holding = valued.valued[0];
    expect(holding?.price?.eq(d("95.3"))).toBe(true);
    expect(holding?.priceCurrency).toBe(Currencies.GBP);
    expect(holding?.marketValueBase?.eq(d("4765"))).toBe(true); // 10 x 95.3 GBP x 5.00, not x100
    expect(holding?.costBasisBase?.eq(d("4750"))).toBe(true); // 950 GBP x 5.00
    expect(holding?.unrealizedPct).toBeCloseTo(15 / 4750, 12);
    expect(valued.totalBase.eq(d("5015"))).toBe(true); // + 50 GBP cash x 5.00
  });

  it("a listing in another currency is rejected and only the trade price is known", async () => {
    const asOf = "2026-09-17";
    const wrong = vusa(Currencies.USD); // created from a USD row, alias guessed to the LSE line
    const store = new m.InMemoryMarketData(
      [],
      dailyRates(Currencies.USD, "2026-09-01", asOf, "4.00"),
    );

    const report = await yahooGbpRefresher().refresh(store, [wrong], [], asOf);
    const [fetch] = report.instruments;
    expect(fetch?.status).toBe(m.FetchStatus.ERROR);
    expect(fetch?.message).toContain(
      'quote currency GBP for "VUSA.L" differs from the instrument currency USD',
    );
    store.apply(report);
    expect(store.lastBarDate(wrong.id)).toBeNull(); // no mismatched bar is stored

    const snapshot = buildSnapshot(
      asProfileId("profile"),
      buyHistory("acc", wrong, Currencies.USD),
      asOf,
    );
    const valued = valuePortfolio(
      snapshot,
      store.marketView(asOf, [wrong]),
      store.fxLookup(),
      Currencies.PLN,
      5,
    );
    const holding = valued.valued[0];
    expect([holding?.price?.toString(), holding?.isStale]).toEqual(["95", true]); // only the last trade price
  });
});

// --- R6: splits ---------------------------------------------------------------------------------

const SPLIT_DAY = "2026-09-30";
const BEFORE_SPLIT: DateTime = {
  date: "2026-09-01",
  hour: 0,
  minute: 0,
  second: 0,
  microsecond: 0,
  offsetSeconds: 0,
};

const splitter = () =>
  buildInstrument({
    name: "Splitter",
    symbol: "SPLT",
    mic: "XNAS",
    currency: Currencies.USD,
    aliases: [instrumentAlias("yahoo", "SPLT")],
  });

/** Unadjusted closes (400) for 2026-06-01 .. 2026-09-29, fetched before the split. */
const storeWithOldBars = (target: Instrument) =>
  new m.InMemoryMarketData(
    weekdays("2026-06-01", "2026-09-29").map((on) =>
      priceBar({
        instrumentId: target.id,
        date: on,
        close: d("400"),
        source: "yahoo",
        fetchedAt: BEFORE_SPLIT,
      }),
    ),
  );

const splittingYahoo = (requests: SeenRequest[]) =>
  new YahooPriceSource(
    makeHttp(yahooChartFetch(requests, () => "100", { splits: [[SPLIT_DAY, 4, 1]] })),
    {
      clock: fakeClock,
    },
  );

describe("R6", () => {
  it("a split reported by Yahoo refetches and replaces the stored window", async () => {
    const requests: SeenRequest[] = [];
    const real = new m.MarketDataRefresher(splittingYahoo(requests), new FakeFx());
    const splt = splitter();
    const store = storeWithOldBars(splt);

    const report = await real.refresh(store, [splt], [], AS_OF);

    const [result] = report.instruments;
    expect(result?.status).toBe(m.FetchStatus.OK);
    expect(result?.refetchedForSplit).toBe(true);
    expect(result?.message).toBe(
      "split 4:1 on 2026-09-30 reported by the source: re-fetched the stored window",
    );
    expect(result?.start).toBe("2026-06-01"); // the oldest stored bar
    expect(result?.replaceFrom).toBe("2026-06-01");
    expect(requests).toHaveLength(2); // the incremental window, then the full stored window
    store.apply(report);
    const stored = viewSeries(store.marketView(AS_OF, [splt]), splt.id);
    expect(stored[0]?.date).toBe("2026-06-01");
    expect(stored.at(-1)?.date).toBe(AS_OF);
    expect(new Set(stored.map((b) => b.close.toString()))).toEqual(new Set(["100"])); // no unadjusted 400 left
    expect(stored.every((b) => b.currency === Currencies.USD)).toBe(true);

    // The next run: the split is outside the incremental window and the bars are adjusted.
    requests.length = 0;
    const again = await real.refresh(store, [splt], [], AS_OF);
    expect(again.instruments[0]?.refetchedForSplit).toBe(false);
    expect(requests).toHaveLength(1);
  });

  it("valuation after the refetch uses adjusted prices and split quantities", async () => {
    const splt = splitter();
    const store = storeWithOldBars(splt);
    store.upsertRates(dailyRates(Currencies.USD, "2026-05-25", AS_OF, "4.00"));
    store.apply(
      await new m.MarketDataRefresher(splittingYahoo([]), new FakeFx()).refresh(
        store,
        [splt],
        [],
        AS_OF,
      ),
    );
    const at = (date: string, hour: number): DateTime => ({
      date,
      hour,
      minute: 0,
      second: 0,
      microsecond: 0,
      offsetSeconds: 0,
    });
    const usd = Currencies.USD;
    const txns = [
      transaction({
        id: asTxnId("t1"),
        accountId: asAccountId("acc"),
        type: TxnType.DEPOSIT,
        tradeDate: "2026-06-01",
        currency: usd,
        grossAmount: d("4000"),
        cashAmount: d("4000"),
        cashCurrency: usd,
        createdAt: at("2026-06-01", 0),
      }),
      transaction({
        id: asTxnId("t2"),
        accountId: asAccountId("acc"),
        type: TxnType.BUY,
        tradeDate: "2026-06-01",
        instrumentId: splt.id,
        quantity: d("10"),
        price: d("400"),
        currency: usd,
        grossAmount: d("4000"),
        cashAmount: d("-4000"),
        cashCurrency: usd,
        createdAt: at("2026-06-01", 1),
      }),
      transaction({
        id: asTxnId("t3"),
        accountId: asAccountId("acc"),
        type: TxnType.SPLIT,
        tradeDate: SPLIT_DAY,
        instrumentId: splt.id,
        currency: usd,
        grossAmount: d("0"),
        cashAmount: d("0"),
        cashCurrency: usd,
        splitRatio: d("4"),
      }),
    ];
    const snapshot = buildSnapshot(asProfileId("profile"), txns, AS_OF);
    const view = store.marketView(AS_OF, [splt]);
    const valued = valuePortfolio(snapshot, view, store.fxLookup(), Currencies.PLN, 5);
    const holding = valued.valued[0];
    expect(holding?.holding.quantity.eq(d("40"))).toBe(true);
    expect(holding?.marketValueBase?.eq(d("16000"))).toBe(true); // 40 x 100 USD x 4.00
    expect(holding?.costBasisBase?.eq(d("16000"))).toBe(true); // 4000 USD x 4.00
    const window = viewLastBars(view, splt.id, 60);
    const high = window.reduce((max, b) => (b.close.gt(max) ? b.close : max), d("0"));
    expect(high.sub((window.at(-1) as (typeof window)[number]).close).isZero()).toBe(true); // no false "75 % below its high"
  });
});

describe("bounded concurrency (P10)", () => {
  it("workers fetch concurrently and keep the input order", async () => {
    let now = 0;
    let max = 0;
    const slow: m.PriceSource = {
      id: "yahoo",
      async fetch(target, _start, end) {
        now += 1;
        max = Math.max(max, now);
        await new Promise((resolve) => setTimeout(resolve, 20));
        now -= 1;
        return m.priceHistory({
          bars: [priceBar({ instrumentId: target.id, date: end, close: d(1), source: "yahoo" })],
        });
      },
    };
    const noFx: m.FxSource = { id: "nbp", rates: async () => [] };
    const instruments = Array.from({ length: 8 }, (_, n) =>
      buildInstrument({ name: `I${n}`, symbol: `I${n}` }),
    );
    const report = await new m.MarketDataRefresher(slow, noFx, { workers: 4 }).refresh(
      new m.InMemoryMarketData(),
      instruments,
      [Currencies.USD],
      AS_OF,
    );
    expect(report.instruments.map((i) => i.label)).toEqual(instruments.map((i) => i.symbol));
    expect(max).toBeGreaterThan(1);
    expect(max).toBeLessThanOrEqual(4);
    expect(report.fx[0]?.currency).toBe(Currencies.USD);
  });
});
