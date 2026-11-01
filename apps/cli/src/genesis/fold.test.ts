// `--fold` invariants (S26 spec 8.4) on the synthetic data dir: a clean log folds with one view row
// per exported row; a row the export does not list, a missing row and an invalid-gid event fail.
import { join } from "node:path";
import { betterSqlite3Driver } from "@cashu/store";
import * as genesis from "@cashu/store/genesis";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { runFiles } from "./copy.ts";
import { FoldError, foldVault } from "./fold.ts";
import { initKeys } from "./keys.ts";
import { tempDir, writePythonDataDir } from "./testing/pythonDataDir.ts";

function exported() {
  const base = tempDir("fold");
  const data = join(base, "data");
  writePythonDataDir(data);
  const db = new Database(join(data, "cashu.db"), { readonly: true });
  try {
    const keys = initKeys(join(base, "keys.json"), ["ala", "olek"]);
    const result = genesis.genesis(
      { driver: betterSqlite3Driver(db), files: runFiles(data) },
      keys,
      { strict: true, now: Date.parse("2026-06-01T00:00:00Z") },
    );
    const vault = result.vaults[0];
    const k = vault === undefined ? undefined : keys.get(vault.slug);
    if (vault === undefined || k === undefined) throw new Error("no vault");
    return { base, vault, keys: k };
  } finally {
    db.close();
  }
}

const foldError = (f: () => unknown): FoldError => {
  try {
    f();
  } catch (e) {
    if (e instanceof FoldError) return e;
    throw e;
  }
  throw new Error("the fold passed");
};

describe("genesis --fold invariants", () => {
  it("folds a clean log and compares every exported row with the view", () => {
    const { base, vault, keys } = exported();
    const fold = foldVault(join(base, "view.sqlite"), vault, keys);
    expect(fold.view).toMatch(/^[0-9a-f]{64}$/);
    expect(fold.rows).toBe(vault.ids.length);
    expect(fold.tables).toBeGreaterThan(new Set(vault.ids.map((e) => e.table)).size);
  });

  it("fails when the view holds a row the export does not list, naming counts only", () => {
    const { base, vault, keys } = exported();
    const ids = vault.ids.filter((e) => e.table !== "balances");
    const error = foldError(() => foldVault(join(base, "view.sqlite"), { ...vault, ids }, keys));
    expect(error.message).toBe(`vault ${vault.ordinal}: balances view rows 1 != exported rows 0`);
    expect(error.exitCode).toBe(65);
  });

  it("fails when an exported row has no view row", () => {
    const { base, vault, keys } = exported();
    const extra = { table: "alerts", localId: "99", gid: "01JC0ZA1B2C3D4E5F6G7H8J9K0" };
    const error = foldError(() =>
      foldVault(join(base, "view.sqlite"), { ...vault, ids: [...vault.ids, extra] }, keys),
    );
    expect(error.message).toBe(`vault ${vault.ordinal}: alerts view rows 0 != exported rows 1`);
  });

  it("fails on an exported table the view does not have", () => {
    const { base, vault, keys } = exported();
    const extra = { table: "no_such_table", localId: "1", gid: "01JC0ZA1B2C3D4E5F6G7H8J9K0" };
    const error = foldError(() =>
      foldVault(join(base, "view.sqlite"), { ...vault, ids: [...vault.ids, extra] }, keys),
    );
    expect(error.message).toBe(`vault ${vault.ordinal}: 1 exported tables have no view`);
  });

  it("fails on an event parked for an invalid gid", () => {
    const { base, vault, keys } = exported();
    const at = vault.events.findIndex((e) => e.t === "balance.set" || e.t.startsWith("balance"));
    expect(at).toBeGreaterThanOrEqual(0);
    const events = vault.events.map((e, i) =>
      i === at ? { ...e, g: "c1e52d4d-d9a5-84e6-8d7a-c21b36691202" } : e,
    );
    const error = foldError(() => foldVault(join(base, "view.sqlite"), { ...vault, events }, keys));
    expect(error.message).toMatch(/parked 1|unknown events 1/);
  });
});
