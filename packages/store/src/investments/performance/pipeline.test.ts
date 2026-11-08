// From a synthetic import through the backfill (fake sources) to the views, on the in-memory store
// and an in-memory price cache: hand-computed values, incremental second backfill, cache
// invalidation, benchmark states, vault isolation, a vault's valuation override. Synthetic data only.
import { D } from "@cashu/domain";
import { market, type performance as perf } from "@cashu/domain/investments";
import { describe, expect, it } from "vitest";
import { createProfile } from "../../core/commands.js";
import { classifyInstrument } from "../commands/instruments.js";
import { otherVault, type Vault, vault } from "../commands/testing/fixtures.js";
import { runBackfill } from "./backfill.js";
import { findProxy } from "./inputs.js";
import { PerformanceService } from "./service.js";
import {
  AS_OF,
  backfillDeps,
  benchPln,
  benchStrategy,
  EUR,
  FakeFx,
  FakePrices,
  household,
  importRow,
  NO_STRATEGY,
  noBenchmarkStrategy,
} from "./testing/household.js";

const approx = (value: number | null | undefined, expected: number, abs: number) =>
  expect(Math.abs((value ?? Number.NaN) - expected)).toBeLessThanOrEqual(abs);

function views(service: PerformanceService, v: Vault, cache: market.PriceCache) {
  const base = { asOf: AS_OF, strategy: benchStrategy(), prices: cache };
  return {
    perf(range = "max", accounts: string[] | null = null, strategy = base.strategy) {
      const out = service.performanceView(v.store, { ...base, strategy, range, accounts });
      if (!out.ok) throw new Error(out.reason);
      return out.value;
    },
    attribution(range = "max", strategy = base.strategy) {
      const out = service.attributionView(v.store, { ...base, strategy, range });
      if (!out.ok) throw new Error(out.reason);
      return out.value;
    },
    raw: base,
  };
}

async function backfilled(v: Vault, cache: market.PriceCache) {
  const out = await runBackfill(backfillDeps(v, cache));
  if (!out.ok) throw new Error(out.reason);
  return out.value;
}

