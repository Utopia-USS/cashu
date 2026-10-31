// The investments readers of the read-only source over a synthetic dataset (invented values).

import { afterEach, describe, expect, it } from "vitest";
import { withPythonDb } from "./pythonDb.ts";
import { INVESTMENTS, type SyntheticDataset, syntheticDataset } from "./testing.ts";

let ds: SyntheticDataset;
afterEach(() => ds.dispose());

const run = <T>(fn: Parameters<typeof withPythonDb<T>>[1]): T =>
  withPythonDb({ dataset: "demo", sourceDir: ds.dir, runRoot: ds.runRoot }, fn);

describe("PythonDb investments readers", () => {
  it("scope transactions, renames and valuations to the profile", () => {
    ds = syntheticDataset(INVESTMENTS);
    run((db) => {
      expect(db.investments.brokerageAccounts(1).map((a) => a.id)).toEqual([1]);
      expect(db.investments.transactions(1).map((t) => t.id)).toEqual([1, 2, 3, 4, 5]);
      expect(db.investments.transactions(2).map((t) => t.id)).toEqual([6]);
      expect(db.investments.renames(1)).toEqual([]);
      expect(db.investments.renames(2).map((r) => r.newInstrumentId)).toEqual([3]);
      expect(db.investments.manualValuations(1).map((v) => v.unitValue)).toEqual(["20"]);
      expect(db.investments.profileInstruments(2, [1]).map((o) => o.name)).toEqual(["Other Name"]);
    });
  });

  it("find an instrument by ISIN (upper-cased) and by a namespaced alias", () => {
    ds = syntheticDataset(INVESTMENTS);
    run((db) => {
      expect(db.investments.instrumentIdByIsin("PL0000000001")).toBe(1);
      expect(db.investments.instrumentIdByIsin("PL0000000009")).toBeNull();
      expect(db.investments.instrumentIdByAlias("yahoo", "TSTK")).toBe(2);
      expect(db.investments.instrumentIdByAlias("stooq", "tetf")).toBe(1);
      expect(db.investments.instrumentIdByAlias("yahoo", "tstk")).toBeNull();
      expect(db.investments.instrumentIdByAlias("stooq", "TSTK")).toBeNull();
    });
  });

  it("keep decimal text, parse JSON lists (SQL NULL and JSON null alike) and booleans", () => {
    ds = syntheticDataset(INVESTMENTS);
    run((db) => {
      const [buy] = db.investments.transactions(1).filter((t) => t.type === "buy");
      expect(buy?.quantity).toBe("10");
      expect(buy?.fee).toBe("5");
      expect(buy?.createdAt).toBe("2026-01-05 10:00:00.000000");
      expect(db.investments.instruments([2, 1]).map((i) => i.tags)).toEqual([["equity"], []]);
      expect(db.investments.profileInstruments(1, [1])[0]?.tags).toEqual(["equity", "core"]);
      expect(db.investments.profileInstruments(2, [1])[0]?.tags).toBeNull();
      expect(db.investments.aliases([1]).map((a) => a.guessed)).toEqual([false, true]);
    });
  });

  it("read shared bars and rates in (instrument, date) and (base, quote, date) order", () => {
    ds = syntheticDataset(INVESTMENTS);
    run((db) => {
      expect(db.investments.priceBars([2, 1]).map((b) => [b.instrumentId, b.date])).toEqual([
        [1, "2026-09-29"],
        [1, "2026-09-30"],
        [2, "2026-09-30"],
      ]);
      expect(db.investments.fxRates().map((r) => `${r.quote}@${r.date}`)).toEqual([
        "EUR@2026-09-30",
        "USD@2026-02-04",
        "USD@2026-09-30",
      ]);
    });
  });
});
