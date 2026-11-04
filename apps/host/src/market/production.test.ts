import { D, parseDateTime } from "@cashu/domain";
import { asInstrumentId, Currencies, instrument, market } from "@cashu/domain/investments";
import { openNodeSqlite } from "@cashu/node-host/sqlite";
import { afterEach, expect, it } from "vitest";
import type { OpenVault } from "../stores.js";
import { createProductionMarket } from "./production.js";

const drivers: ReturnType<typeof openNodeSqlite>[] = [];
afterEach(() => {
  for (const driver of drivers.splice(0)) driver.close();
});

it("shares the versioned native cache and refuses network or cache effects after exact holder loss", async () => {
  const driver = openNodeSqlite(":memory:");
  drivers.push(driver);
  const id = "a".repeat(32);
  let holder = false;
  let current = true;
  let requests = 0;
  let complete: (() => void) | undefined;
  const pending = new Promise<void>((resolve) => {
    complete = resolve;
  });
  const vault = {
    id,
    mode: "native",
    native: {
      canFetchPublicMarket: () => holder,
      beginFetch: () => () => {},
      blobPublication: () => null,
    },
  } as OpenVault;
  const stores = {
    device: { driver },
    vaults: new Map([[id, vault]]),
  };
  const bound = createProductionMarket({
    stores,
    isCurrent: (candidate) => current && candidate === vault,
    now: () => Date.UTC(2026, 9, 31, 12),
    fetch: async () => {
      requests++;
      await pending;
      return {
        status: 200,
        headers: { get: () => null },
        text: async () => JSON.stringify({ quotes: [] }),
      };
    },
  });
  const read = ((sql: string) =>
    sql === "SELECT gid FROM profiles" ? [{ gid: id }] : []) as never;
  const firstImage = bound.market.current(read);
  expect(firstImage).toMatchObject({ marketData: { version: 0 } });
  expect(bound.market.current(read)?.marketData?.data).toBe(firstImage?.marketData?.data);
  expect(() => bound.sources([id])).toThrow("market_fetch_authority_unavailable");
  holder = true;
  const capabilities = bound.investmentAsync(id);
  expect(capabilities?.search).toBeDefined();
  const waiting = capabilities?.search?.remoteHits("test", new AbortController().signal);
  while (requests === 0) await Promise.resolve();
  holder = false;
  complete?.();
  await expect(waiting).rejects.toThrow("inactive search capability");
  expect(() =>
    capabilities?.watch?.publishBars?.(
      market.marketSymbol("yahoo", "TEST"),
      [
        {
          date: "2026-10-31",
          close: D("10"),
          open: null,
          high: null,
          low: null,
          volume: null,
          currency: Currencies.USD,
          fetchedAt: null,
        },
      ],
      parseDateTime("2026-10-31T12:00:00Z"),
    ),
  ).toThrow("market_cache_authority_unavailable");
  expect(bound.prices.version()).toBe(0);
  current = false;
  expect(bound.market.current((() => [{ gid: id }]) as never)).toBeNull();
  bound.close();
  expect(bound.investmentAsync(id)).toBeUndefined();
});

it("stops a selected vault's next HTTP request when only an unrelated vault remains holder", async () => {
  const driver = openNodeSqlite(":memory:");
  drivers.push(driver);
  const a = "a".repeat(32),
    b = "b".repeat(32);
  let bHolder = true;
  let requests = 0;
  const vault = (id: string, holder: () => boolean) =>
    ({
      id,
      mode: "native",
      native: {
        canFetchPublicMarket: holder,
        beginFetch: () => () => {},
        blobPublication: () => null,
      },
    }) as OpenVault;
  const first = vault(a, () => true),
    second = vault(b, () => bHolder);
  const bound = createProductionMarket({
    stores: {
      device: { driver },
      vaults: new Map([
        [a, first],
        [b, second],
      ]),
    },
    isCurrent: () => true,
    now: () => Date.UTC(2026, 9, 31, 12),
    sleep: async () => {},
    fetch: async () => {
      requests += 1;
      return { status: 404, headers: { get: () => null }, text: async () => "" };
    },
  });
  const source = bound.sources([b]);
  await source.fxSource.rates(Currencies.EUR, "2026-10-31", "2026-10-31");
  expect(requests).toBe(1);
  bHolder = false;
  await expect(source.fxSource.rates(Currencies.EUR, "2026-10-31", "2026-10-31")).rejects.toThrow(
    "market_fetch_authority_unavailable",
  );
  expect(requests).toBe(1);
  expect(() => bound.sources([b])).toThrow("market_fetch_authority_unavailable");
  bound.close();
});

