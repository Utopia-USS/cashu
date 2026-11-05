import { openNodeSqlite } from "@cashu/node-host/sqlite";
import { SqlPriceCache } from "@cashu/store/investments/local";
import { expect, it } from "vitest";
import { unpricedInstruments } from "./priceReach.js";

// Synthetic import: EUR prices with PLN rates of a non-NBP provider (readable), USD prices without a
// rate, a PLN instrument without bars, and a manually valued one (never priced from the market).
it("names imported instruments the native valuation cannot price, and only those", () => {
  const device = openNodeSqlite(":memory:");
  const source = openNodeSqlite(":memory:");
  try {
    source
      .prepare(
        `CREATE TABLE inv_instruments(id INTEGER PRIMARY KEY,name TEXT,symbol TEXT,isin TEXT,
           currency TEXT,valuation_mode TEXT)`,
      )
      .run();
    source
      .prepare(
        "CREATE TABLE inv_profile_instruments(id INTEGER PRIMARY KEY,instrument_id INTEGER,valuation_mode TEXT)",
      )
      .run();
    const add = source.prepare("INSERT INTO inv_instruments VALUES (?,?,?,?,?,?)");
    add.run(1, "Synthetic Euro ETF", "SEUR", null, "EUR", "market");
    add.run(2, "Synthetic Dollar ETF", null, "XS0000000001", "USD", "market");
    add.run(3, "Synthetic Zloty SA", "SPLN", null, "PLN", "market");
    add.run(4, "Synthetic Flat", null, null, "PLN", "market");
    source.prepare("INSERT INTO inv_profile_instruments VALUES (1,4,'manual')").run();
    const bar = (id: number, instrumentId: number, currency: string) => ({
      id,
      instrumentId,
      date: "2026-10-30",
      close: "10",
      open: null,
      high: null,
      low: null,
      volume: null,
      currency,
      source: "synthetic",
      fetchedAt: null,
    });
    new SqlPriceCache(device).restoreSourceCache(
      {
        format: 1,
        schema: "synthetic",
        priceBars: [bar(1, 1, "EUR"), bar(2, 2, "USD")],
        fxRates: [
          {
            id: 1,
            base: "PLN",
            quote: "EUR",
            date: "2026-10-30",
            rate: "4.3",
            source: "synthetic",
            fetchedAt: null,
          },
        ],
        macroBars: [],
      },
      [1, 2, 3, 4].map((id) => ({ instrumentId: id, vault: "vault-a", gid: `instrument-${id}` })),
      [],
    );
    expect(unpricedInstruments(device, source)).toEqual([
      { label: "SPLN", currency: "PLN", reason: "no_prices" },
      { label: "XS0000000001", currency: "USD", reason: "no_fx" },
    ]);
  } finally {
    source.close();
    device.close();
  }
});
