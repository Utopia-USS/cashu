/// <reference types="node" />
// Byte determinism of every `store.table.*` producer (S31a addendum): two independent runs over the
// same source (two `PythonDb` opens, so two genesis runs and two folds, nothing memoized between
// them) write byte-identical files, and a JSON column's integral float (Python stores `18.0`) is
// written as the integer the event log carries (`18`), the form `parity/python/checks/store.py`
// `_json(nested=True)` writes too. Synthetic data only.
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, describe, expect, it } from "vitest";
import { PythonDb } from "../../sources/index.ts";
import { dumps } from "../output.ts";
import { produceStoreTable, STORE_TABLES } from "./tables.ts";

// The schema-only DDL of Alembic revision 0025 committed with the store's genesis test helpers
// (read as a file, as apps/cli does: the store does not export its test code).
const DDL_0025 = new URL(
  "../../../../store/src/genesis/testing/python-schema/0025.sql",
  import.meta.url,
);
const TS = "2026-01-02 03:04:05.000000";

const root = mkdtempSync(join(tmpdir(), "cashu-parity-determinism-"));
const dataDir = join(root, "data");

function writeSource(): void {
  mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(join(dataDir, "cashu.db"));
  try {
    db.exec(readFileSync(DDL_0025, "utf8"));
    db.prepare("INSERT INTO alembic_version (version_num) VALUES (?)").run(
      "0025_topic_view_sources",
    );
    db.prepare(
      "INSERT INTO profiles (id, slug, name, base_currency, mcp_privacy, created_at) VALUES (1, 'syn-a', 'Syn A', 'PLN', 'strict', ?)",
    ).run(TS);
    db.prepare(
      "INSERT INTO profile_modules (profile_id, module_id, enabled, enabled_at) VALUES (1, 'investments', 1, ?)",
    ).run(TS);
    const note = db.prepare(
      `INSERT INTO research_notes (id, profile_id, kind, polarity, strength, thesis_relation, title,
         summary, sources, details, observed_at, expires_at, created_by, created_at, updated_at, segment)
       VALUES (?, 1, 'macro', 'neutral', 2, 'none', ?, 'synthetic', '[]', ?, ?, '2027-01-01 00:00:00.000000',
         'agent', ?, ?, 'swiat')`,
    );
    // Two notes so the producer sorts; one holds integral and fractional floats in its JSON.
    note.run(1, "syn-note-1", '{"pe": 18.0, "growth": 0.12, "n": 3}', TS, TS, TS);
    note.run(2, "syn-note-2", null, TS, TS, TS);
  } finally {
    db.close();
  }
}

/** Every `store.table.*` file of one fresh run, by table. */
function produceAll(): Map<string, string> {
  const db = PythonDb.open({ dataset: "demo", sourceDir: dataDir, runRoot: join(root, "runs") });
  try {
    return new Map(STORE_TABLES.map((t) => [t, dumps(produceStoreTable(db, t))]));
  } finally {
    db.close();
  }
}

writeSource();

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("store.table producers", () => {
  const first = produceAll();
  const second = produceAll();

  it.each(STORE_TABLES.map((t) => [t]))("%s writes the same bytes on two runs", (table) => {
    expect(second.get(table)).toBe(first.get(table));
  });

  it("write a JSON column's integral float as the integer the event log carries", () => {
    const notes = first.get("research_notes") ?? "";
    expect(notes).toContain('"pe":18}');
    expect(notes).toContain('"growth":0.12');
    expect(notes).not.toContain("18.0");
  });
});
