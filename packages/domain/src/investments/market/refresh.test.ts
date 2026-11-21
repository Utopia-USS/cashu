// MarketDataRefresher over an in-memory store with fake sources (tests/investments/market/test_inv_refresh.py;
// the tests over Yahoo / NBP responses, R3 / R6 valuation and the worker pool test are in @cashu/market).
// The refresher only plans and fetches; `InMemoryMarketData.apply` plays the persistence layer.

import { beforeEach, describe, expect, it } from "vitest";
import type { DateTime } from "../../dates.js";
import { InstrumentStatus } from "../domain/enums.js";
import type { Instrument } from "../domain/instrument.js";
import { type FxRate, fxRate, type PriceBar, priceBar } from "../domain/marketData.js";
import { type CalendarDate, Currencies, type Currency, toCurrency } from "../domain/values.js";
import { FetchStatus, reportErrorMessages, reportHasErrors, reportStats } from "./fetchReport.js";
import { InMemoryMarketData, MarketDataRefresher } from "./refresh.js";
import {
  type FxSource,
  NoPriceSourceException,
  type PriceHistory,
  type PriceSource,
  priceHistory,
  SourceBlockedException,
  SourceException,
} from "./sources.js";
import { buildInstrument, d, FETCHED_AT, weekdayBars, weekdays } from "./testing/support.js";

const AS_OF = "2026-10-02"; // a Friday

class RuntimeError extends Error {
  override name = "RuntimeError";
}

type Script = Error | ((i: Instrument, start: CalendarDate, end: CalendarDate) => PriceBar[]);

/** One bar per weekday of the requested range unless scripted otherwise (by symbol). */
class FakePrices implements PriceSource {
  readonly id = "fake";
  readonly calls: [string | null, CalendarDate, CalendarDate][] = [];
  readonly script = new Map<string, Script>();

  async fetch(target: Instrument, start: CalendarDate, end: CalendarDate): Promise<PriceHistory> {
    this.calls.push([target.symbol, start, end]);
    const custom = this.script.get(target.symbol ?? "");
    if (custom instanceof Error) throw custom;
    if (custom !== undefined) return priceHistory({ bars: custom(target, start, end) });
    return priceHistory({ bars: weekdayBars(target, start, end) });
  }
}

/** One rate (4) per weekday unless scripted otherwise. */
class FakeFx implements FxSource {
  readonly id = "nbp";
  readonly calls: [Currency, CalendarDate, CalendarDate][] = [];
  readonly script = new Map<Currency, Error | FxRate[]>();

  async rates(quote: Currency, start: CalendarDate, end: CalendarDate): Promise<FxRate[]> {
    this.calls.push([quote, start, end]);
    const custom = this.script.get(quote);
    if (custom instanceof Error) throw custom;
    if (custom !== undefined) return [...custom];
    return weekdays(start, end).map((on) =>
      fxRate({ quote, date: on, rate: d("4"), source: "nbp", fetchedAt: FETCHED_AT }),
    );
  }
}

const seed = (symbol: string, init: Parameters<typeof buildInstrument>[0] = {}) =>
  buildInstrument({ name: symbol, symbol, ...init });

const bar = (
  target: Instrument,
  date: string,
  close: string,
  source = "yahoo",
  fetchedAt: DateTime | null = null,
) => priceBar({ instrumentId: target.id, date, close: d(close), source, fetchedAt });

let prices: FakePrices;
let fx: FakeFx;
let refresher: MarketDataRefresher;

beforeEach(() => {
  prices = new FakePrices();
  fx = new FakeFx();
  refresher = new MarketDataRefresher(prices, fx);
});