describe("performance pipeline", () => {
  it("imports, backfills and shows the hand-computed values", async () => {
    const v = vault();
    household(v);
    const cache = new market.InMemoryPriceCache();
    const report = await backfilled(v, cache);

    // the proxy names a known market: registered offline (Xetra, EUR), then probed and confirmed
    expect(report.benchmarks.map((b) => [b.status, b.proxy])).toEqual([["added", "BNCH.DE"]]);
    const read = v.store.read.bind(v.store);
    const proxy = findProxy(read, "BNCH.DE");
    expect([proxy?.currency, proxy?.symbol]).toEqual([EUR, "BNCH"]);
    expect(
      Object.fromEntries(report.instruments.map((i) => [i.label, [i.role, i.needFrom, i.status]])),
    ).toEqual({
      ABC: ["sold", "2024-12-27", "ok"], // first trade 2025-01-03 minus 7 days
      WRLD: ["held", "2024-12-30", "ok"],
      BNCH: ["benchmark", "2024-12-26", "ok"], // first transaction 2025-01-02 minus 7 days
    });
    expect(report.ratesWritten).toBeGreaterThan(0);

    const service = new PerformanceService();
    const at = views(service, v, cache);
    const d = at.perf();
    const s = d.summary as perf.SummaryView;
    // cash 10000 - 5000 - 4300 + 6000 + 2000 = 8700, WRLD 10 * 110 EUR * 4.3 = 4730
    expect(s.end_value).toBe(13430.0);
    expect([s.start_value, s.net_contributions, s.pnl]).toEqual([0.0, 12000.0, 1430.0]);
    // no flows between 01-02 and 07-01: the index telescopes 11430 / 10000; 07-01 is flat
    approx(s.twr, 0.143, 1e-6);
    expect([s.xirr, s.twr_annualized]).toEqual([null, null]); // 272 days
    const x = Math.log1p(s.mwr as number) / 271; // -10000 on 01-02, -2000 on 07-01, +13430
    approx(-10000 - 2000 * Math.exp(-x * 180) + 13430 * Math.exp(-x * 271), 0, 1.0);
    expect(s.max_drawdown?.depth).toBe(0.0);
    expect([d.start, d.step, d.points.length]).toEqual(["2025-01-01", "day", 273]);
    const first = d.points[1];
    expect([first?.date, first?.value, first?.flow]).toEqual(["2025-01-02", 10000.0, 10000.0]);

    const b = d.benchmark;
    expect([b.status, b.proxy, b.currency]).toEqual(["ok", "BNCH.DE", EUR]);
    approx(b.twr, benchPln("2025-09-30") / benchPln("2025-01-01") - 1, 1e-6);
    const units = 10000 / benchPln("2025-01-02") + 2000 / benchPln("2025-07-01");
    approx(b.simulation?.end_value, units * benchPln("2025-09-30"), 0.01);
    approx(b.excess_value, 13430 - units * benchPln("2025-09-30"), 0.01);
    expect([d.data_quality?.notes, d.data_quality?.incomplete_days]).toEqual([[], 0]);

    // 3 months: base 06-30 = 6700 cash + 4730; the only move is the 2000 deposit
    const q = at.perf("3m").summary as perf.SummaryView;
    expect([q.start_value, q.end_value, q.net_contributions]).toEqual([11430.0, 13430.0, 2000.0]);
    expect(q.pnl).toBe(0.0);
    approx(q.twr, 0.0, 1e-9);

    const a = at.attribution();
    const rows = Object.fromEntries(a.instruments.map((r) => [r.label, r]));
    expect([rows.ABC?.pnl, rows.ABC?.held]).toEqual([1000.0, false]);
    expect([rows.WRLD?.pnl, rows.WRLD?.end_value]).toEqual([430.0, 4730.0]);
    expect([a.total_pnl, a.other]).toEqual([1430.0, 0.0]);
    expect(a.buckets).toEqual([
      { bucket: "stocks", pnl: 1430.0, share_of_pnl: 1.0, instruments: 2 },
    ]);
    expect(a.concentration?.top[0]).toEqual({ n: 1, share: Math.round((1000 / 1430) * 1e6) / 1e6 });
    approx(a.concentration?.benchmark_pnl, units * benchPln("2025-09-30") - 12000, 0.01);

    // mcp_summary (the MCP history_metrics tool): plain values over the whole history
    const m = service.historyMetrics(v.store, at.raw);
    expect([m?.since, m?.asOf, m?.baseCurrency, m?.benchmarkMeta.status]).toEqual([
      "2025-01-02",
      AS_OF,
      "PLN",
      "ok",
    ]);
    approx(m?.summary.endValue, 13430, 1e-6);
    approx(m?.pnlPctOfContributions, 1430 / 12000, 1e-9);
    expect(m?.rolling.map((r) => r.months)).toEqual([12, 24, 36]);
    expect(m?.perYear.map((y) => y.year)).toEqual([2025]);

    // a second backfill only asks for what is new (the last day again, no history)
    const prices2 = new FakePrices();
    const fx2 = new FakeFx();
    const again = await runBackfill(backfillDeps(v, cache, { prices: prices2, fx: fx2 }));
    if (!again.ok) throw new Error(again.reason);
    expect(new Set(prices2.calls.map((c) => c[1]))).toEqual(new Set([AS_OF]));
    expect(prices2.calls).toHaveLength(3);
    expect(new Set(fx2.calls.map((c) => c[1]))).toEqual(new Set([AS_OF]));
    expect(again.value.instruments.every((i) => i.head === null)).toBe(true);
    expect(again.value.benchmarks.map((x) => x.status)).toEqual(["found"]);
  });

  it("new data invalidates the cached computation", async () => {
    const v = vault();
    const { account } = household(v);
    const cache = new market.InMemoryPriceCache();
    await backfilled(v, cache);
    const service = new PerformanceService();
    const at = views(service, v, cache);
    expect(at.perf().summary?.end_value).toBe(13430.0);
    expect(service.computed(v.store, at.raw)).toBe(service.computed(v.store, at.raw)); // cached
    importRow(v, account, {
      type: "deposit",
      tradeDate: "2025-09-15",
      cashAmount: "500.00",
      createdAt: "2025-09-15T09:00:00.000Z",
    });
    const after = at.perf().summary;
    expect([after?.end_value, after?.net_contributions]).toEqual([13930.0, 12500.0]);
  });

  it("a new price in the cache invalidates it too", async () => {
    const v = vault();
    household(v);
    const cache = new market.InMemoryPriceCache();
    await backfilled(v, cache);
    const service = new PerformanceService();
    const at = views(service, v, cache);
    expect(at.perf().summary?.end_value).toBe(13430.0);
    cache.upsertBars(
      market.marketSymbol("yahoo", "WRLD.DE"),
      [
        {
          date: AS_OF,
          close: D("120"),
          open: null,
          high: null,
          low: null,
          volume: null,
          currency: EUR,
          fetchedAt: null,
        },
      ],
      { date: "2025-10-01", hour: 0, minute: 0, second: 0, microsecond: 0, offsetSeconds: 0 },
    );
    // WRLD 10 * 120 EUR * 4.3 = 5160 instead of 4730
    expect(at.perf().summary?.end_value).toBe(13860.0);
  });

  it("filters by account and refuses unknown ranges and accounts", async () => {
    const v = vault();
    const { account } = household(v);
    const other = otherVault();
    const { account: otherAccount } = household(other, "Druga");
    const cache = new market.InMemoryPriceCache();
    await backfilled(v, cache);
    const service = new PerformanceService();
    const at = views(service, v, cache);
    const whole = at.perf();
    const only = at.perf("max", [account]);
    expect(only.summary).toEqual(whole.summary);
    expect(only.accounts_filter).toEqual([account]);
    expect(only.accounts.map((a) => a.account_id)).toEqual([account]);
    expect(only.accounts[0]?.values.at(-1)).toBe(13430.0);
    const req = { ...at.raw, range: "max" };
    expect(service.performanceView(v.store, { ...req, accounts: [otherAccount] })).toEqual({
      ok: false,
      reason: "unknown_account", // another vault's account
    });
    expect(service.performanceView(v.store, { ...req, accounts: ["x"] })).toEqual({
      ok: false,
      reason: "unknown_account",
    });
    expect(service.performanceView(v.store, { ...req, range: "5y" })).toEqual({
      ok: false,
      reason: "unknown_range",
    });
    expect(service.attributionView(v.store, { ...req, accounts: [otherAccount] })).toEqual({
      ok: false,
      reason: "unknown_account",
    });
    expect(service.attributionView(v.store, { ...req, range: "week" })).toEqual({
      ok: false,
      reason: "unknown_range",
    });
  });

  it("vaults do not leak into each other", async () => {
    const v = vault();
    household(v, "Anna");
    const cache = new market.InMemoryPriceCache();
    await backfilled(v, cache);
    const service = new PerformanceService();
    const at = views(service, v, cache);
    const reference = at.perf();
    const empty = otherVault();
    empty.value(createProfile, {
      slug: "pusty",
      name: "Pusty",
      modules: ["investments"],
    });
    const e = views(service, empty, cache);
    expect(service.historyMetrics(empty.store, e.raw)).toBeNull(); // mcp_summary without history
    const ep = e.perf();
    expect([ep.points, ep.summary, ep.accounts]).toEqual([[], null, []]);
    const ea = e.attribution();
    expect([ea.instruments, ea.total_pnl]).toEqual([[], null]);
    expect(at.perf()).toEqual(reference); // unchanged by the other vault's requests
  });

  it("names every benchmark state", async () => {
    const v = vault();
    household(v, "Bez");
    const cache = new market.InMemoryPriceCache();
    const service = new PerformanceService();
    const at = views(service, v, cache);
    const d = at.perf("max", null, NO_STRATEGY);
    expect([d.benchmark.status, d.benchmark.twr]).toEqual(["no_strategy", null]);
    expect(d.summary?.end_value).not.toBeNull(); // valued from last trade prices, no bars yet
    const isin = benchStrategy("IE00B4L5Y983");
    expect(at.perf("max", null, isin).benchmark.status).toBe("proxy_not_found");
    const report = await runBackfill(backfillDeps(v, cache, { strategy: isin }));
    expect(report.ok && report.value.benchmarks.map((b) => b.status)).toEqual(["not_found"]);
    expect(at.perf("max", null, noBenchmarkStrategy()).benchmark.status).toBe("not_configured");
  });

  it("an unknown proxy symbol is an error, not an instrument", async () => {
    const v = vault();
    household(v);
    const cache = new market.InMemoryPriceCache();
    const strategy = benchStrategy("NOPE.XX");
    const report = await runBackfill(backfillDeps(v, cache, { strategy }));
    expect(report.ok && report.value.benchmarks.map((b) => b.status)).toEqual(["error"]);
    expect(findProxy(v.store.read.bind(v.store), "NOPE.XX")).toBeUndefined();
    const at = views(new PerformanceService(), v, cache);
    expect(at.perf("max", null, strategy).benchmark.status).toBe("proxy_not_found");
  });

  it("one backfill at a time, on the lease holder only", async () => {
    const v = vault();
    household(v);
    const cache = new market.InMemoryPriceCache();
    const first = runBackfill(backfillDeps(v, cache));
    expect(await runBackfill(backfillDeps(v, cache))).toEqual({ ok: false, reason: "busy" });
    expect((await first).ok).toBe(true);
    const follower = vault({ holder: false });
    household(follower);
    expect(await runBackfill(backfillDeps(follower, cache))).toEqual({
      ok: false,
      reason: "not_leader",
    });
  });
});

describe("the vault's own view of an instrument", () => {
  it("a valuation override reaches this vault's performance only", async () => {
    const a = vault();
    const { wrld } = household(a, "Anna");
    const b = otherVault();
    household(b, "Basia");
    const cache = new market.InMemoryPriceCache();
    await backfilled(a, cache);
    await backfilled(b, cache);
    const service = new PerformanceService();
    const atA = views(service, a, cache);
    const atB = views(service, b, cache);
    expect(atA.perf().summary?.end_value).toBe(13430.0);
    expect(atB.perf().summary?.end_value).toBe(13430.0);
    a.value(classifyInstrument, { instrument: wrld, valuationMode: "cost" });
    // A: WRLD at cost (10 x 100 EUR at the trade-date rate 4.3) instead of the market close
    expect(atA.perf().summary?.end_value).toBe(8700.0 + 4300.0);
    expect(atB.perf().summary?.end_value).toBe(13430.0); // B keeps the shared market valuation
  });
});
