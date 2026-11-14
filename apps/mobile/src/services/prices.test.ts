// The phone's Yahoo price refresh over a stub `fetch` (no network) into a real in-memory price cache,
// read back by the genuine portfolio query. The Yahoo answer is the recorded chart fixture of
// `@cashu/market` relabelled as a synthetic PLN listing; every holding is invented.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { betterSqlite3Driver } from "@cashu/store";
import { SqlPriceCache } from "@cashu/store/investments/local";
import { runQuery } from "@cashu/store/query";
import { viewHash } from "@cashu/store/runtime";
import Database from "better-sqlite3";
import { COMPANION_VAULTS } from "../fixture/companionDemo";
import { phoneInvestmentSources } from "./investments";
import { createMoneyQueries } from "./moneyQueries";
import { refreshPrices } from "./prices";
import { investmentStore } from "./testing/investmentStore";

const TODAY = "2026-09-18";
const NOW = Date.UTC(2026, 8, 18, 7, 31);
const CDR = {
  symbol: "CDR",
  name: "Synthetic Warsaw listing",
  currency: "PLN",
  yahoo: "CDR.WA",
  mic: "XWAR",
  quantity: "10",
  price: "150",
} as const;

/** The recorded Yahoo chart (4 daily bars, 14-17 Sep 2026) relabelled as CDR.WA in PLN. */
function chartResult(): Record<string, unknown> {
  const recorded = JSON.parse(
    readFileSync(
      join(__dirname, "../../../../packages/domain/test/fixtures/market/yahoo_vwce_de.json"),
      "utf8",
    ),
  ) as { chart: { result: [{ meta: Record<string, unknown> }] } };
  const [result] = recorded.chart.result;
  return { ...result, meta: { ...result.meta, symbol: "CDR.WA", currency: "PLN" } };
}

/** "online" answers with the chart, "offline" fails in transport, "throttled" answers HTTP 429. */
function stubFetch(mode: boolean | "throttled") {
  const requests: { url: string; agent: string | undefined }[] = [];
  const fetch = async (url: string, init: { headers: Record<string, string> }) => {
    requests.push({ url, agent: init.headers["User-Agent"] });
    if (mode === false) throw new TypeError("Network request failed");
    if (mode === "throttled")
      return {
        status: 429,
        headers: { get: () => "text/plain" },
        text: async () => "Too Many Requests",
      };
    const result = chartResult();
    const body = url.includes("/v7/finance/spark")
      ? { spark: { result: [{ symbol: "CDR.WA", response: [result] }] } }
      : { chart: { result: [result], error: null } };
    return {
      status: 200,
      headers: { get: () => "application/json" },
      text: async () => JSON.stringify(body),
    };
  };
  return { requests, fetch };
}

const closers: (() => void)[] = [];
afterEach(() => {
  for (const close of closers.splice(0)) close();
});

function setup(vaultId?: string) {
  const vault = investmentStore({
    strategy: true,
    holdings: [CDR],
    tradeDate: "2026-09-01",
    ...(vaultId === undefined ? {} : { vault: vaultId }),
  });
  const cacheDb = new Database(":memory:");
  closers.push(() => {
    vault.close();
    cacheDb.close();
  });
  return { ...vault, prices: new SqlPriceCache(betterSqlite3Driver(cacheDb)) };
}

it("fills Yahoo bars for the vault's ticker and the portfolio values the position at the close", async () => {
  const { store, prices } = setup();
  const net = stubFetch(true);
  const vaultBefore = viewHash(store).hash;
  const result = await refreshPrices({
    store,
    prices,
    fetch: net.fetch,
    now: () => NOW,
    today: TODAY,
    baseCurrency: "PLN",
  });
  expect(result).toEqual({ status: "ok", updated: 1, errors: [] });
  // Only the device cache is written: the vault is untouched.
  expect(viewHash(store).hash).toBe(vaultBefore);
  expect(prices.bars({ provider: "yahoo", symbol: "CDR.WA" }).map((b) => b.date)).toEqual([
    "2026-09-14",
    "2026-09-15",
    "2026-09-16",
    "2026-09-17",
  ]);
  // Only Yahoo, only the vault's ticker, with the package's user agent.
  expect(net.requests.length).toBeGreaterThan(0);
  for (const r of net.requests) {
    expect(new URL(r.url).hostname).toBe("query1.finance.yahoo.com");
    expect(r.url).toContain("CDR.WA");
    expect(r.agent).toMatch(/^Mozilla\/5\.0/u);
  }

  const sources = phoneInvestmentSources({ prices, now: () => new Date(NOW).toISOString() });
  const portfolio = runQuery(store, createMoneyQueries({ prices }, sources).investments.portfolio, {
    today: TODAY,
    lang: "en",
  }).value;
  if (portfolio.status !== "ready") throw new Error(`not ready: ${portfolio.reason}`);
  const [position] = portfolio.positions.positions;
  expect(position?.price?.toString()).toBe("167.66");
  expect(position?.value?.toString()).toBe("1676.60");
  expect(portfolio.overview.freshness.prices.newest_bar).toBe("2026-09-17");
});

it("reports offline and leaves the cache untouched when nothing answers", async () => {
  const { store, prices } = setup();
  const before = prices.version();
  const vaultBefore = viewHash(store).hash;
  const result = await refreshPrices({
    store,
    prices,
    fetch: stubFetch(false).fetch,
    now: () => NOW,
    today: TODAY,
    baseCurrency: "PLN",
  });
  expect(result.status).toBe("offline");
  expect(result.updated).toBe(0);
  expect(prices.version()).toBe(before);
  expect(prices.bars({ provider: "yahoo", symbol: "CDR.WA" })).toEqual([]);
  expect(viewHash(store).hash).toBe(vaultBefore);
});

it("counts a throttled run (HTTP 429) as one that reached the network, so the gate closes", async () => {
  const { store, prices } = setup();
  const before = prices.version();
  const net = stubFetch("throttled");
  const result = await refreshPrices({
    store,
    prices,
    fetch: net.fetch,
    now: () => NOW,
    today: TODAY,
    baseCurrency: "PLN",
  });
  expect(net.requests.length).toBeGreaterThan(0);
  expect(result.status).toBe("partial");
  expect(result.updated).toBe(0);
  expect(result.errors.length).toBeGreaterThan(0);
  expect(prices.version()).toBe(before);
});

it("never fetches for a demo vault (TRANSITIONAL(S44): its prices are the fixture's)", async () => {
  const { store, prices } = setup(COMPANION_VAULTS.anna.vault);
  const net = stubFetch(true);
  const result = await refreshPrices({
    store,
    prices,
    fetch: net.fetch,
    now: () => NOW,
    today: TODAY,
    baseCurrency: "PLN",
  });
  expect(result).toEqual({ status: "nothing", updated: 0, errors: [] });
  expect(net.requests).toEqual([]);
});