describe("MarketDataRefresher: prices", () => {
  it("an instrument without stored bars is backfilled from asOf minus 400 days", async () => {
    const pkn = seed("PKN");
    const store = new InMemoryMarketData();
    const report = await refresher.refresh(store, [pkn], [], AS_OF);

    expect(prices.calls).toEqual([["PKN", "2025-08-28", AS_OF]]);
    const [result] = report.instruments;
    expect(result?.status).toBe(FetchStatus.OK);
    expect(result?.source).toBe("yahoo");
    expect([result?.start, result?.end]).toEqual(["2025-08-28", AS_OF]);
    expect(result?.replaceFrom).toBeNull();
    store.apply(report);
    expect(result?.bars.length).toBe(store.bars.get(pkn.id)?.size);
    expect(store.lastBarDate(pkn.id)).toBe(AS_OF);
    expect(store.firstBarDate(pkn.id)).toBe("2025-08-28");
  });

  it("incremental refetches from the last stored bar, replacing it", async () => {
    const pkn = seed("PKN");
    // The 30 Sep bar was stored while the session was still open; the refresh replaces it.
    const store = new InMemoryMarketData([
      bar(pkn, "2026-09-29", "9"),
      bar(pkn, "2026-09-30", "9.5"),
    ]);
    const report = await refresher.refresh(store, [pkn], [], AS_OF);

    expect(prices.calls).toEqual([["PKN", "2026-09-30", AS_OF]]);
    expect(report.instruments[0]?.bars).toHaveLength(3); // 30 Sep (replaced), 1 Oct, 2 Oct
    store.apply(report);
    expect(store.bars.get(pkn.id)?.get("2026-09-30")?.close.toString()).toBe("10");
    expect(store.bars.get(pkn.id)?.get("2026-09-29")?.close.toString()).toBe("9");
  });

  it("refetchDays 0 starts after the last bar, and up to date makes no request", async () => {
    const strict = new MarketDataRefresher(prices, fx, { refetchDays: 0 });
    const pkn = seed("PKN");
    const store = new InMemoryMarketData(weekdayBars(pkn, "2026-09-28", "2026-09-30"));
    await strict.refresh(store, [pkn], [], AS_OF);
    expect(prices.calls).toEqual([["PKN", "2026-10-01", AS_OF]]);

    prices.calls.length = 0;
    store.upsertBars(weekdayBars(pkn, AS_OF, AS_OF));
    const report = await strict.refresh(store, [pkn], [], AS_OF);
    expect(prices.calls).toEqual([]);
    expect(report.instruments[0]?.status).toBe(FetchStatus.OK);
    expect(report.instruments[0]?.message).toContain("up to date");
  });

  it("with stored bars beyond asOf nothing is requested", async () => {
    const pkn = seed("PKN");
    const store = new InMemoryMarketData(weekdayBars(pkn, "2026-10-05", "2026-10-05"));
    const report = await refresher.refresh(store, [pkn], [], AS_OF);
    expect(prices.calls).toEqual([]);
    expect(report.instruments[0]?.start).toBeNull();
  });

  it("one failing instrument never aborts the others", async () => {
    const [failing, blocked, buggy] = [seed("FAIL"), seed("BLOCK"), seed("BUG")];
    const [empty, bond, good] = [seed("EMPTY"), seed("EDO"), seed("GOOD")];
    prices.script.set("FAIL", new SourceException("yahoo", "HTTP 503", { retryable: true }));
    prices.script.set("BLOCK", new SourceBlockedException("stooq", "bot page"));
    prices.script.set("BUG", new RuntimeError("parser bug"));
    prices.script.set("EMPTY", () => []);
    prices.script.set("EDO", new NoPriceSourceException("composite", "no stooq / yahoo alias"));
    const store = new InMemoryMarketData();

    const report = await refresher.refresh(
      store,
      [failing, blocked, buggy, empty, bond, good],
      [],
      AS_OF,
    );

    expect(report.instruments.map((i) => [i.label, i.status])).toEqual([
      ["FAIL", FetchStatus.ERROR],
      ["BLOCK", FetchStatus.ERROR],
      ["BUG", FetchStatus.ERROR],
      ["EMPTY", FetchStatus.NO_DATA],
      ["EDO", FetchStatus.NO_DATA],
      ["GOOD", FetchStatus.OK],
    ]);
    expect(report.instruments[0]?.message).toBe("yahoo: HTTP 503");
    expect(report.instruments[2]?.message).toBe("RuntimeError: parser bug");
    expect(report.instruments[4]?.message).toBe("no stooq / yahoo alias");
    expect(reportHasErrors(report)).toBe(true);
    expect(reportErrorMessages(report)).toEqual([
      `prices FAIL (${failing.id}): yahoo: HTTP 503`,
      `prices BLOCK (${blocked.id}): stooq: bot page`,
      `prices BUG (${buggy.id}): RuntimeError: parser bug`,
    ]);
    store.apply(report);
    expect(store.lastBarDate(good.id)).toBe(AS_OF);
    expect(store.lastBarDate(failing.id)).toBeNull();
    const stats = reportStats(report);
    expect([stats.instruments_error, stats.instruments_no_data, stats.instruments_ok]).toEqual([
      3, 2, 1,
    ]);
  });

  it("bars outside the range or for another instrument are dropped", async () => {
    const pkn = seed("PKN");
    const other = seed("OTHER");
    prices.script.set("PKN", (i) => [
      ...weekdayBars(i, "2026-10-05", "2026-10-05"), // after asOf
      ...weekdayBars(other, AS_OF, AS_OF), // wrong instrument
      ...weekdayBars(i, AS_OF, AS_OF),
    ]);
    const store = new InMemoryMarketData([bar(pkn, AS_OF, "1", "x")]);
    const report = await refresher.refresh(store, [pkn], [], AS_OF);
    expect(report.instruments[0]?.bars).toHaveLength(1);
    store.apply(report);
    expect(store.lastBarDate(other.id)).toBeNull();
  });

  it("duplicate instruments are fetched once", async () => {
    const pkn = seed("PKN");
    const report = await refresher.refresh(new InMemoryMarketData(), [pkn, pkn], [], AS_OF);
    expect(prices.calls).toHaveLength(1);
    expect(report.instruments).toHaveLength(1);
  });

  it("delisted and frozen instruments are not fetched", async () => {
    const delisted = seed("GONE", { status: InstrumentStatus.DELISTED });
    const frozen = seed("FRZ", { status: InstrumentStatus.FROZEN });
    const report = await refresher.refresh(new InMemoryMarketData(), [delisted, frozen], [], AS_OF);
    expect(prices.calls).toEqual([]);
    expect(report.instruments.map((i) => [i.status, i.message])).toEqual([
      [FetchStatus.SKIPPED, "not fetched: instrument is delisted"],
      [FetchStatus.SKIPPED, "not fetched: instrument is frozen"],
    ]);
    expect(reportStats(report).instruments_skipped).toBe(2);
    expect(reportHasErrors(report)).toBe(false);
  });

  it("refetchDays below zero and workers below one are refused", () => {
    expect(() => new MarketDataRefresher(prices, fx, { refetchDays: -1 })).toThrow("refetch_days");
    expect(() => new MarketDataRefresher(prices, fx, { workers: 0 })).toThrow("workers");
  });
});

