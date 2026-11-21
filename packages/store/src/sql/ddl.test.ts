// View table DDL as data: virtual (FTS5) tables. The generated DDL and its guards, and the engine
// rules for a virtual table on a real database: a full re-fold and a reset clear it with FTS5's
// `delete-all` (a contentless table refuses DELETE), an upgrade drops it with DROP TABLE, it is never
// hashed nor carried by a snapshot, and quick_check passes with it. Synthetic data only.
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { Materializer } from "../engine/types.js";
import { builtinModules } from "../modules.js";
import type { StoreModule } from "../registry.js";
import { exportSnapshot, viewHash } from "../snapshot.js";
import { EventFactory, memoryDriver, openTestStore, testUlid } from "../testing/store.js";
import { bumpVersion } from "../testing/upgrade.js";
import { allColumns, clearTableSql, createTableSql, type TableDef } from "./ddl.js";

const fts: TableDef = {
  name: "test_fts",
  internal: true,
  columns: [{ name: "body", type: "TEXT" }],
  // contentless WITHOUT contentless_delete: DELETE FROM fails, only `delete-all` empties it
  virtual: { using: "fts5", args: ["content=''", "tokenize='unicode61 remove_diacritics 2'"] },
};

describe("virtual tables in TableDef", () => {
  it("generate CREATE VIRTUAL TABLE with the columns, then the options", () => {
    expect(createTableSql(fts)).toBe(
      "CREATE VIRTUAL TABLE IF NOT EXISTS test_fts USING fts5(body, content='', tokenize='unicode61 remove_diacritics 2');",
    );
    expect(allColumns(fts)).toEqual(fts.columns);
    expect(clearTableSql(fts)).toBe("INSERT INTO test_fts(test_fts) VALUES('delete-all')");
    expect(clearTableSql({ name: "plain", columns: [] })).toBe("DELETE FROM plain");
  });

  it("refuse public, keyed or indexed virtual tables and options that are not key=value", () => {
    expect(() => createTableSql({ ...fts, internal: false })).toThrow(RangeError);
    expect(() => createTableSql({ ...fts, primaryKey: ["body"] })).toThrow(RangeError);
    expect(() => createTableSql({ ...fts, indexes: [{ columns: ["body"] }] })).toThrow(RangeError);
    expect(() => createTableSql({ ...fts, withoutRowid: true })).toThrow(RangeError);
    for (const bad of ["content='') ; DROP TABLE x; --", "tokenize='a'b'", "detail full"]) {
      expect(() => createTableSql({ ...fts, virtual: { using: "fts5", args: [bad] } })).toThrow(
        RangeError,
      );
    }
  });
});

// A test module whose materializer owns the virtual table (notes indexed by their text).
function ftsNotes(version: number): Materializer {
  return {
    id: "test.ftsnotes",
    version,
    tables: [fts],
    handles: ["testFtsNote.set"],
    partitions: (e) => [e.gid],
    clear() {
      throw new Error("never re-folded by partition in this test (notes arrive in order)");
    },
    apply(e, ctx) {
      ctx.sql.insert(
        "test_fts",
        "INSERT INTO test_fts (rowid, body)",
        "(?, ?)",
        ctx.id(e.gid),
        String(e.data.text),
      );
    },
  };
}

const meta = { table: "test_fts", rule: "LWW-F", gid: "ULID", emitter: "any" } as const;
const noteEvents = [
  { type: "testFtsNote.set", v: 1, schema: z.looseObject({ text: z.string() }), meta },
] as const;

const withNotes = (mat: Materializer): StoreModule[] => [
  ...builtinModules(),
  { id: "test", materializers: [mat], events: noteEvents },
];

describe("virtual tables in the engine", () => {
  it("re-fold, upgrade drop, reset, hash, snapshot and quick_check", () => {
    const driver = memoryDriver();
    const store = openTestStore({ driver, modules: withNotes(ftsNotes(1)) });
    const f = new EventFactory();
    const texts = ["Żabka Łódź", "ORLEN stacja", "żabka nowa"];
    store.applyEnvelopes(
      texts.map((text, i) => f.make("testFtsNote.set", testUlid("01JK", i), { text })),
    );
    const hits = (s: typeof store, q: string) =>
      s.read<{ n: number }>("SELECT count(*) AS n FROM test_fts WHERE test_fts MATCH ?", q)[0]?.n;
    expect(hits(store, "zabka")).toBe(2);
    const hash = viewHash(store);
    expect(Object.keys(hash.tables)).not.toContain("test_fts");
    expect(Object.keys(exportSnapshot(store).tables)).not.toContain("test_fts");
    // a full re-fold empties it with delete-all (DELETE FROM is refused) and folds again
    expect(() => driver.exec("DELETE FROM test_fts")).toThrow(/contentless/);
    store.rebuild();
    expect(hits(store, "zabka")).toBe(2);
    expect(hits(store, "orlen")).toBe(1);
    expect(viewHash(store).hash).toBe(hash.hash);
    store.detach();
    // a new materializer version: the upgrade drops the virtual table and builds it again
    const upgraded = openTestStore({
      driver,
      modules: bumpVersion(withNotes(ftsNotes(1)), "test.ftsnotes"),
    });
    expect(upgraded.lastRebuild).toMatchObject({
      scope: "partial",
      materializers: ["test.ftsnotes"],
    });
    expect(hits(upgraded, "zabka")).toBe(2);
    expect(
      driver.prepare("PRAGMA quick_check(1)").all<Record<string, string>>().map(Object.values),
    ).toEqual([["ok"]]);
    upgraded.reset();
    expect(hits(upgraded, "zabka")).toBe(0);
    upgraded.close();
  });
});
