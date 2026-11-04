import { D, parseDateTime } from "@cashu/domain";
import { Currencies, market } from "@cashu/domain/investments";
import { describe, expect, it } from "vitest";
import type { SourceCacheReceipt } from "../../genesis/verification/sourceCache.js";
import { memoryDriver } from "../../testing/store.js";
import { vault } from "../commands/testing/fixtures.js";
import { PerformanceService } from "../performance/service.js";
import { AS_OF, household, NO_STRATEGY } from "../performance/testing/household.js";
import { SqlPriceCache } from "./priceCache.js";

const now = parseDateTime("2025-09-30T12:00:00+00:00");
const bar = (close = "10"): market.CachedBar => ({
  date: AS_OF,
  close: D(close),
  open: null,
  high: null,
  low: null,
  volume: null,
  currency: Currencies.EUR,
  fetchedAt: null,
});
describe("device-local SQL market cache", () => {
  it("persists monotonic versions across reopen, including empty writes and deletes, and isolates provider keys", () => {
    const driver = memoryDriver();
    const cache = new SqlPriceCache(driver);
    const key = market.marketSymbol("yahoo", "DEMO.DE");
    let observed = 0;
    cache.subscribe(() => {
      observed = cache.version();
    });
    cache.subscribe(() => {
      throw new Error("observer");
    });
    cache.upsertBars(key, [{ ...bar(), open: D("8"), high: D("12"), low: D("7"), volume: 3 }], now);
    cache.upsertBars(key, [bar("11")], now);
    expect(cache.bars(key)[0]).toMatchObject({
      open: D("8"),
      high: D("12"),
      low: D("7"),
      volume: 3,
      close: D("11"),
      fetchedAt: { ...now, offsetSeconds: null },
    });
    cache.upsertBars(market.marketSymbol("stooq", "DEMO.DE"), [bar("20")], now);
    expect(cache.bars(key)[0]?.close.toString()).toBe("11");
    cache.upsertBars(key, [], now);
    cache.deleteBars(key, "2024-01-01", "2024-01-02");
    cache.upsertRates("nbp", Currencies.EUR, [], now);
    expect(observed).toBe(6);
    const reopened = new SqlPriceCache(driver);
    expect(reopened.version()).toBe(6);
    reopened.upsertRates(
      "nbp",
      Currencies.EUR,
      [{ date: AS_OF, rate: D("4"), fetchedAt: null }],
      now,
    );
    expect(reopened.version()).toBe(7);
    expect(reopened.newestFxDate()).toBe(AS_OF);
    reopened.deleteBars(key, AS_OF, AS_OF);
    expect(reopened.bars(key)).toEqual([]);
    expect(reopened.bars(market.marketSymbol("stooq", "DEMO.DE"))).toHaveLength(1);
    driver.close();
  });
  it("invalidates the real portfolio performance after a cache mutation", () => {
    const v = vault();
    household(v);
    const driver = memoryDriver();
    const prices = new SqlPriceCache(driver);
    prices.upsertRates(
      "nbp",
      Currencies.EUR,
      [{ date: AS_OF, rate: D("4.3"), fetchedAt: null }],
      now,
    );
    const service = new PerformanceService();
    const request = { asOf: AS_OF, strategy: NO_STRATEGY, prices };
    const first = service.computed(v.store, request);
    const before = service.performanceView(v.store, { ...request, range: "max" });
    expect(service.computed(v.store, request)).toBe(first);
    prices.upsertBars(market.marketSymbol("yahoo", "WRLD.DE"), [bar("200")], now);
    const second = service.computed(v.store, request);
    const after = service.performanceView(v.store, { ...request, range: "max" });
    if (!before.ok || !after.ok) throw new Error("performance unavailable");
    expect(after.value.summary?.end_value).toBeGreaterThan(before.value.summary?.end_value ?? 0);
    expect(second).not.toBe(first);
    expect(service.computed(v.store, request)).toBe(second);
    driver.close();
    v.store.close();
  });
});
it("rolls back split-window replacement and versions atomically, publishing only after outer commit", () => {
  const driver = memoryDriver();
  const cache = new SqlPriceCache(driver);
  const key = market.marketSymbol("yahoo", "SPLIT");
  cache.upsertBars(key, [bar()], now);
  const version = cache.version();
  let notifications = 0;
  let observed: { version: number; close: string | undefined } | undefined;
  cache.subscribe(() => {
    notifications++;
    observed = { version: cache.version(), close: cache.bars(key)[0]?.close.toString() };
  });
  expect(() =>
    cache.batch(() => {
      cache.deleteBars(key, AS_OF, AS_OF);
      cache.upsertBars(key, [bar("20")], now);
      throw new Error("write failed");
    }),
  ).toThrow("write failed");
  expect(cache.version()).toBe(version);
  expect(cache.bars(key)[0]?.close.toString()).toBe("10");
  expect(notifications).toBe(0);
  cache.batch(() => {
    cache.deleteBars(key, AS_OF, AS_OF);
    cache.upsertBars(key, [bar("20")], now);
  });
  expect(cache.version()).toBe(version + 2);
  expect(notifications).toBe(1);
  expect(observed).toEqual({ version: version + 2, close: "20" });
  driver.close();
});

