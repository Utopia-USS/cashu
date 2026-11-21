// The batched price refresh: one spark request for every yahoo symbol, stooq-first listings per instrument, the 400-day backfill
// per instrument, FX from one table request, a close-only bar keeping the stored open / high. The run
// plans against the device's price cache (provider + market symbol) and writes the report back to it.
// Throttling, the daily lock, the env switch, the endpoint and the store reads are the service (S22c).

import { D, type DateTime, type Decimal } from "@cashu/domain";
import {
  AssetClass,
  type CalendarDate,
  Currencies,
  type Currency,
  type FxRate,
  fxRate,
  type Instrument,
  type InstrumentId,
  instrumentAlias,
  market as m,
  priceBar,
} from "@cashu/domain/investments";
import { describe, expect, it } from "vitest";
import { buildInstrument, weekdays } from "./testing/support.js";

const AS_OF = "2026-03-02"; // a Monday after the synthetic history
const NOW: DateTime = {
  date: "2026-03-02",
  hour: 15,
  minute: 0,
  second: 0,
  microsecond: 0,
  offsetSeconds: 0,
};
const FETCHED: DateTime = {
  date: "2026-03-02",
  hour: 7,
  minute: 0,
  second: 0,
  microsecond: 0,
  offsetSeconds: 0,
};

const abc = buildInstrument({
  name: "ABC Example SA",
  symbol: "ABC",
  mic: "XWAR",
  currency: Currencies.PLN,
  // as the import creates it from an XWAR row: guessed stooq and yahoo symbols
  aliases: [instrumentAlias("stooq", "abc", true), instrumentAlias("yahoo", "ABC.WA", true)],
});
const wrld = buildInstrument({
  name: "World Equity UCITS ETF",
  symbol: "WRLD",
  mic: "XETR",
  currency: Currencies.EUR,
  assetClass: AssetClass.ETF,
  aliases: [instrumentAlias("yahoo", "WRLD.DE")],
});
const xmpl = buildInstrument({
  name: "Example Corp",
  symbol: "XMPL",
  mic: "XNAS",
  currency: Currencies.USD,
  aliases: [instrumentAlias("yahoo", "XMPL")],
});
const HELD = [abc, wrld, xmpl];

const PRICES: Record<string, string> = { "ABC.WA": "60", "WRLD.DE": "110", XMPL: "100" };
const SPARK: Record<string, number> = { "ABC.WA": 61, "WRLD.DE": 111, XMPL: 102 };
const CURRENCY: Record<string, string> = { "ABC.WA": "PLN", "WRLD.DE": "EUR", XMPL: "USD" };

/** The daily check's per-instrument source: daily bars at a fixed close per yahoo symbol. */
class FakePrices implements m.PriceSource {
  readonly id = "yahoo";
  readonly calls: [string, CalendarDate, CalendarDate][] = [];
  async fetch(target: Instrument, start: CalendarDate, end: CalendarDate): Promise<m.PriceHistory> {
    const symbol = target.aliases.find((a) => a.namespace === "yahoo")?.value ?? "";
    this.calls.push([symbol, start, end]);
    const close = PRICES[symbol];
    if (close === undefined) return m.priceHistory();
    return m.priceHistory({
      bars: weekdays(start, end).map((on) =>
        priceBar({
          instrumentId: target.id,
          date: on,
          close: D(close),
          source: "yahoo",
          fetchedAt: FETCHED,
        }),
      ),
    });
  }
}

class FakeFx implements m.FxSource {
  readonly id = "nbp";
  readonly calls: [string, CalendarDate, CalendarDate][] = [];
  async rates(quote: Currency, start: CalendarDate, end: CalendarDate): Promise<FxRate[]> {
    this.calls.push([quote, start, end]);
    const rate = { EUR: "4.30", USD: "4.00" }[quote as string];
    if (rate === undefined) return [];
    return weekdays(start, end).map((on) =>
      fxRate({ quote, date: on, rate: D(rate), source: "nbp" }),
    );
  }
}

const stamp = (on: string) =>
  Date.UTC(...(on.split("-").map(Number) as [number, number, number]), 13, 30) / 1000;

/** Spark answers from a close per symbol (sessions 13:30 UTC on the weekdays of the four weeks up to AS_OF). */
class FakeSpark implements m.SparkSource {
  readonly calls: string[][] = [];
  async spark(symbols: readonly string[]): Promise<Map<string, string>> {
    this.calls.push([...symbols]);
    const days = weekdays("2026-02-02", AS_OF);
    const out = new Map<string, string>();
    for (const symbol of symbols) {
      const close = SPARK[symbol];
      if (close === undefined) continue;
      const result = {
        meta: { currency: CURRENCY[symbol], symbol, gmtoffset: 0 },
        timestamp: days.map(stamp),
        indicators: { quote: [{ close: days.map(() => close) }] },
      };
      out.set(symbol, JSON.stringify({ chart: { result: [result], error: null } }));
    }
    return out;
  }
  parseHistory(
    body: string,
    target: Instrument,
    start: CalendarDate,
    end: CalendarDate,
    symbol: string | null,
  ) {
    return m.parseYahooHistory(body, target, start, end, { symbol, fetchedAt: NOW });
  }
}

/** `table_rates` answers EUR and USD on every weekday of the range. */
class FakeTables implements m.TableFxSource {
  readonly maxDaysPerRequest = 93;
  readonly calls: [CalendarDate, CalendarDate][] = [];
  async tableRates(start: CalendarDate, end: CalendarDate): Promise<Map<Currency, FxRate[]>> {
    this.calls.push([start, end]);
    const out = new Map<Currency, FxRate[]>();
    for (const [code, rate] of [
      [Currencies.EUR, "4.31"],
      [Currencies.USD, "4.01"],
    ] as const) {
      out.set(
        code,
        weekdays(start, end).map((on) =>
          fxRate({ quote: code, date: on, rate: D(rate), source: "nbp" }),
        ),
      );
    }
    return out;
  }
}

