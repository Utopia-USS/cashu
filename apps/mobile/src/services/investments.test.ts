// The phone's investments sources over the real store and an empty device price cache: the synced
// strategy version is the current strategy, the cache is the market (last-trade valuation until prices
// arrive), the device clock is the clock. All values are invented.
import { betterSqlite3Driver } from "@cashu/store";
import { SqlPriceCache } from "@cashu/store/investments/local";
import { runQuery, watchQuery } from "@cashu/store/query";
import Database from "better-sqlite3";
import { deviceTimeZone, phoneInvestmentSources } from "./investments";
import { createMoneyQueries } from "./moneyQueries";
import { emitNowTick } from "./nowTicks";
import { investmentStore } from "./testing/investmentStore";

const TODAY = "2026-11-12";
const VWCE = {
  symbol: "VWCE",
  name: "Synthetic All-World ETF",
  currency: "EUR",
  yahoo: "VWCE.DE",
  mic: "XETR",
  quantity: "10",
  price: "130",
  fxRate: "4.3",
} as const;

const closers: (() => void)[] = [];
afterEach(() => {
  for (const close of closers.splice(0)) close();
});

function setup(strategy: boolean) {
  const vault = investmentStore({ strategy, holdings: [VWCE], tradeDate: "2026-10-01" });
  const cacheDb = new Database(":memory:");
  closers.push(() => {
    vault.close();
    cacheDb.close();
  });
  const prices = new SqlPriceCache(betterSqlite3Driver(cacheDb));
  const sources = phoneInvestmentSources({ prices, now: () => `${TODAY}T09:00:00.000Z` });
  return {
    ...vault,
    prices,
    sources,
    queries: createMoneyQueries({ prices }, sources).investments,
  };
}

it("values the portfolio at the last trade with the synced strategy and an empty cache", () => {
  const { store, queries } = setup(true);
  const portfolio = runQuery(store, queries.portfolio, { today: TODAY, lang: "en" }).value;
  if (portfolio.status !== "ready") throw new Error(`not ready: ${portfolio.reason}`);
  expect(portfolio.strategy.state).toBe("valid");
  expect(portfolio.overview.freshness.fx.missing).toEqual(["EUR"]);
  expect(portfolio.overview.freshness.prices.newest_bar).toBeNull();
  expect(portfolio.positions.positions.map((p) => p.instrument.symbol)).toEqual(["VWCE"]);
});

it("is ready with the strategy missing without a synced strategy version (as on the Mac)", () => {
  const { store, queries } = setup(false);
  const portfolio = runQuery(store, queries.portfolio, { today: TODAY, lang: "en" }).value;
  if (portfolio.status !== "ready") throw new Error(`not ready: ${portfolio.reason}`);
  expect(portfolio.strategy.state).toBe("missing");
  expect(portfolio.positions.positions.map((p) => p.instrument.symbol)).toEqual(["VWCE"]);
});

it("binds the strategy to this vault's profile and the clock to the device", () => {
  const { store, sources } = setup(true);
  const snapshot = sources.strategy.current(store.read.bind(store));
  if (snapshot.status !== "current") throw new Error(snapshot.reason);
  expect(snapshot.vault).toBe(store.read<{ gid: string }>("SELECT gid FROM profiles")[0]?.gid);
  expect(snapshot.state.changed).toBe(false);
  expect(sources.clock.current().timeZone).toBe(deviceTimeZone());
  expect(sources.market.newestRateDate()).toBeNull();
});

it("reads the review deck and the signals screen", () => {
  const { store, queries } = setup(true);
  const review = runQuery(store, queries.review, { today: TODAY, lang: "en", open: true }).value;
  if (review.status !== "current") throw new Error(`review: ${review.status}`);
  expect(review.cards.length).toBeGreaterThan(0);
  expect(Array.isArray(review.decide.items)).toBe(true);
  const signals = runQuery(store, queries.signals, {
    now: `${TODAY}T09:00:00Z`,
    today: TODAY,
    timeZone: "Europe/Warsaw",
    lang: "en",
    privacy: false,
  }).value;
  expect(signals.status).toBe("ready");
});

it("re-runs the review when the shell's day moves on", () => {
  const { store, queries } = setup(true);
  const seen: string[] = [];
  const stop = watchQuery(
    store,
    queries.review,
    { today: TODAY, lang: "en", open: false },
    {
      onValue: (value) => seen.push(value.status),
      onError: (error) => {
        throw error;
      },
    },
  );
  try {
    expect(seen).toHaveLength(1);
    emitNowTick();
    expect(seen).toHaveLength(2);
  } finally {
    stop();
  }
});
