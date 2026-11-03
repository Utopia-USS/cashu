import { D, parseDateTime } from "@cashu/domain";
import { Currencies } from "@cashu/domain/investments";
import { betterSqlite3Driver, investmentsLocal } from "@cashu/store";
import { defineQuery } from "@cashu/store/query";
import Database from "better-sqlite3";
import { expect, it } from "vitest";
import { memoryStores, VAULT_A } from "../testing/memory.js";
import { createSyncClient } from "./sync.js";

it("the synchronous consumer wakes for committed cache changes and shares equal snapshots", () => {
  const stores = memoryStores();
  const driver = betterSqlite3Driver(new Database(":memory:"));
  const prices = new investmentsLocal.SqlPriceCache(driver);
  const query = defineQuery({
    id: "test.fxPresent",
    changes: prices,
    run: () => prices.rates("nbp", Currencies.EUR).length,
  });
  const client = createSyncClient(stores, { lingerMs: 0 });
  const entry = client.entry({ kind: "vault", vault: VAULT_A }, query, undefined);
  let delivered = 0;
  const stop = entry.subscribe(() => {
    delivered++;
  });
  const first = entry.getSnapshot();
  const now = parseDateTime("2026-10-01T12:00:00Z");
  prices.upsertRates("nbp", Currencies.EUR, [], now);
  expect(entry.getSnapshot()).toBe(first);
  expect(delivered).toBe(0);
  prices.upsertRates(
    "nbp",
    Currencies.EUR,
    [{ date: "2026-10-01", rate: D("4.2"), fetchedAt: null }],
    now,
  );
  expect(entry.getSnapshot()).toEqual({ status: "value", value: 1 });
  expect(delivered).toBe(1);
  const changed = entry.getSnapshot();
  expect(() =>
    prices.batch(() => {
      prices.upsertRates("nbp", Currencies.EUR, [], now);
      throw new Error("rollback");
    }),
  ).toThrow("rollback");
  expect(entry.getSnapshot()).toBe(changed);
  stop();
  client.dispose();
  prices.upsertRates("nbp", Currencies.EUR, [], now);
  expect(delivered).toBe(1);
  stores.close();
  driver.close();
});
