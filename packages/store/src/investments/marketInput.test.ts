import { D, parseDateTime } from "@cashu/domain";
import {
  asInstrumentId,
  type market,
  type performance as perf,
  priceBar,
} from "@cashu/domain/investments";
import { describe, expect, it } from "vitest";
import { openTestStore } from "../testing/store.js";
import { type MarketInput, marketInputFingerprint, resolveMarketInput } from "./marketInput.js";
import { PerformanceService } from "./performance/service.js";
import { loadInstruments } from "./queries/instruments.js";
import { household } from "./testing/household.js";
import { claim } from "./testing/kit.js";
import { portfolioAt } from "./views/portfolio.js";

function stored(h: ReturnType<typeof household>, close = "12"): market.CachedMarketData {
  const id = asInstrumentId(h.first);
  const bars = [
    priceBar({
      instrumentId: id,
      date: "2026-10-31",
      close: D(close),
      source: "demo",
      fetchedAt: parseDateTime("2026-10-31T12:00:00Z"),
    }),
  ];
  return {
    series: (asked) => (asked === id ? bars : []),
    fxRates: () => [],
    firstBarDate: (asked) => (asked === id ? "2026-10-31" : null),
    lastBarDate: (asked) => (asked === id ? "2026-10-31" : null),
    hasBarsFetchedBefore: () => false,
    firstRateDate: () => null,
    lastRateDate: () => null,
    hasRateOnOrBefore: () => false,
  };
}

describe("explicit cache or versioned stored-market source", () => {
  it("keeps non-cache provider facts through the same native valuation without fabricated aliases", () => {
    const h = household();
    const store = openTestStore();
    store.applyEnvelopes(h.events);
    const data = stored(h, "17");
    const loaded = portfolioAt(store.read.bind(store), {
      vault: h.vault,
      asOf: "2026-10-31",
      strategy: h.strategy,
      lang: "en",
      marketData: { data, version: "synthetic-1" },
    });
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) throw new Error(loaded.reason);
    expect(loaded.value.market.bars.get(asInstrumentId(h.first))?.[0]?.source).toBe("demo");
    expect(loaded.value.valued.valued.every((row) => row.price?.toString() === "17")).toBe(true);
    expect(loaded.value.historyBars.get(asInstrumentId(h.first))).toEqual(
      data.series(asInstrumentId(h.first)),
    );
    store.close();
  });

  it("retains cache defaults/source preference and does not reinterpret a supplied snapshot", () => {
    const h = household();
    const store = openTestStore();
    store.applyEnvelopes(h.events);
    const instruments = loadInstruments(store.read.bind(store), [h.first]);
    let calls = 0;
    const cache = resolveMarketInput({ prices: h.prices }, instruments.values(), {
      order: () => {
        calls++;
        return ["yahoo"];
      },
    });
    expect(cache.series(asInstrumentId(h.first)).at(-1)?.close.toString()).toBe("12");
    expect(calls).toBeGreaterThan(0);
    const data = stored(h);
    expect(
      resolveMarketInput({ marketData: { data, version: 1 } }, instruments.values(), {
        order: () => {
          throw new Error("raw source is already selected");
        },
      }),
    ).toBe(data);
    expect(() =>
      marketInputFingerprint({
        prices: h.prices,
        marketData: { data, version: 1 },
      } as unknown as MarketInput),
    ).toThrow("ambiguous market input");
    store.close();
  });

  it("heavy performance cache keys source identity, explicit version and tracked instrument/alias changes", () => {
    const h = household();
    const store = openTestStore();
    store.applyEnvelopes(h.events);
    const config = h.strategy.config;
    if (config === null) throw new Error("missing synthetic config");
    const strategy: perf.PerformanceStrategy = {
      state: "valid",
      benchmark: null,
      policy: config.data,
      strategy: { baseCurrency: config.baseCurrency, allocation: config.allocation },
    };
    const data = stored(h);
    const service = new PerformanceService();
    const input = { asOf: "2026-10-31", strategy, marketData: { data, version: "one" } };
    const first = service.computed(store, input);
    expect(service.computed(store, { ...input, marketData: { data, version: "one" } })).toBe(first);
    const changedVersion = service.computed(store, {
      ...input,
      marketData: { data, version: "two" },
    });
    expect(changedVersion).not.toBe(first);
    const replacement = stored(h);
    const next = { ...input, marketData: { data: replacement, version: "two" } };
    const changedSource = service.computed(store, next);
    expect(changedSource).not.toBe(changedVersion);
    store.applyEnvelopes([claim(h.ev, h.first, ["stooq", "synthetic.pl"])]);
    const changedAlias = service.computed(store, next);
    expect(changedAlias).not.toBe(changedSource);
    store.applyEnvelopes([h.ev.make("instrument.updated", h.first, { name: "Synthetic updated" })]);
    expect(service.computed(store, next)).not.toBe(changedAlias);
    store.close();
  });
});
