import { addDays, D, parseDateTime, toCurrency } from "@cashu/domain";
import { asInstrumentId, asProfileId, market, priceBar } from "@cashu/domain/investments";
import { investmentsCommands as C } from "@cashu/store";
import { loadInstrument, watchlist } from "@cashu/store/investments/queries";
import { loadStrategy } from "@cashu/store/investments/services";
import { afterEach, describe, expect, it } from "vitest";
import { investmentWatchIo } from "../providers/investmentAsyncTypes.js";
import { investmentWriteServices } from "../providers/investmentWrites.js";
import { decodeEntityRef } from "../runtime/refs.js";
import { NativeMcpServer, resultText } from "../runtime/server.js";
import { asyncFixture, deferred } from "../testing/async.js";
import { investmentWatchAdapter } from "./investmentWatch.js";
import { investmentWriteTools } from "./investmentWrites.js";

const opened: ReturnType<typeof asyncFixture>[] = [];
afterEach(() => {
  for (const s of opened.splice(0)) s.f.close();
});
function quote(symbol: string): market.ChartQuote {
  return {
    symbol,
    currency: toCurrency("PLN"),
    instrumentType: "EQUITY",
    longName: "Synthetic Public",
    exchangeName: null,
    splits: [],
    adjusted: [],
    bars: Array.from({ length: 22 }, (_, i) =>
      priceBar({
        instrumentId: asInstrumentId("chart"),
        date: addDays("2026-10-10", i),
        close: D(String(100 + i)),
        source: "yahoo",
        currency: toCurrency("PLN"),
      }),
    ),
  };
}
async function setup(failCache = false, asyncCache = false) {
  const s = asyncFixture();
  opened.push(s);
  const strategy = await loadStrategy(s.f.store, {
    read: async (name) =>
      name === "strategy.yaml"
        ? "version: 1\nbase_currency: PLN\ndata: {max_stale_weight: 1}\n"
        : null,
    write: async () => {},
    exists: async () => true,
  });
  const entered = deferred<void>(),
    answer = deferred<market.ChartQuote | null>();
  let charts = 0,
    searches = 0,
    cacheWrites = 0,
    provider = true;
  const io = investmentWatchIo(
    s.f.vault,
    {
      async chart() {
        charts++;
        entered.resolve();
        return await answer.promise;
      },
      async search() {
        searches++;
        return market.parseYahooSearch(
          JSON.stringify({
            quotes: [
              {
                symbol: "ABC.WA",
                shortname: "Synthetic Public",
                quoteType: "EQUITY",
                exchange: "WSE",
              },
            ],
          }),
        );
      },
    },
    {
      upsertBars(...args) {
        cacheWrites++;
        if (asyncCache) return Promise.reject(new Error("synthetic async cache rejection"));
        if (failCache) throw new Error("synthetic cache failure");
        s.f.prices.upsertBars(...args);
      },
    },
    () => true,
  );
  s.services((ctx) => ({
    investmentAsync: { vault: s.f.vault, watch: io },
    ...(provider
      ? {
          investmentWrites: investmentWriteServices(ctx, {
            portfolio: {
              vault: asProfileId(s.f.vault),
              asOf: ctx.today,
              clock: {
                today: ctx.today,
                now: parseDateTime(new Date(ctx.store.now()).toISOString()),
                timeZone: "UTC",
              },
              strategy,
              lang: "en",
              forOwner: false,
              prices: s.f.prices,
            },
            isHolder: () => false,
          }),
        }
      : {}),
  }));
  const server = new NativeMcpServer(s.runtime, investmentWriteTools(), [investmentWatchAdapter]);
  return {
    ...s,
    io,
    server,
    entered,
    answer,
    charts: () => charts,
    searches: () => searches,
    cacheWrites: () => cacheWrites,
    noProjection: () => {
      provider = false;
    },
  };
}
describe("native full watch pipeline", () => {
  it("delivers the full response for an already-owned alias on watch and restore", async () => {
    const s = await setup();
    const created = s.f.run(C.createInstrument, {
      symbol: "ALIAS",
      name: "Public Alias Fund",
      currency: "PLN",
      assetClass: "equity",
      aliases: [{ namespace: "yahoo", value: "ALIAS.WA" }],
    });
    if (!created.ok) throw new Error(created.reason);
    const classified = s.f.run(C.classifyInstrument, {
      instrument: created.value.gid,
      name: "Owner Display Alias",
    });
    if (!classified.ok) throw new Error(classified.reason);
    const added = await s.server.call("add_to_watchlist", { symbol_or_isin: "ALIAS" });
    expect(added.ok).toBe(true);
    expect(added.data).toHaveProperty("item");
    const item = (added.data as { item: { item_id: string } }).item;
    const removed = s.f.run(C.removeFromWatchlist, {
      item: decodeEntityRef("watchlist", item.item_id),
    });
    expect(removed.ok).toBe(true);
    const restored = await s.server.call("add_to_watchlist", { symbol_or_isin: "ALIAS" });
    expect(restored.data).toMatchObject({ item: { item_id: item.item_id }, restored: true });
    expect(restored.data).not.toHaveProperty("completed");
    expect(s.charts()).toBe(0);
  });
  it("uses search+chart then actual creation, prospective row and synchronous cache once", async () => {
    const s = await setup();
    const pending = s.server.call("add_to_watchlist", { symbol_or_isin: "ABC" });
    await s.entered.promise;
    s.answer.resolve(quote("ABC.WA"));
    const result = await pending;
    expect(result.ok).toBe(true);
    const data = result.data as {
      item: { item_id: string; instrument: { instrument_id: string }; last_close: number };
      created_instrument: boolean;
    };
    expect(data.created_instrument).toBe(true);
    expect(data.item.last_close).toBe(121);
    const id = decodeEntityRef("instrument", data.item.instrument.instrument_id);
    expect(loadInstrument(s.f.store.read.bind(s.f.store), id)?.symbol).toBe("ABC");
    const read = await s.server.call("watchlist");
    expect((read.data as { items: unknown[] }).items).toContainEqual(data.item);
    expect(s.searches()).toBe(1);
    expect(s.charts()).toBe(1);
    expect(s.cacheWrites()).toBe(1);
    expect(s.f.store.read<{ n: number }>("SELECT COUNT(*) AS n FROM inv_signals")[0]?.n).toBe(0);
  });
  it("keeps base watch success on cache failure without a second write", async () => {
    const s = await setup(true);
    const pending = s.server.call("add_to_watchlist", { symbol_or_isin: "ABC.WA" });
    await s.entered.promise;
    s.answer.resolve(quote("ABC.WA"));
    const result = await pending;
    expect(result.ok).toBe(true);
    expect(s.commits()).toBe(1);
    expect(result.data).toMatchObject({
      created_instrument: true,
      warnings: ["watch saved; the price cache could not be updated; a later refresh can retry"],
    });
    expect(watchlist(s.f.store.read.bind(s.f.store))).toHaveLength(1);
    expect(s.warnings).toEqual(["mcp.async-cache-failed"]);
  });
  it("observes accidentally async cache rejection and returns fixed saved/withheld success", async () => {
    const s = await setup(false, true);
    const pending = s.server.call("add_to_watchlist", { symbol_or_isin: "ABC.WA" });
    await s.entered.promise;
    s.answer.resolve(quote("ABC.WA"));
    const result = await pending;
    expect(result.ok).toBe(true);
    expect(result.privacy).toBe("strict");
    expect(result.data).toEqual({ saved: true, note: "saved; the response was withheld" });
    expect(s.commits()).toBe(1);
    expect(s.warnings).toContain("mcp.async-cache-not-synchronous");
    expect(s.warnings).toContain("mcp.async-cache-failed");
  });
  it("retains saved success when diagnostics throw and async cache rejects", async () => {
    const s = await setup(false, true);
    s.runtime.warn = () => {
      throw new Error("synthetic diagnostics failure");
    };
    const pending = s.server.call("add_to_watchlist", { symbol_or_isin: "ABC.WA" });
    await s.entered.promise;
    s.answer.resolve(quote("ABC.WA"));
    const result = await pending;
    expect(result.ok).toBe(true);
    expect(result.data).toEqual({ saved: true, note: "saved; the response was withheld" });
    expect(s.commits()).toBe(1);
  });
  it("uses actual winning alias row after chart and never caches losing planned quote", async () => {
    const s = await setup();
    const pending = s.server.call("add_to_watchlist", { symbol_or_isin: "ABC.WA" });
    await s.entered.promise;
    const winner = s.f.run(C.createInstrument, {
      symbol: "WIN",
      name: "Actual Winner",
      currency: "PLN",
      assetClass: "equity",
      aliases: [{ namespace: "yahoo", value: "ABC.WA" }],
    });
    if (!winner.ok) throw new Error(winner.reason);
    s.answer.resolve(quote("ABC.WA"));
    const result = await pending;
    expect(result.data).toMatchObject({
      created_instrument: false,
      item: { instrument: { symbol: "WIN" } },
      warnings: [],
    });
    expect(s.cacheWrites()).toBe(0);
  });
  it("protects actual new private fallback names and note before append", async () => {
    const s = await setup();
    const result = await s.server.call("add_to_watchlist", {
      symbol_or_isin: "PRIV",
      name: "Synthetic Private Owner",
      currency: "PLN",
      note: "Synthetic Private Owner",
    });
    expect(result.ok).toBe(true);
    expect(resultText(result.data ?? null)).not.toContain("Synthetic Private Owner");
    expect(s.charts()).toBe(0);
    const item = (result.data as { item: unknown }).item;
    const read = await s.server.call("watchlist");
    expect((read.data as { items: unknown[] }).items).toContainEqual(item);
  });
  it("uses actual prospective numeric public symbol permission equal to the post-fold guard", async () => {
    const s = await setup();
    const pending = s.server.call("add_to_watchlist", { symbol_or_isin: "1234.WA" });
    await s.entered.promise;
    s.answer.resolve(quote("1234.WA"));
    const result = await pending;
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({ item: { instrument: { symbol: "1234" } } });
    const read = await s.server.call("watchlist");
    expect((read.data as { items: unknown[] }).items).toContainEqual(
      (result.data as { item: unknown }).item,
    );
  });
  it("refuses absent projection before I/O or effects and preserves ordinary/ref errors", async () => {
    const s = await setup();
    s.noProjection();
    expect((await s.server.call("add_to_watchlist", { symbol_or_isin: "ABC.WA" })).errorKind).toBe(
      "unsupported",
    );
    expect(s.charts()).toBe(0);
    expect(s.commits()).toBe(0);
    expect(
      (await s.server.call("add_to_watchlist", { symbol_or_isin: "x".repeat(41) })).errorKind,
    ).toBe("invalid_arguments");
    expect(
      (await s.server.call("add_to_watchlist", { symbol_or_isin: "instrument:invalid" })).ok,
    ).toBe(false);
  });
});
