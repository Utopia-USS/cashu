/// <reference types="node" />
import { existsSync, readdirSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import {
  manifest,
  PythonDb,
  SourceChangedError,
  UnsafePathError,
  withPythonDb,
} from "./pythonDb.ts";
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
      expect(eur?.bankTransactionId).toBeNull();
      expect(db.transactions(1)[0]?.bankTransactionId).toBe("NR TEST 1");
    });
  });

  it("category rules and loan payment patterns are profile-scoped, with Python's semantics", () => {
    ds = syntheticDataset(TWO_PROFILES);
    ds.exec(`INSERT INTO category_rules VALUES
      (1, 'SKLEP TEST', 'shopping', 'manual', 1, NULL, 1),
      (2, 'KAWA TEST', 'dining', 'llm', 0, NULL, 2),
      (3, '', 'travel', 'llm', 0, NULL, 1);
      INSERT INTO loans VALUES (1, 3, '99 1600 0000 0000 0000 0000 0999', NULL),
      (2, 3, '', 'spłata raty'), (3, 3, '', ''), (4, 4, NULL, 'Umowa 7'), (5, 5, 'X', NULL);`);
    withPythonDb({ dataset: "demo", sourceDir: ds.dir, runRoot: ds.runRoot }, (db) => {
      expect(db.categoryRules(1)).toEqual([
        { merchantKey: "SKLEP TEST", category: "shopping", source: "manual", locked: true },
        { merchantKey: "", category: "travel", source: "llm", locked: false },
      ]);
      expect(db.loanPaymentPatterns(1)).toEqual([
        { category: "loans", counterpartyIban: "99 1600 0000 0000 0000 0000 0999", text: null },
        { category: "loans", counterpartyIban: null, text: "SPLATA RATY" },
        { category: "loans", counterpartyIban: null, text: "UMOWA 7" }, // removed account's loan
      ]);
      expect(db.loanPaymentPatterns(2)).toEqual([
        { category: "loans", counterpartyIban: "X", text: null },
      ]);
    });
  });

  it("sqlDriver reads the copy read-only and close closes it", () => {
    ds = syntheticDataset(TWO_PROFILES);
    const before = manifest(ds.dir);
    const db = open();
    const driver = db.sqlDriver();
    const version = driver.prepare("SELECT version_num FROM alembic_version").get();
    expect(version).toEqual({ version_num: "0026_test" });
    const ids = driver.prepare("SELECT id FROM accounts WHERE profile_id = ? ORDER BY id").all(2);
    expect(ids).toEqual([{ id: 5 }]);
    expect(() => driver.exec("DELETE FROM accounts")).toThrow(/refused/);
    const stmt = driver.prepare("SELECT count(*) AS n FROM profiles");
    db.close();
    expect(() => stmt.get()).toThrow();
    expect(() => db.sqlDriver()).toThrow(/closed/);
    expect(manifest(ds.dir)).toBe(before);
  });

  it("files reads the copied profiles and imports side files, never the source", () => {
    ds = syntheticDataset(TWO_PROFILES);
    ds.writeFile("profiles/test-a/budget.json", '{"cushion": null}');
    ds.writeFile("profiles/test-a/strategy.md", "# Test");
    ds.writeFile("imports/test-a/abc.csv", new Uint8Array([1, 2, 3]));
    ds.writeFile("imports/test-a/.staging/def.csv", "x");
    ds.writeFile("other/ignored.txt", "not copied");
    const db = open();
    ds.writeFile("profiles/test-a/later.json", "{}"); // after the copy: not visible
    const files = db.files();
    expect(new TextDecoder().decode(files.read("profiles/test-a/budget.json"))).toBe(
      '{"cushion": null}',
    );
    expect([...(files.read("imports/test-a/abc.csv") ?? [])]).toEqual([1, 2, 3]);
    expect(files.read("imports/test-a/.staging/def.csv")).toBeDefined();
    expect(files.read("other/ignored.txt")).toBeUndefined();
    expect(files.read("profiles/test-a/later.json")).toBeUndefined();
    expect(files.read("profiles/test-a/missing.json")).toBeUndefined();
    expect(files.read("profiles/test-a")).toBeUndefined(); // a dir is not a file
    expect(files.list("profiles/test-a")).toEqual(["budget.json", "strategy.md"]);
    expect(files.list("imports/test-a")).toEqual([".staging", "abc.csv"]);
    expect(files.list("profiles/nobody")).toEqual([]);
    expect(files.list("")).toContain("profiles");
    expect(() => db.close()).toThrow(SourceChangedError); // the later write changed the source
  });

  it("files refuses paths that could leave the copy", () => {
    ds = syntheticDataset(TWO_PROFILES);
    withPythonDb({ dataset: "demo", sourceDir: ds.dir, runRoot: ds.runRoot }, (db) => {
      const files = db.files();
      for (const bad of [
        "../data/cashu.db",
        "profiles/../../x",
        "/etc/hosts",
        "profiles//x",
        "./profiles",
        "profiles\\x",
        "",
      ]) {
        expect(() => files.read(bad), bad).toThrow(UnsafePathError);
      }
      expect(() => files.list("..")).toThrow(UnsafePathError);
    });
  });

  it("a side file changed while it was read fails the close", () => {
    ds = syntheticDataset(TWO_PROFILES);
    ds.writeFile("profiles/test-a/budget.json", "{}");
    const db = open();
    ds.writeFile("profiles/test-a/budget.json", '{"changed": true}');
    expect(() => db.close()).toThrow(SourceChangedError);
  });
});
