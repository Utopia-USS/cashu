import { D, parseDateTime } from "@cashu/domain";
import { Currencies, market } from "@cashu/domain/investments";
import { expect, it } from "vitest";
import { SqlPriceCache } from "./investments/local/priceCache.js";
import { defineQuery, watchQuery } from "./query.js";
import { memoryDriver, openTestStore } from "./testing/store.js";

it("watches real committed external cache changes, rolls back atomically, and tears down", () => {
  const driver = memoryDriver();
  const cache = new SqlPriceCache(driver);
  const key = market.marketSymbol("yahoo", "SYNTH.DE");
  const now = parseDateTime("2026-10-01T12:00:00Z");
  const write = (close: string) =>
    cache.upsertBars(
      key,
      [
        {
          date: "2026-10-01",
          close: D(close),
          open: null,
          high: null,
          low: null,
          volume: null,
          currency: Currencies.EUR,
          fetchedAt: null,
        },
      ],
      now,
    );
  let subscribers = 0;
  const query = defineQuery({
    id: "test.cachedClose",
    changes: {
      subscribe(listener: () => void) {
        subscribers++;
        const stop = cache.subscribe(listener);
        return () => {
          subscribers--;
          stop();
        };
      },
    },
    run: () => cache.bars(key)[0]?.close.toString() ?? null,
  });
  const store = openTestStore();
  const values: (string | null)[] = [];
  const errors: unknown[] = [];
  let initialDelivery = true;
  const stop = watchQuery(store, query, undefined, {
    onValue: (value) => {
      values.push(value);
      if (initialDelivery) {
        initialDelivery = false;
        write("9");
      }
    },
    onError: (error) => errors.push(error),
  });
  expect(subscribers).toBe(1);
  expect(values).toEqual([null, "9"]);
  cache.batch(() => {
    write("10");
    write("11");
  });
  expect(values).toEqual([null, "9", "11"]);
  expect(() =>
    cache.batch(() => {
      write("99");
      throw new Error("rollback");
    }),
  ).toThrow("rollback");
  expect(values).toEqual([null, "9", "11"]);
  expect(cache.bars(key)[0]?.close.toString()).toBe("11");
  stop();
  stop();
  expect(subscribers).toBe(0);
  write("12");
  expect(values).toEqual([null, "9", "11"]);
  expect(errors).toEqual([]);
  expect(() =>
    watchQuery(store, query, undefined, {
      onValue: () => {
        throw new Error("initial reader failed");
      },
      onError: (error) => {
        throw error;
      },
    }),
  ).toThrow("initial reader failed");
  expect(subscribers).toBe(0);
  store.close();
  driver.close();
});