it("holds a fetch lifetime through a deferred response body after authority loss", async () => {
  const driver = openNodeSqlite(":memory:");
  drivers.push(driver);
  const id = "a".repeat(32);
  let holder = true;
  let active = 0;
  let startBody: (() => void) | undefined;
  const bodyStarted = new Promise<void>((resolve) => {
    startBody = resolve;
  });
  let finishBody: (() => void) | undefined;
  const body = new Promise<void>((resolve) => {
    finishBody = resolve;
  });
  const vault = {
    id,
    mode: "native",
    native: {
      canFetchPublicMarket: () => holder,
      beginFetch: () => {
        active++;
        return () => {
          active--;
        };
      },
      blobPublication: () => null,
    },
  } as OpenVault;
  const bound = createProductionMarket({
    stores: { device: { driver }, vaults: new Map([[id, vault]]) },
    isCurrent: () => true,
    now: () => Date.UTC(2026, 9, 31, 12),
    sleep: async () => {},
    fetch: async () => ({
      status: 200,
      headers: { get: () => null },
      text: async () => {
        startBody?.();
        await body;
        return "{}";
      },
    }),
  });
  const waiting = bound.sources([id]).fxSource.rates(Currencies.EUR, "2026-10-31", "2026-10-31");
  await bodyStarted;
  holder = false;
  expect(active).toBe(1);
  finishBody?.();
  await expect(waiting).rejects.toThrow("market_fetch_authority_unavailable");
  expect(active).toBe(0);
  bound.close();
});

it("stops composite fallback requests inside a scoped B-only fetch after B loses its lease", async () => {
  const driver = openNodeSqlite(":memory:");
  drivers.push(driver);
  const a = "a".repeat(32),
    b = "b".repeat(32);
  let bHolder = true;
  const urls: string[] = [];
  const vault = (id: string, holder: () => boolean) =>
    ({
      id,
      mode: "native",
      native: {
        canFetchPublicMarket: holder,
        beginFetch: () => () => {},
        blobPublication: () => null,
      },
    }) as OpenVault;
  const bound = createProductionMarket({
    stores: {
      device: { driver },
      vaults: new Map([
        [a, vault(a, () => true)],
        [b, vault(b, () => bHolder)],
      ]),
    },
    isCurrent: () => true,
    now: () => Date.UTC(2026, 9, 31, 12),
    sleep: async () => {},
    fetch: async (url) => {
      urls.push(url);
      bHolder = false;
      return { status: 404, headers: { get: () => null }, text: async () => "" };
    },
  });
  const sources = bound.sources([a, b]);
  const subject = instrument({
    id: asInstrumentId("subject"),
    name: "Synthetic",
    currency: Currencies.USD,
    assetClass: "equity",
    aliases: [
      { namespace: "stooq", value: "test.us", guessed: false },
      { namespace: "yahoo", value: "TEST", guessed: false },
    ],
  });
  await expect(
    sources.scoped?.(() => bHolder).priceSource.fetch(subject, "2026-10-30", "2026-10-31"),
  ).rejects.toThrow();
  expect(urls).toHaveLength(1);
  bound.close();
});