it("masks imported split-window bars while preserving exact source rows and unrelated providers", () => {
  const driver = memoryDriver();
  const cache = new SqlPriceCache(driver);
  const receipt: SourceCacheReceipt = {
    format: 1,
    schema: "0029_sync_inbound",
    priceBars: [
      {
        id: 1,
        instrumentId: 1,
        date: "2025-09-29",
        close: "10",
        open: null,
        high: null,
        low: null,
        volume: null,
        currency: "EUR",
        source: "yahoo",
        fetchedAt: null,
      },
      {
        id: 2,
        instrumentId: 1,
        date: "2025-09-30",
        close: "20",
        open: null,
        high: null,
        low: null,
        volume: null,
        currency: "EUR",
        source: "yahoo",
        fetchedAt: null,
      },
      {
        id: 3,
        instrumentId: 1,
        date: "2025-09-29",
        close: "30",
        open: null,
        high: null,
        low: null,
        volume: null,
        currency: "EUR",
        source: "stooq",
        fetchedAt: null,
      },
      {
        id: 4,
        instrumentId: 2,
        date: "2025-09-29",
        close: "40",
        open: null,
        high: null,
        low: null,
        volume: null,
        currency: "EUR",
        source: "yahoo",
        fetchedAt: null,
      },
    ],
    fxRates: [],
    macroBars: [],
  };
  cache.restoreSourceCache(
    receipt,
    [
      { instrumentId: 1, vault: "vault", gid: "gid1" },
      { instrumentId: 2, vault: "vault", gid: "gid2" },
    ],
    [
      { instrumentId: 1, provider: "yahoo", symbol: "SPLIT" },
      { instrumentId: 1, provider: "stooq", symbol: "SPLIT" },
      { instrumentId: 2, provider: "yahoo", symbol: "OTHER" },
    ],
  );
  const key = market.marketSymbol("yahoo", "SPLIT");
  expect(cache.bars(key)).toHaveLength(2);
  cache.batch(() => {
    cache.deleteBars(key, "2025-09-29", "2025-09-30");
    cache.upsertBars(key, [bar("25")], now);
  });
  expect(cache.bars(key).map((row) => [row.date, row.close.toString()])).toEqual([[AS_OF, "25"]]);
  expect(cache.bars(market.marketSymbol("stooq", "SPLIT"))[0]?.close.toString()).toBe("30");
  expect(cache.bars(market.marketSymbol("yahoo", "OTHER"))[0]?.close.toString()).toBe("40");
  expect(cache.sourceCacheRows(receipt.schema).priceBars).toEqual(receipt.priceBars);
  expect(new SqlPriceCache(driver).bars(key)).toHaveLength(1);
  driver.close();
});
