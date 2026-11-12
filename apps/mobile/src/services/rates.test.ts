// The phone's NBP refresh over a stub `fetch` (no network) into a real in-memory price cache, read
// back by the genuine net-worth hero. Every amount and rate is invented.
import { betterSqlite3Driver, recordBalance } from "@cashu/store";
import { SqlPriceCache } from "@cashu/store/investments/local";
import { runQuery } from "@cashu/store/query";
import Database from "better-sqlite3";
import {
  applyMoneyCommand,
  importMoneyFacts,
  MONEY_EURO,
  MONEY_OWN_A,
  moneyStore,
} from "../screens/testing/moneyStore";
import { createMoneyQueries } from "./moneyQueries";
import { refreshRates } from "./rates";

const TODAY = "2026-11-12";
const NOW = Date.UTC(2026, 10, 12, 13);
const NBP_EUR = JSON.stringify({
  table: "A",
  currency: "euro",
  code: "EUR",
  rates: [
    { no: "216/A/NBP/2026", effectiveDate: "2026-11-09", mid: 4.2401 },
    { no: "217/A/NBP/2026", effectiveDate: "2026-11-10", mid: 4.2386 },
  ],
});

function stubFetch(body: string | null) {
  const urls: string[] = [];
  const fetch = async (url: string) => {
    urls.push(url);
    if (body === null) throw new TypeError("Network request failed");
    return {
      status: 200,
      headers: { get: () => "application/json" },
      text: async () => body,
    };
  };
  return { urls, fetch };
}

const closers: (() => void)[] = [];
afterEach(() => {
  for (const close of closers.splice(0)) close();
});

function setup() {
  const fixture = moneyStore();
  const cacheDb = new Database(":memory:");
  closers.push(() => {
    fixture.close();
    cacheDb.close();
  });
  const pln = importMoneyFacts(fixture.a, "PLN", MONEY_OWN_A, []);
  const eur = importMoneyFacts(fixture.a, "EUR", MONEY_EURO, []);
  applyMoneyCommand(fixture.a, recordBalance, {
    account: pln,
    date: "2026-11-01",
    amount: "1000.00",
  });
  applyMoneyCommand(fixture.a, recordBalance, {
    account: eur,
    date: "2026-11-01",
    amount: "100.00",
  });
  return { store: fixture.a.store, prices: new SqlPriceCache(betterSqlite3Driver(cacheDb)) };
}

it("fills the device cache from NBP so the hero converts, and sends NBP only currency codes", async () => {
  const { store, prices } = setup();
  const hero = createMoneyQueries({ prices }).overview.hero;
  expect(runQuery(store, hero, { today: TODAY }).value.converted?.rateDate).toBeNull();

  const net = stubFetch(NBP_EUR);
  const result = await refreshRates({
    prices,
    fetch: net.fetch,
    now: () => NOW,
    today: TODAY,
    currencies: ["PLN", "EUR"],
  });
  expect(result).toEqual({ fetched: ["EUR"], skipped: null });
  // 400 days in chunks of at most 93 days; every request is the public rates path of one code.
  expect(net.urls).toHaveLength(5);
  for (const url of net.urls) {
    expect(url).toMatch(
      /^https:\/\/api\.nbp\.pl\/api\/exchangerates\/rates\/A\/eur\/\d{4}-\d{2}-\d{2}\/\d{4}-\d{2}-\d{2}\/\?format=json$/,
    );
  }
  expect(net.urls.at(-1)).toContain(`/${TODAY}/`);

  const converted = runQuery(store, hero, { today: TODAY }).value.converted;
  expect(converted?.rateDate).toBe("2026-11-10");
  expect(converted?.net.toString()).toBe("1423.86");
  expect(converted?.parts.map((p) => [p.currency, p.amount.toString()])).toEqual([
    ["EUR", "100.00"],
  ]);
});

it("skips a fresh currency and reports a failed request as offline without throwing", async () => {
  const { prices } = setup();
  await refreshRates({
    prices,
    fetch: stubFetch(NBP_EUR).fetch,
    now: () => NOW,
    today: TODAY,
    currencies: ["EUR"],
  });
  const again = stubFetch(NBP_EUR);
  expect(
    await refreshRates({
      prices,
      fetch: again.fetch,
      now: () => NOW,
      today: "2026-11-13",
      currencies: ["EUR", "PLN"],
    }),
  ).toEqual({ fetched: [], skipped: "fresh" });
  expect(again.urls).toEqual([]);

  const offline = stubFetch(null);
  expect(
    await refreshRates({
      prices,
      fetch: offline.fetch,
      now: () => NOW,
      today: "2026-11-20",
      currencies: ["EUR", "USD"],
    }),
  ).toEqual({ fetched: [], skipped: "offline" });
  // The next fetch of a stale currency starts the day after its newest cached table.
  expect(offline.urls[0]).toContain("/eur/2026-11-11/2026-11-20/");
});
