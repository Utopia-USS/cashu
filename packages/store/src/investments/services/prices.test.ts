import { D, parseDateTime } from "@cashu/domain";
import {
  asInstrumentId,
  Currencies,
  fxRate,
  instrument,
  market,
  priceBar,
} from "@cashu/domain/investments";
import { expect, it } from "vitest";
import type { PriceNeeds } from "./priceNeeds.js";
import { DailyPriceLock, PricesService, type PriceVault, refreshPriceNeeds } from "./prices.js";

const now = parseDateTime("2025-09-30T12:00:00+00:00");
const asOf = "2025-09-30";
function subject(id: string, symbol: string) {
  return instrument({
    id: asInstrumentId(id),
    name: symbol,
    currency: Currencies.PLN,
    assetClass: "equity",
    aliases: [{ namespace: "yahoo", value: symbol, guessed: false }],
  });
}
function needs(i: ReturnType<typeof subject>): PriceNeeds {
  return {
    instruments: new Map([[i.id, i]]),
    watched: new Map(),
    currencies: new Set(),
    fxHistoryFrom: new Map(),
    splitDates: new Map(),
  };
}
const fxSource: market.FxSource = {
  id: "nbp",
  async rates() {
    return [];
  },
};
it("deduplicates shared aliases and preserves vault ids; refused vault cannot authorize exclusive requests", async () => {
  const prices = new market.InMemoryPriceCache();
  const a = subject("a", "SHARED");
  const b = subject("b", "SHARED");
  const secret = subject("c", "EXCLUSIVE");
  const calls: string[] = [];
  const priceSource: market.PriceSource = {
    id: "yahoo",
    async fetch(i) {
      calls.push(i.aliases[0]?.value ?? "");
      return market.priceHistory({
        bars: [
          priceBar({
            instrumentId: i.id,
            date: asOf,
            close: D("5"),
            currency: i.currency,
            source: "yahoo",
          }),
        ],
      });
    },
  };
  const out = await refreshPriceNeeds({
    prices,
    priceSource,
    fxSource,
    asOf,
    now,
    vaults: [
      { vault: "a", needs: needs(a), authority: { isHolder: () => true } },
      { vault: "b", needs: needs(b), authority: { isHolder: () => true } },
      { vault: "c", needs: needs(secret), authority: null },
    ],
  });
  expect(calls).toEqual(["SHARED"]);
  expect(out.reports.get("a")?.instruments[0]?.instrumentId).toBe(a.id);
  expect(out.reports.get("b")?.instruments[0]?.bars[0]?.instrumentId).toBe(b.id);
  expect(out.refused).toEqual(["c"]);
});
it("refuses cache effects after lease loss during network await", async () => {
  let holder = true;
  const prices = new market.InMemoryPriceCache();
  const priceSource: market.PriceSource = {
    id: "yahoo",
    async fetch(i) {
      holder = false;
      return market.priceHistory({
        bars: [
          priceBar({
            instrumentId: i.id,
            date: asOf,
            close: D("5"),
            currency: i.currency,
            source: "yahoo",
          }),
        ],
      });
    },
  };
  const out = await refreshPriceNeeds({
    prices,
    priceSource,
    fxSource,
    asOf,
    now,
    vaults: [
      { vault: "a", needs: needs(subject("a", "DEMO")), authority: { isHolder: () => holder } },
    ],
  });
  expect(prices.version()).toBe(0);
  expect(out.refused).toEqual(["a"]);
});
it("passes each grouped instrument's consumers into nested source request guards", async () => {
  let bHolder = true;
  const checked: [string, boolean][] = [];
  const empty: market.PriceSource = { id: "fallback", fetch: async () => market.priceHistory() };
  await refreshPriceNeeds({
    prices: new market.InMemoryPriceCache(),
    priceSource: empty,
    fxSource,
    asOf,
    now,
    vaults: [
      { vault: "a", needs: needs(subject("a", "A")), authority: { isHolder: () => true } },
      { vault: "b", needs: needs(subject("b", "B")), authority: { isHolder: () => bHolder } },
    ],
    scoped: (allowed) => ({
      priceSource: {
        id: "scoped",
        async fetch(i) {
          const symbol = i.aliases[0]?.value ?? "";
          if (symbol === "B") bHolder = false;
          checked.push([symbol, allowed()]);
          return market.priceHistory();
        },
      },
      fxSource,
    }),
  });
  expect(checked).toContainEqual(["A", true]);
  expect(checked).toContainEqual(["B", false]);
});
it("keeps the five-minute throttle separate from force and the shared daily lock", async () => {
  const lock = new DailyPriceLock();
  const service = new PricesService(lock);
  const prices = new market.InMemoryPriceCache();
  let calls = 0;
  const priceSource: market.PriceSource = {
    id: "yahoo",
    async fetch() {
      calls++;
      return market.priceHistory();
    },
  };
  const vault: PriceVault = {
    vault: "a",
    needs: needs(subject("a", "DEMO")),
    authority: { isHolder: () => true },
  };
  let time = now;
  const deps = {
    prices,
    priceSource,
    fxSource,
    asOf,
    clock: () => time,
    close: () => {},
    vault,
    enabled: true,
  };
  expect((await service.run(deps)).status).toBe("ok");
  time = parseDateTime("2025-09-30T12:04:59+00:00");
  expect((await service.run(deps)).cached).toBe(true);
  expect(calls).toBe(1);
  const release = lock.tryAcquire();
  expect((await service.run({ ...deps, force: true })).status).toBe("busy");
  release?.();
  time = parseDateTime("2025-09-30T12:05:00+00:00");
  await service.run(deps);
  expect(calls).toBe(2);
});
it("keeps every same-market subject and each vault label instead of overwriting one", async () => {
  const first = subject("a", "SHARED"),
    second = { ...subject("b", "SHARED"), symbol: "SECOND" };
  const own = {
    ...needs(first),
    instruments: new Map([
      [first.id, first],
      [second.id, second],
    ]),
  };
  const out = await refreshPriceNeeds({
    prices: new market.InMemoryPriceCache(),
    fxSource,
    asOf,
    now,
    priceSource: {
      id: "yahoo",
      async fetch() {
        return market.priceHistory();
      },
    },
    vaults: [{ vault: "a", needs: own, authority: { isHolder: () => true } }],
  });
  expect(out.reports.get("a")?.instruments.map((i) => [i.instrumentId, i.label])).toEqual([
    [first.id, first.name],
    [second.id, "SECOND"],
  ]);
});
it("classifies all errors as failed, records completion time, and closes the source", async () => {
  const service = new PricesService(new DailyPriceLock());
  let time = now;
  let closes = 0;
  const run = () =>
    service.run({
      prices: new market.InMemoryPriceCache(),
      fxSource,
      asOf,
      clock: () => time,
      close: () => {
        closes++;
      },
      enabled: true,
      vault: {
        vault: "a",
        needs: needs(subject("a", "BROKEN")),
        authority: { isHolder: () => true },
      },
      priceSource: {
        id: "yahoo",
        async fetch() {
          time = parseDateTime("2025-09-30T12:05:00Z");
          throw new Error("offline");
        },
      },
    });
  const first = await run();
  expect(first.status).toBe("failed");
  expect(first.errors).toHaveLength(1);
  expect(first.updated).toBe(0);
  expect(first.finishedAt).toBe(Date.parse("2025-09-30T12:05:00Z"));
  expect(closes).toBe(1);
  time = parseDateTime("2025-09-30T12:09:59Z");
  expect((await run()).cached).toBe(true);
  expect(closes).toBe(1);
});
it("batches one FX table request and prices-only avoids historical lot backfill", async () => {
  const prices = new market.InMemoryPriceCache();
  prices.upsertRates(
    "nbp",
    Currencies.EUR,
    [{ date: "2025-09-29", rate: D("4"), fetchedAt: null }],
    now,
  );
  prices.upsertRates(
    "nbp",
    Currencies.USD,
    [{ date: "2025-09-29", rate: D("3"), fetchedAt: null }],
    now,
  );
  const n = {
    ...needs(subject("a", "DEMO")),
    currencies: new Set([Currencies.EUR, Currencies.USD]),
    fxHistoryFrom: new Map([[Currencies.EUR, "2024-01-01"]]),
  };
  let tables = 0;
  let fallback = 0;
  const tableFx: market.TableFxSource = {
    maxDaysPerRequest: 93,
    async tableRates() {
      tables++;
      return new Map(
        [Currencies.EUR, Currencies.USD].map((quote) => [
          quote,
          [fxRate({ quote, date: asOf, rate: D("4"), source: "nbp" })],
        ]),
      );
    },
  };
  const result = await new PricesService(new DailyPriceLock()).run({
    prices,
    asOf,
    clock: () => now,
    close: () => {},
    enabled: true,
    vault: { vault: "a", needs: n, authority: { isHolder: () => true } },
    tableFx,
    fxSource: {
      id: "nbp",
      async rates() {
        fallback++;
        return [];
      },
    },
    priceSource: {
      id: "yahoo",
      async fetch() {
        return market.priceHistory();
      },
    },
  });
  expect(tables).toBe(1);
  expect(fallback).toBe(0);
  expect(result.fxUpdated).toBe(2);
  expect(result.refresh?.requests.fxTables).toBe(1);
});
it("keeps MIC-dependent provider ordering in separate request groups", async () => {
  const a = { ...subject("a", "SAME"), mic: "XWAR" },
    b = { ...subject("b", "SAME"), mic: "XETR" };
  const seen: string[][] = [];
  await refreshPriceNeeds({
    prices: new market.InMemoryPriceCache(),
    fxSource,
    asOf,
    now,
    priceSource: {
      id: "composite",
      async fetch(i) {
        seen.push([...market.defaultPriceSourceOrder(i)]);
        return market.priceHistory();
      },
    },
    vaults: [
      { vault: "a", needs: needs(a), authority: { isHolder: () => true } },
      { vault: "b", needs: needs(b), authority: { isHolder: () => true } },
    ],
  });
  expect(seen).toEqual([
    ["stooq", "yahoo"],
    ["yahoo", "stooq"],
  ]);
});
it("applies split re-fetch deletion to every provider before adjusted history is written", async () => {
  const prices = new market.InMemoryPriceCache();
  const i = {
    ...subject("a", "SPLIT"),
    aliases: [
      { namespace: "yahoo", value: "SPLIT", guessed: false },
      { namespace: "stooq", value: "split", guessed: false },
    ],
  };
  const old = parseDateTime("2025-09-01T12:00:00Z");
  const cached = {
    date: "2025-09-01",
    close: D("100"),
    open: D("90"),
    high: D("110"),
    low: D("80"),
    volume: 10,
    currency: Currencies.PLN,
    fetchedAt: old,
  };
  prices.upsertBars(market.marketSymbol("yahoo", "SPLIT"), [cached], old);
  prices.upsertBars(market.marketSymbol("stooq", "split"), [cached], old);
  const out = await refreshPriceNeeds({
    prices,
    fxSource,
    asOf,
    now,
    vaults: [{ vault: "a", needs: needs(i), authority: { isHolder: () => true } }],
    priceSource: {
      id: "yahoo",
      async fetch(subject) {
        return market.priceHistory({
          bars: [
            priceBar({
              instrumentId: subject.id,
              date: asOf,
              close: D("50"),
              currency: Currencies.PLN,
              source: "yahoo",
            }),
          ],
          splits: [{ date: asOf, ratio: D("2") }],
        });
      },
    },
  });
  expect(out.reports.get("a")?.instruments[0]?.replaceFrom).toBe("2025-09-01");
  expect(prices.bars(market.marketSymbol("stooq", "split"))).toEqual([]);
  expect(prices.bars(market.marketSymbol("yahoo", "SPLIT"))).toHaveLength(1);
});
it("keeps a shared request alive for its remaining consumer but refuses the lost consumer's unique key", async () => {
  let firstHolder = true;
  const calls: string[] = [];
  const a = subject("a", "SHARED"),
    b = subject("b", "SHARED"),
    unique = subject("c", "UNIQUE");
  const prices = new market.InMemoryPriceCache();
  const own = {
    ...needs(a),
    instruments: new Map([
      [a.id, a],
      [unique.id, unique],
    ]),
  };
  const out = await refreshPriceNeeds({
    prices,
    fxSource,
    asOf,
    now,
    priceSource: {
      id: "yahoo",
      async fetch(i) {
        calls.push(i.name);
        firstHolder = false;
        return market.priceHistory({
          bars: [
            priceBar({
              instrumentId: i.id,
              date: asOf,
              close: D("5"),
              currency: i.currency,
              source: "yahoo",
            }),
          ],
        });
      },
    },
    vaults: [
      { vault: "a", needs: own, authority: { isHolder: () => firstHolder } },
      { vault: "b", needs: needs(b), authority: { isHolder: () => true } },
    ],
  });
  expect(calls).toEqual(["SHARED"]);
  expect(out.refused).toEqual(["a"]);
  expect(out.reports.get("b")?.instruments[0]?.bars).toHaveLength(1);
  expect(prices.bars(market.marketSymbol("yahoo", "SHARED"))).toHaveLength(1);
  expect(prices.bars(market.marketSymbol("yahoo", "UNIQUE"))).toEqual([]);
});
