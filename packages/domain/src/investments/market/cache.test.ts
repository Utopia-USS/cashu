// The device's price cache keyed by provider + market symbol (lead decision 2026-10-31): shared by every
// profile's copy of an instrument, the per-instrument view the refresher plans against, and the report
// write semantics (`store/market.py` upsert_bars / apply_fetch_report, `InMemoryMarketData.apply`).

import { describe, expect, it } from "vitest";
import type { DateTime } from "../../dates.js";
import { instrumentAlias } from "../domain/instrument.js";
import { fxRate, priceBar } from "../domain/marketData.js";
import { Currencies } from "../domain/values.js";
import {
  applyFetchReport,
  type CachedBar,
  cachedMarketData,
  InMemoryPriceCache,
  marketSymbol,
  marketSymbolKey,
  marketSymbolsOf,
} from "./cache.js";
import { FetchStatus, fetchReport, fxFetch, instrumentFetch } from "./fetchReport.js";
import { buildInstrument, d, orlen, vwce, weekdayBars } from "./testing/support.js";

const at = (date: string, hour: number): DateTime => ({
  date,
  hour,
  minute: 0,
  second: 0,
  microsecond: 0,
  offsetSeconds: 0,
});
const NOW = at("2026-10-02", 18);

const cached = (date: string, close: string, fields: Partial<CachedBar> = {}): CachedBar => ({
  date,
  close: d(close),
  open: null,
  high: null,
  low: null,
  volume: null,
  currency: null,
  fetchedAt: null,
  ...fields,
});

describe("market symbols", () => {
  it("an instrument's keys are its provider aliases, a confirmed alias over a guess", () => {
    const pkn = orlen([
      instrumentAlias("yahoo", "PKN.GUESS", true),
      instrumentAlias("yahoo", "PKN.WA"),
      instrumentAlias("stooq", "pkn"),
    ]);
    expect(marketSymbolsOf(pkn).map(marketSymbolKey)).toEqual(["yahoo:PKN.WA", "stooq:pkn"]);
    expect(
      marketSymbolsOf(buildInstrument({ aliases: [instrumentAlias("isin", "PL0000000000")] })),
    ).toEqual([]);
  });
});

describe("InMemoryPriceCache", () => {
  it("bumps its version on every write, never on a read", () => {
    const cache = new InMemoryPriceCache();
    const key = marketSymbol("yahoo", "XMPL");
    expect(cache.version()).toBe(0);
    cache.upsertBars(key, [cached("2026-10-02", "100")], NOW);
    cache.bars(key);
    expect(cache.version()).toBe(1);
    cache.deleteBars(key, "2026-10-01", "2026-10-03");
    cache.upsertRates("nbp", Currencies.USD, [], NOW);
    expect(cache.version()).toBe(3);
  });

  it("a close-only bar keeps the stored open / high / low / volume; a missing fetch time becomes now", () => {
    const cache = new InMemoryPriceCache();
    const key = marketSymbol("yahoo", "XMPL");
    cache.upsertBars(
      key,
      [cached("2026-10-02", "100", { open: d("99"), high: d("101"), low: d("98"), volume: 5 })],
      at("2026-10-02", 7),
    );
    cache.upsertBars(key, [cached("2026-10-02", "102", { currency: Currencies.USD })], NOW);
    const [bar] = cache.bars(key);
    expect(bar?.close.toString()).toBe("102");
    expect([
      bar?.open?.toString(),
      bar?.high?.toString(),
      bar?.low?.toString(),
      bar?.volume,
    ]).toEqual(["99", "101", "98", 5]);
    expect(bar?.currency).toBe(Currencies.USD);
    expect(bar?.fetchedAt).toEqual(NOW);
  });

  it("deleteBars removes a window; rates key by provider and quote", () => {
    const cache = new InMemoryPriceCache();
    const key = marketSymbol("stooq", "pkn");
    cache.upsertBars(
      key,
      ["2026-09-29", "2026-09-30", "2026-10-01"].map((on) => cached(on, "1")),
      NOW,
    );
    cache.deleteBars(key, "2026-09-30", "2026-10-01");
    expect(cache.bars(key).map((b) => b.date)).toEqual(["2026-09-29"]);
    cache.upsertRates(
      "nbp",
      Currencies.USD,
      [{ date: "2026-10-01", rate: d("3.9"), fetchedAt: null }],
      NOW,
    );
    expect(cache.rates("nbp", Currencies.USD)[0]?.fetchedAt).toEqual(NOW);
    expect(cache.rates("nbp", Currencies.EUR)).toEqual([]);
  });
});

describe("the cache is shared by every profile's copy of an instrument", () => {
  it("a report written for one vault's instrument serves another vault's instrument with the same symbol", () => {
    const cache = new InMemoryPriceCache();
    const annas = vwce();
    const piotrs = vwce(); // the same listing in another vault: another instrument id
    const report = fetchReport("2026-10-02", [
      instrumentFetch({
        instrumentId: annas.id,
        label: "VWCE",
        status: FetchStatus.OK,
        start: "2026-09-28",
        end: "2026-10-02",
        bars: weekdayBars(annas, "2026-09-28", "2026-10-02", { close: "120" }),
        source: "yahoo",
      }),
    ]);
    expect(applyFetchReport(cache, report, [annas], NOW)).toEqual({
      bars: 5,
      rates: 0,
      unkeyed: 0,
    });

    const view = cachedMarketData(cache, [piotrs]);
    expect(view.lastBarDate(piotrs.id)).toBe("2026-10-02");
    expect(view.firstBarDate(piotrs.id)).toBe("2026-09-28");
    expect(
      view.series(piotrs.id).every((b) => b.instrumentId === piotrs.id && b.source === "yahoo"),
    ).toBe(true);
    expect(cache.bars(marketSymbol("yahoo", "VWCE.DE"))).toHaveLength(5);
  });
});

