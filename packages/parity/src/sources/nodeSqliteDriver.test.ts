/// <reference types="node" />
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openReadOnlyDriver, ReadOnlyDriverError } from "./nodeSqliteDriver.ts";

let root: string;
let path: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cashu-parity-driver-"));
  path = join(root, "test.db");
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT, amount TEXT, blob BLOB);
    INSERT INTO t VALUES (1, 'Test A', '10.50', NULL), (2, 'Test B', '1E+1', x'0102'),
      (3, 'Test C', NULL, NULL);
    CREATE TABLE big (v INTEGER); INSERT INTO big VALUES (9007199254740993);`);
  db.close();
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("openReadOnlyDriver", () => {
  it("reads rows with parameters, integers as numbers and text kept as stored", () => {
    const driver = openReadOnlyDriver(path);
    const stmt = driver.prepare("SELECT id, name, amount, blob FROM t WHERE id >= ? ORDER BY id");
    const rows = stmt.all<{ id: number; amount: string | null; blob: Uint8Array | null }>(2);
    expect(rows.map((r) => [r.id, r.amount])).toEqual([
      [2, "1E+1"],
      [3, null],
    ]);
    expect([...(rows[0]?.blob ?? [])]).toEqual([1, 2]);
    expect(driver.prepare("SELECT name FROM t WHERE id = ?").get<{ name: string }>(1)).toEqual({
      name: "Test A",
    });
    expect(driver.prepare("SELECT name FROM t WHERE id = ?").get(99)).toBeUndefined();
    driver.close();
  });

  it("prepares a statement once per SQL text", () => {
    const driver = openReadOnlyDriver(path);
    expect(driver.prepare("SELECT 1")).toBe(driver.prepare("SELECT 1"));
    expect(driver.prepare("SELECT 1")).not.toBe(driver.prepare("SELECT 2"));
    driver.close();
  });

  it("refuses exec and run, and the connection itself cannot write", () => {
    const driver = openReadOnlyDriver(path);
    expect(() => driver.exec("DELETE FROM t")).toThrow(ReadOnlyDriverError);
    expect(() => driver.prepare("DELETE FROM t").run()).toThrow(ReadOnlyDriverError);
    expect(() => driver.prepare("DELETE FROM t RETURNING id").all()).toThrow(/readonly/);
    expect(driver.prepare("SELECT count(*) AS n FROM t").get()).toEqual({ n: 3 });
    driver.close();
  });

  it("transaction is a plain call that passes results and errors through", () => {
    const driver = openReadOnlyDriver(path);
    expect(driver.transaction(() => 42)).toBe(42);
    expect(() =>
      driver.transaction(() => {
        throw new Error("boom");
      }),
    ).toThrow("boom");
    driver.close();
  });

  it("refuses an integer beyond 2^53 instead of rounding it", () => {
    const driver = openReadOnlyDriver(path);
    expect(() => driver.prepare("SELECT v FROM big").all()).toThrow();
    driver.close();
  });

  it("close closes the connection", () => {
    const driver = openReadOnlyDriver(path);
    const stmt = driver.prepare("SELECT 1");
    driver.close();
    expect(() => stmt.all()).toThrow();
  });
});