describe("MarketDataRefresher: fx", () => {
  it("backfills an empty currency, refetches from the last rate and skips PLN", async () => {
    const store = new InMemoryMarketData(
      [],
      [fxRate({ quote: Currencies.EUR, date: "2026-09-30", rate: d("4.3"), source: "nbp" })],
    );
    const report = await refresher.refresh(
      store,
      [],
      [Currencies.USD, Currencies.EUR, Currencies.PLN, Currencies.USD],
      AS_OF,
    );
    expect(fx.calls).toEqual([
      ["USD", "2025-08-28", AS_OF],
      ["EUR", "2026-09-30", AS_OF],
    ]);
    expect(report.fx.map((f) => [f.currency, f.status])).toEqual([
      ["USD", FetchStatus.OK],
      ["EUR", FetchStatus.OK],
    ]);
    expect(report.fx.at(-1)?.rates).toHaveLength(3);
    expect(report.fx.at(-1)?.source).toBe("nbp");
    store.apply(report);
    expect(store.fxLookup().rateOnOrBefore(Currencies.USD, AS_OF)?.toString()).toBe("4");
  });

  it("fxHistoryFrom backfills older rates once, from a week before", async () => {
    const lotDate = "2024-03-10"; // a Sunday, long before asOf - 400 days
    const store = new InMemoryMarketData();
    const history = { fxHistoryFrom: new Map([[Currencies.USD, lotDate]]) };
    const first = await refresher.refresh(store, [], [Currencies.USD], AS_OF, history);

    expect(fx.calls).toEqual([
      ["USD", "2025-08-28", AS_OF],
      ["USD", "2024-03-03", "2025-08-27"],
    ]);
    expect(first.fx[0]?.status).toBe(FetchStatus.OK);
    expect(first.fx[0]?.start).toBe("2024-03-03");
    store.apply(first);
    const quote = store.fxLookup().quoteOnOrBefore(Currencies.USD, lotDate);
    expect(quote?.date).toBe("2024-03-08");
    expect(store.firstRateDate(Currencies.USD)).toBe("2024-03-04");

    // Covered now: the next run only re-fetches the last stored day.
    fx.calls.length = 0;
    await refresher.refresh(store, [], [Currencies.USD], AS_OF, history);
    expect(fx.calls).toEqual([["USD", AS_OF, AS_OF]]);
  });

  it("history inside the backfill window needs no second request", async () => {
    const report = await refresher.refresh(new InMemoryMarketData(), [], [Currencies.USD], AS_OF, {
      fxHistoryFrom: new Map([[Currencies.USD, "2026-06-01"]]),
    });
    expect(fx.calls).toHaveLength(1);
    expect(report.fx[0]?.start).toBe("2025-08-28");
  });

  it("a failing currency is reported and the others still refresh", async () => {
    const chf = toCurrency("CHF");
    fx.script.set(Currencies.USD, new SourceException("nbp", "HTTP 400 limit"));
    fx.script.set(chf, []);
    const store = new InMemoryMarketData();
    const report = await refresher.refresh(store, [], [Currencies.USD, chf, Currencies.EUR], AS_OF);
    expect(report.fx.map((f) => f.status)).toEqual([
      FetchStatus.ERROR,
      FetchStatus.NO_DATA,
      FetchStatus.OK,
    ]);
    expect(reportErrorMessages(report)).toEqual(["fx USD: nbp: HTTP 400 limit"]);
    expect(reportStats(report).fx_error).toBe(1);
    store.apply(report);
    expect(store.lastRateDate(Currencies.EUR)).toBe(AS_OF);
  });
});

