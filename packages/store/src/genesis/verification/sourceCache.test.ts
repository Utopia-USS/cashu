import { describe, expect, it } from "vitest";
import { pythonDb } from "../testing/pythonSchema.js";
import {
  captureSourceCacheReceipt,
  SourceCacheError,
  verifySourceCacheReceipt,
} from "./sourceCache.js";

describe("exact private Python market cache receipt", () => {
  it("retains nullable fetch times, all FX bases and macro rows, and detects equal-count edits", () => {
    const source = pythonDb("0029");
    try {
      source
        .prepare(
          "INSERT INTO inv_price_bars(id,instrument_id,date,close,open,high,low,volume,currency,source,fetched_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
        )
        .run(1, 7, "2026-01-02", "12.50", null, null, null, null, "EUR", "yahoo", null);
      source
        .prepare(
          "INSERT INTO inv_fx_rates(id,base,quote,date,rate,source,fetched_at) VALUES (?,?,?,?,?,?,?)",
        )
        .run(1, "EUR", "USD", "2026-01-02", "1.07", "synthetic", null);
      source
        .prepare(
          "INSERT INTO inv_macro_bars(id,series,date,close,source,fetched_at) VALUES (?,?,?,?,?,?)",
        )
        .run(1, "spx", "2026-01-02", "123.45", "synthetic", null);
      const proof = captureSourceCacheReceipt(source, "0029_sync_inbound");
      expect(proof).toMatchObject({ priceBars: 1, fxRates: 1, macroBars: 1 });
      expect(proof.receipt.priceBars[0]?.fetchedAt).toBeNull();
      expect(proof.receipt.fxRates[0]?.base).toBe("EUR");
      expect(proof.receipt.macroBars[0]?.series).toBe("spx");
      verifySourceCacheReceipt(source, proof);
      const firstFx = proof.receipt.fxRates[0];
      if (!firstFx) throw new Error("synthetic FX fixture missing");
      const changedReceipt = {
        ...proof,
        receipt: {
          ...proof.receipt,
          fxRates: [{ ...firstFx, rate: "1.08" }],
        },
      };
      expect(() => verifySourceCacheReceipt(source, changedReceipt)).toThrowError(
        new SourceCacheError(),
      );
      source.prepare("UPDATE inv_price_bars SET close='99' WHERE id=1").run();
      expect(() => verifySourceCacheReceipt(source, proof)).toThrowError(new SourceCacheError());
    } finally {
      source.close();
    }
  });
});
