import { D, parseDateTime } from "@cashu/domain";
import { asInstrumentId, Currencies, instrument, market } from "@cashu/domain/investments";
import { openNodeSqlite } from "@cashu/node-host/sqlite";
import { SqlPriceCache } from "@cashu/store/investments/local";
import { expect, it } from "vitest";
import { cachedInstrumentMarketData } from "./cachedData.js";

const bar = (close: string) => ({
  date: "2026-10-30",
  close: D(close),
  open: null,
  high: null,
  low: null,
  volume: null,
  currency: Currencies.USD,
  fetchedAt: null,
});

it("values an instrument from the native bars of its alias and moves the version on writes", () => {
  const driver = openNodeSqlite(":memory:");
  try {
    const prices = new SqlPriceCache(driver);
    const a = instrument({
      id: asInstrumentId("instrument-a"),
      name: "Synthetic A",
      currency: Currencies.USD,
      assetClass: "equity",
      aliases: [{ namespace: "yahoo", value: "SYNTH", guessed: false }],
    });
    const empty = cachedInstrumentMarketData([a], prices);
    expect(empty.data.series(a.id)).toEqual([]);
    prices.upsertBars(
      market.marketSymbol("yahoo", "SYNTH"),
      [bar("10")],
      parseDateTime("2026-11-01T12:00:00Z"),
    );
    const first = cachedInstrumentMarketData([a], prices);
    expect(first.version).toBeGreaterThan(empty.version);
    expect(first.data.series(a.id)[0]?.close.toString()).toBe("10");
    prices.upsertBars(
      market.marketSymbol("yahoo", "SYNTH"),
      [bar("30")],
      parseDateTime("2026-11-03T12:00:00Z"),
    );
    const current = cachedInstrumentMarketData([a], prices);
    expect(current.version).toBeGreaterThan(first.version);
    expect(current.data.series(a.id)[0]?.close.toString()).toBe("30");
    expect(current.data.series(a.id)[0]?.source).toBe("yahoo");
  } finally {
    driver.close();
  }
});