// --- R6: splits with a source without split events --------------------------------------------

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
  buildInstrument({ name: "Splitter", symbol: "SPLT", mic: "XNAS", currency: Currencies.USD });

/** Unadjusted closes (400) for 2026-06-01 .. 2026-09-29, fetched before the split. */
const storeWithOldBars = (target: Instrument) =>
  new InMemoryMarketData(
    weekdayBars(target, "2026-06-01", "2026-09-29", { close: "400", fetchedAt: BEFORE_SPLIT }),
  );

describe("MarketDataRefresher: splits (R6)", () => {
  it("a split transaction after unadjusted bars refetches for a source without events", async () => {
    const splt = splitter();
    const store = storeWithOldBars(splt);
    prices.script.set("SPLT", (i, start, end) => weekdayBars(i, start, end, { close: "100" }));
    const splits = { splitDates: new Map([[splt.id, SPLIT_DAY]]) };

    const report = await refresher.refresh(store, [splt], [], AS_OF, splits);

    expect(prices.calls).toEqual([["SPLT", "2026-06-01", AS_OF]]); // straight to the full window
    const [result] = report.instruments;
    expect([result?.status, result?.refetchedForSplit]).toEqual([FetchStatus.OK, true]);
    expect(result?.message).toBe("split transaction on 2026-09-30: re-fetched the stored window");
    store.apply(report);
    expect(
      new Set([...(store.bars.get(splt.id)?.values() ?? [])].map((b) => b.close.toString())),
    ).toEqual(new Set(["100"]));

    // Bars are now fetched after the split: the same split transaction triggers nothing more.
    prices.calls.length = 0;
    await refresher.refresh(store, [splt], [], AS_OF, splits);
    expect(prices.calls).toEqual([["SPLT", AS_OF, AS_OF]]);
  });

  it("a split before every bar needs no refetch, and a failed refetch keeps the bars", async () => {
    const splt = splitter();
    await refresher.refresh(storeWithOldBars(splt), [splt], [], AS_OF, {
      splitDates: new Map([[splt.id, "2026-05-01"]]),
    });
    expect(prices.calls[0]?.[1]).toBe("2026-09-29"); // incremental only

    const fresh = splitter();
    const store = storeWithOldBars(fresh);
    prices.script.set("SPLT", () => []);
    const report = await refresher.refresh(store, [fresh], [], AS_OF, {
      splitDates: new Map([[fresh.id, SPLIT_DAY]]),
    });
    const [result] = report.instruments;
    expect(result?.status).toBe(FetchStatus.ERROR);
    expect(result?.message).toContain("returned no bars; stored bars kept");
    store.apply(report);
    expect(store.bars.get(fresh.id)?.get("2026-06-01")?.close.toString()).toBe("400");
  });

  it("a bar without a fetch time counts as fetched before the split", async () => {
    const splt = splitter();
    const store = new InMemoryMarketData(
      weekdayBars(splt, "2026-09-01", "2026-09-29", { fetchedAt: null }),
    );
    expect(store.hasBarsFetchedBefore(splt.id, SPLIT_DAY, FETCHED_AT)).toBe(true);
  });
});
