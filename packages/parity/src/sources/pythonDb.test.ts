/// <reference types="node" />
import { existsSync, readdirSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { manifest, PythonDb, SourceChangedError, withPythonDb } from "./pythonDb.ts";
import { type SyntheticDataset, syntheticDataset, TWO_PROFILES } from "./testing.ts";

let ds: SyntheticDataset;
afterEach(() => ds.dispose());

const open = () => PythonDb.open({ dataset: "demo", sourceDir: ds.dir, runRoot: ds.runRoot });

describe("PythonDb", () => {
  it("reads a copy and leaves the source untouched", () => {
    ds = syntheticDataset(TWO_PROFILES);
    const before = manifest(ds.dir);
    const db = open();
    expect(readdirSync(ds.runRoot)).toHaveLength(1); // the run copy
    expect(db.schemaVersion()).toBe("0026_test");
    expect(db.asOf).toBe("2026-10-01");
    db.close();
    expect(readdirSync(ds.runRoot)).toHaveLength(0); // copy deleted
    expect(manifest(ds.dir)).toBe(before);
    expect(existsSync(`${ds.dir}/cashu.db-shm`)).toBe(false); // never opened in place
  });

  it("the connection is read-only", () => {
    ds = syntheticDataset(TWO_PROFILES);
    withPythonDb({ dataset: "demo", sourceDir: ds.dir, runRoot: ds.runRoot }, (db) => {
      expect(() => db.rows("DELETE FROM accounts")).toThrow(/readonly/);
    });
  });

  it("a source that changed while it was read fails the close", () => {
    ds = syntheticDataset(TWO_PROFILES);
    const db = open();
    ds.exec("UPDATE profiles SET name = 'Changed Test' WHERE id = 1");
    expect(() => db.close()).toThrow(SourceChangedError);
  });

  it("profiles come in slug order with their settings", () => {
    ds = syntheticDataset(TWO_PROFILES);
    withPythonDb({ dataset: "demo", sourceDir: ds.dir, runRoot: ds.runRoot }, (db) => {
      expect(db.profiles().map((p) => [p.slug, p.baseCurrency])).toEqual([
        ["test-a", "EUR"],
        ["test-b", "PLN"],
      ]);
      expect(db.enabledModules(1)).toEqual(["budget", "loans"]);
    });
  });

  it("every reader is scoped to the profile", () => {
    ds = syntheticDataset(TWO_PROFILES);
    withPythonDb({ dataset: "demo", sourceDir: ds.dir, runRoot: ds.runRoot }, (db) => {
      expect(db.accounts(2).map((a) => a.id)).toEqual([5]);
      expect(db.balances(2).map((b) => b.id)).toEqual([5]);
      expect(db.transactions(2).map((t) => t.id)).toEqual([4]);
      expect(db.accounts(1).map((a) => a.id)).toEqual([1, 2, 3]); // removed one left out
      expect(db.accounts(1, { includeRemoved: true }).map((a) => a.id)).toEqual([1, 2, 3, 4]);
      expect(db.balances(1).map((b) => b.id)).toEqual([1, 2, 3, 4]);
      expect(db.transactions(1).map((t) => t.id)).toEqual([3, 1, 2]); // account id, then id
    });
  });

  it("rows keep decimal text and decode enums and booleans", () => {
    ds = syntheticDataset(TWO_PROFILES);
    withPythonDb({ dataset: "demo", sourceDir: ds.dir, runRoot: ds.runRoot }, (db) => {
      const [csv, ob] = db.balances(1);
      expect(csv).toMatchObject({ amount: "1000.00", source: "csv", date: "2026-09-01" });
      expect(ob?.source).toBe("open_banking");
      const removed = db.accounts(1, { includeRemoved: true })[3];
      expect(removed).toMatchObject({ active: true, removedAt: "2026-06-01 10:00:00", iban: null });
      const [eur] = db.transactions(2);
      expect(eur).toMatchObject({ amount: "-1.00", isInternalTransfer: true, category: null });
    });
  });
});