describe("the per-instrument view", () => {
  it("the newest-fetched bar wins a day across providers; ties go by the source order", () => {
    const cache = new InMemoryPriceCache();
    const pkn = orlen(); // XWAR: stooq first
    cache.upsertBars(
      marketSymbol("stooq", "pkn"),
      [cached("2026-10-01", "60"), cached("2026-10-02", "61")],
      at("2026-10-02", 8),
    );
    cache.upsertBars(
      marketSymbol("yahoo", "PKN.WA"),
      [cached("2026-10-02", "62")],
      at("2026-10-02", 9),
    );
    cache.upsertBars(
      marketSymbol("yahoo", "PKN.WA"),
      [cached("2026-10-01", "59")],
      at("2026-10-02", 8),
    );
    const series = cachedMarketData(cache, [pkn]).series(pkn.id);
    expect(series.map((b) => [b.date, b.close.toString(), b.source])).toEqual([
      ["2026-10-01", "60", "stooq"],
      ["2026-10-02", "62", "yahoo"],
    ]);
  });

  it("plans the split check and FX like the store", () => {
    const cache = new InMemoryPriceCache();
    const pkn = orlen();
    cache.upsertBars(
      marketSymbol("stooq", "pkn"),
      [cached("2026-09-01", "400")],
      at("2026-09-01", 18),
    );
    cache.upsertRates(
      "nbp",
      Currencies.USD,
      [{ date: "2026-09-30", rate: d("3.9"), fetchedAt: null }],
      NOW,
    );
    const view = cachedMarketData(cache, [pkn]);
    expect(view.hasBarsFetchedBefore(pkn.id, "2026-09-30", at("2026-10-01", 0))).toBe(true);
    expect(view.hasBarsFetchedBefore(pkn.id, "2026-09-01", at("2026-10-01", 0))).toBe(false);
    expect(view.lastRateDate(Currencies.USD)).toBe("2026-09-30");
    expect(view.hasRateOnOrBefore(Currencies.USD, "2026-09-29")).toBe(false);
    expect(view.fxRates(Currencies.USD)[0]).toEqual(
      fxRate({
        quote: Currencies.USD,
        date: "2026-09-30",
        rate: d("3.9"),
        source: "nbp",
        fetchedAt: NOW,
      }),
    );
    expect(view.lastBarDate(vwce().id)).toBeNull(); // not listed in the view
  });
});

describe("applyFetchReport", () => {
  it("a split re-fetch deletes the window in every market symbol of the instrument, then upserts", () => {
    const cache = new InMemoryPriceCache();
    const pkn = orlen();
    cache.upsertBars(
      marketSymbol("stooq", "pkn"),
      [cached("2026-09-29", "400"), cached("2026-05-01", "380")],
      NOW,
    );
    cache.upsertBars(marketSymbol("yahoo", "PKN.WA"), [cached("2026-09-29", "400")], NOW);
    const report = fetchReport("2026-10-02", [
      instrumentFetch({
        instrumentId: pkn.id,
        label: "PKN",
        status: FetchStatus.OK,
        start: "2026-06-01",
        end: "2026-10-02",
        bars: [
          priceBar({ instrumentId: pkn.id, date: "2026-10-01", close: d("100"), source: "yahoo" }),
        ],
        replaceFrom: "2026-06-01",
        refetchedForSplit: true,
      }),
    ]);
    applyFetchReport(cache, report, [pkn], NOW);
    expect(cache.bars(marketSymbol("stooq", "pkn")).map((b) => b.date)).toEqual(["2026-05-01"]);
    expect(
      cache.bars(marketSymbol("yahoo", "PKN.WA")).map((b) => [b.date, b.close.toString()]),
    ).toEqual([["2026-10-01", "100"]]);
  });

  it("bars of a source the instrument has no alias for are counted, not stored; PLN rates upsert", () => {
    const cache = new InMemoryPriceCache();
    const bare = buildInstrument({ aliases: [] });
    const report = fetchReport(
      "2026-10-02",
      [
        instrumentFetch({
          instrumentId: bare.id,
          label: "PKN",
          status: FetchStatus.OK,
          bars: weekdayBars(bare, "2026-10-01", "2026-10-02"),
        }),
      ],
      [
        fxFetch({
          currency: Currencies.USD,
          status: FetchStatus.OK,
          rates: [
            fxRate({ quote: Currencies.USD, date: "2026-10-01", rate: d("3.9"), source: "nbp" }),
          ],
        }),
      ],
    );
    expect(applyFetchReport(cache, report, [bare], NOW)).toEqual({ bars: 0, rates: 1, unkeyed: 2 });
    expect(cache.rates("nbp", Currencies.USD).map((r) => r.rate.toString())).toEqual(["3.9"]);
  });
});