const CURRENCIES = [Currencies.EUR, Currencies.USD];

/** The daily check: the stored history every refresh plans against. */
async function dailyCheck(cache: m.PriceCache): Promise<void> {
  const stored = m.cachedMarketData(cache, HELD);
  const report = await new m.MarketDataRefresher(new FakePrices(), new FakeFx()).refresh(
    stored,
    HELD,
    CURRENCIES,
    AS_OF,
  );
  m.applyFetchReport(cache, report, HELD, NOW);
}

interface Run {
  readonly report: m.FetchReport;
  readonly requests: Record<string, number>;
  readonly fallback: FakePrices;
  readonly spark: FakeSpark;
  readonly fx: FakeFx;
  readonly tables: FakeTables | null;
}

/** `service.prices._run` without the store: plan on the cache, batch, refresh, write back. */
async function refreshPrices(
  cache: m.PriceCache,
  options: { readonly tables?: FakeTables } = {},
): Promise<Run> {
  const stored = m.cachedMarketData(cache, HELD);
  const lastCloses = new Map<InstrumentId, readonly [CalendarDate, Decimal]>();
  for (const target of HELD) {
    const last = stored.series(target.id).at(-1);
    if (last !== undefined) lastCloses.set(target.id, [last.date, last.close]);
  }
  const spark = new FakeSpark();
  const fallback = new FakePrices();
  const fxSource = new FakeFx();
  const prices = new m.BatchedPriceSource(spark, fallback, { lastCloses });
  await prices.prefetch(HELD);
  const fx = new m.BatchedFxSource(options.tables ?? null, fxSource);
  const known = CURRENCIES.map((c) => stored.lastRateDate(c)).filter(
    (x): x is string => x !== null,
  );
  if (known.length > 0) await fx.prefetch(known.sort()[0] as string, AS_OF);
  const report = await new m.MarketDataRefresher(prices, fx).refresh(
    stored,
    HELD,
    CURRENCIES,
    AS_OF,
  );
  m.applyFetchReport(cache, report, HELD, NOW);
  return {
    report,
    requests: {
      spark: prices.requests,
      batched: prices.batched,
      per_instrument: prices.fallbacks,
      fx_tables: fx.requests,
    },
    fallback,
    spark,
    fx: fxSource,
    tables: options.tables ?? null,
  };
}

const updated = (report: m.FetchReport) =>
  report.instruments.filter((i) => i.status === m.FetchStatus.OK && i.bars.length > 0).length;

const closeOn = (cache: m.PriceCache, symbol: string, day = AS_OF) =>
  cache
    .bars(m.marketSymbol("yahoo", symbol))
    .find((b) => b.date === day)
    ?.close.toString();

describe("batched price refresh (P10)", () => {
  it("stores batched quotes: one spark request, the stooq-first listing per instrument", async () => {
    const cache = new m.InMemoryPriceCache();
    await dailyCheck(cache);

    const run = await refreshPrices(cache);

    expect(m.reportErrorMessages(run.report)).toEqual([]);
    expect(updated(run.report)).toBe(3);
    // one spark request for every yahoo symbol; ABC (XWAR, stooq first) still goes per instrument while
    // stooq is not blocked (the fake fallback has no stooq at all)
    expect(run.spark.calls).toEqual([["ABC.WA", "WRLD.DE", "XMPL"]]);
    expect(run.fallback.calls.map((c) => c[0])).toEqual(["ABC.WA"]);
    expect(run.requests).toEqual({ spark: 1, batched: 2, per_instrument: 1, fx_tables: 0 });
    expect(closeOn(cache, "WRLD.DE")).toBe("111");
    expect(closeOn(cache, "XMPL")).toBe("102");
  });

  it("a close-only bar keeps the stored open / high / low / volume of that day", async () => {
    const cache = new m.InMemoryPriceCache();
    await dailyCheck(cache);
    const key = m.marketSymbol("yahoo", "XMPL");
    const before = cache.bars(key).find((b) => b.date === AS_OF) as m.CachedBar;
    cache.upsertBars(key, [{ ...before, open: D("59"), high: D("63") }], NOW);

    await refreshPrices(cache);

    const after = cache.bars(key).find((b) => b.date === AS_OF) as m.CachedBar;
    expect(after.close.toString()).toBe("102");
    expect([after.open?.toString(), after.high?.toString()]).toEqual(["59", "63"]);
  });

  it("nothing stored yet goes the per-instrument way", async () => {
    const run = await refreshPrices(new m.InMemoryPriceCache());
    expect(updated(run.report)).toBe(3);
    expect(run.fallback.calls).toHaveLength(3); // the 400-day backfill is older than the spark window
    expect(run.requests.per_instrument).toBe(3);
  });

  it("fx comes from one table request", async () => {
    const cache = new m.InMemoryPriceCache();
    await dailyCheck(cache);
    const tables = new FakeTables();

    const run = await refreshPrices(cache, { tables });

    expect(
      run.report.fx.filter((f) => f.status === m.FetchStatus.OK && f.rates.length > 0),
    ).toHaveLength(2);
    expect(tables.calls).toEqual([[AS_OF, AS_OF]]);
    expect(run.fx.calls).toEqual([]);
    expect(run.requests.fx_tables).toBe(1);
  });
});
