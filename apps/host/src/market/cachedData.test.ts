import { D, parseDateTime } from "@cashu/domain";
import { asInstrumentId, Currencies, instrument, market } from "@cashu/domain/investments";
import { openNodeSqlite } from "@cashu/node-host/sqlite";
import { SqlPriceCache } from "@cashu/store/investments/local";
import { expect, it } from "vitest";
import { cachedInstrumentMarketData } from "./cachedData.js";

it("values alias-less imported bars by exact vault identity and invalidates on native writes", () => {
  const driver = openNodeSqlite(":memory:");
  try {
    const prices = new SqlPriceCache(driver);
    const a = instrument({
      id: asInstrumentId("instrument-a"),
      name: "Synthetic A",
      currency: Currencies.USD,
      assetClass: "equity",
    });
    const b = instrument({
      id: asInstrumentId("instrument-b"),
      name: "Synthetic B",
      currency: Currencies.USD,
      assetClass: "equity",
    });
    prices.restoreSourceCache(
      {
        format: 1,
        schema: "synthetic",
        fxRates: [],
        macroBars: [],
        priceBars: [
          {
            id: 1,
            instrumentId: 1,
            date: "2026-10-30",
            close: "10",
            open: null,
            high: null,
            low: null,
            volume: null,
            currency: "USD",
            source: "broker",
            fetchedAt: "2026-11-02 12:00:00.000000",
          },
          {
            id: 2,
            instrumentId: 2,
            date: "2026-10-30",
            close: "20",
            open: null,
            high: null,
            low: null,
            volume: null,
            currency: "USD",
            source: "broker",
            fetchedAt: null,
          },
        ],
      },
      [
        { instrumentId: 1, vault: "vault-a", gid: a.id },
        { instrumentId: 2, vault: "vault-b", gid: b.id },
      ],
      [],
    );
    const one = cachedInstrumentMarketData([a, b], "vault-a", prices);
    expect(one.data.series(a.id).map((row) => row.close.toString())).toEqual(["10"]);
    expect(one.data.series(b.id)).toEqual([]);
    const two = cachedInstrumentMarketData([a, b], "vault-b", prices);
    expect(two.data.series(a.id)).toEqual([]);
    expect(two.data.series(b.id).map((row) => row.close.toString())).toEqual(["20"]);
    const alias = instrument({
      ...a,
      aliases: [{ namespace: "yahoo", value: "SYNTH", guessed: false }],
    });
    prices.upsertBars(
      market.marketSymbol("yahoo", "SYNTH"),
      [
        {
          date: "2026-10-30",
          close: D("30"),
          open: null,
          high: null,
          low: null,
          volume: null,
          currency: Currencies.USD,
          fetchedAt: null,
        },
      ],
      parseDateTime("2026-11-01T12:00:00Z"),
    );
    const stale = cachedInstrumentMarketData([alias], "vault-a", prices);
    expect(stale.version).toBeGreaterThan(one.version);
    expect(stale.data.series(a.id)[0]?.close.toString()).toBe("10");
    prices.upsertBars(
      market.marketSymbol("yahoo", "SYNTH"),
      [
        {
          date: "2026-10-30",
          close: D("30"),
          open: null,
          high: null,
          low: null,
          volume: null,
          currency: Currencies.USD,
          fetchedAt: null,
        },
      ],
      parseDateTime("2026-11-03T12:00:00Z"),
    );
    const current = cachedInstrumentMarketData([alias], "vault-a", prices);
    expect(current.version).toBeGreaterThan(stale.version);
    expect(current.data.series(a.id)[0]?.close.toString()).toBe("30");
    expect(current.data.series(a.id)[0]?.source).toBe("yahoo");
  } finally {
    driver.close();
  }
});
