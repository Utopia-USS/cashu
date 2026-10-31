// A strategy's benchmark proxy the owner neither holds nor watches: registered as a reference
// instrument (market data only) when the strategy is recorded or in the backfill, its bars are
// backfilled, and a market default currency is settled at the source; `proxy_not_found` stays only
// for a proxy nothing can resolve. Translates the store parts of
// tests/investments/performance/test_fixb_benchmark_proxy.py (the pure reference_instrument test is in
// @cashu/domain). Fake sources, synthetic data only.
import { market } from "@cashu/domain/investments";
import { describe, expect, it } from "vitest";
import { storeWriter } from "../../command.js";
import { vault } from "../commands/testing/fixtures.js";
import { vaultInstrumentGids } from "../queries/instruments.js";
import { ensureProxy, runBackfill } from "./backfill.js";
import { findProxy } from "./inputs.js";
import { PerformanceService } from "./service.js";
import {
  AS_OF,
  backfillDeps,
  benchClose,
  benchStrategy,
  EUR,
  FakePrices,
  household,
  USD,
} from "./testing/household.js";

/** The fake Yahoo with REFX.DE (Xetra, EUR) and REFL.L (an LSE line quoted in USD). */
function prices(): FakePrices {
  const p = new FakePrices();
  p.closes.set("REFX.DE", benchClose);
  p.quotes.set("REFX.DE", EUR);
  p.closes.set("REFL.L", benchClose);
  p.quotes.set("REFL.L", USD);
  return p;
}

function bench(cache: market.PriceCache, v: ReturnType<typeof vault>, proxy: string) {
  const out = new PerformanceService().performanceView(v.store, {
    asOf: AS_OF,
    strategy: benchStrategy(proxy),
    prices: cache,
    range: "max",
  });
  if (!out.ok) throw new Error(out.reason);
  return out.value.benchmark;
}

describe("benchmark proxy (test_fixb_benchmark_proxy)", () => {
  it("a recorded strategy registers the proxy and the backfill fills it", async () => {
    const v = vault();
    household(v, "Ref");
    const cache = new market.InMemoryPriceCache();
    // the strategy loader registers it when the strategy is recorded
    const ensured = ensureProxy(
      { store: v.store, writer: storeWriter(v.store), env: v.env },
      "REFX.DE",
    );
    expect(ensured.status).toBe("added");
    const inst = ensured.instrument;
    expect([inst?.currency, inst?.mic]).toEqual([EUR, "XETR"]);
    const read = v.store.read.bind(v.store);
    expect(vaultInstrumentGids(read).has(inst?.id as string)).toBe(false); // no position, watchlist or signal
    // registered but no bars yet: "no prices", not "instrument not found"
    expect(bench(cache, v, "REFX.DE").status).toBe("no_prices");

    const report = await runBackfill(
      backfillDeps(v, cache, { strategy: benchStrategy("REFX.DE"), prices: prices() }),
    );
    expect(report.ok && report.value.benchmarks.map((b) => [b.proxy, b.status])).toEqual([
      ["REFX.DE", "found"],
    ]);
    const b = bench(cache, v, "REFX.DE");
    expect([b.status, b.last_priced, b.covers_range_end]).toEqual(["ok", AS_OF, true]);
    expect(b.twr).not.toBeNull();
    expect(cache.bars(market.marketSymbol("yahoo", "REFX.DE")).length).toBeGreaterThan(0);
    expect(vaultInstrumentGids(read).has(inst?.id as string)).toBe(false);
  });

  it("the backfill registers the proxy and settles its quote currency", async () => {
    const v = vault();
    household(v, "Lon");
    const cache = new market.InMemoryPriceCache();
    const report = await runBackfill(
      backfillDeps(v, cache, { strategy: benchStrategy("REFL.L"), prices: prices() }),
    );
    expect(report.ok && report.value.benchmarks.map((b) => [b.proxy, b.status])).toEqual([
      ["REFL.L", "added"],
    ]);
    const inst = findProxy(v.store.read.bind(v.store), "REFL.L");
    expect(inst?.currency).toBe(USD); // XLON default GBP corrected at the source
    const bars = cache.bars(market.marketSymbol("yahoo", "REFL.L"));
    expect(bars.length).toBeGreaterThan(0);
    expect(new Set(bars.map((x) => x.currency))).toEqual(new Set([USD]));
    // the fake FX source has no USD rates, so the comparison waits for them, but it is found
    expect(["ok", "no_prices"]).toContain(bench(cache, v, "REFL.L").status);
  });

  it("an unresolvable proxy stays not found", async () => {
    const v = vault();
    household(v, "Isin");
    const cache = new market.InMemoryPriceCache();
    const strategy = benchStrategy("IE00BEXAMPL9");
    const ensured = ensureProxy(
      { store: v.store, writer: storeWriter(v.store), env: v.env },
      "IE00BEXAMPL9",
    );
    expect(ensured.status).toBe("unresolved");
    await runBackfill(backfillDeps(v, cache, { strategy, prices: prices() }));
    expect(bench(cache, v, "IE00BEXAMPL9").status).toBe("proxy_not_found");
    const symbols = v.store.read<{ symbol: string | null }>("SELECT symbol FROM inv_instruments");
    expect(symbols.map((r) => r.symbol)).not.toContain("IE00BEXAMPL9");
  });
});
