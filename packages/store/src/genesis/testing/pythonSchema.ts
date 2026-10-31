// Synthetic Python-schema databases for genesis tests (S26 spec 10, 9.2 `testing/pythonSchema.ts`).
//
// How the DDL was produced (schema only, never data): in the cashu-next-2 checkout, after checking
// that `paths.data_dir()` pointed at the lab scratch dir, `alembic upgrade <rev>` with
// `CASHU_DATA_DIR` set to an empty temp dir, then `sqlite3 cashu.db .schema`:
// - `python-schema/0025.sql`: revision 0025_topic_view_sources, verbatim.
// - 0026 = 0025 + migration 0026's own `ALTER TABLE inv_theses ADD COLUMN exit_plan_changed_at`
//   (its backfill UPDATE has no rows to touch in a new database).
// - `python-schema/sync-0027-0028.sql`: the sync_* tables and indexes of revision 0028_sync_inbound
//   (`SELECT sql FROM sqlite_master WHERE tbl_name LIKE 'sync\_%'`); 0028 = 0026 + these.
// - `python-schema/head-columns.txt`: `table.column:type:notnull:pk` of every table of a fresh
//   `cashu init-db` database (head = 0028), from `pragma_table_info`; the test compares the
//   databases built here against it. The 0028 listing matched the alembic-built 0028 database.
// Regenerate all four when a Python migration lands.
import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { betterSqlite3Driver } from "../../sql/better-sqlite3.js";
import type { SqlDriver } from "../../sql/driver.js";

type PythonSchema = "0025" | "0026" | "0028";

const REVISION: Readonly<Record<PythonSchema, string>> = {
  "0025": "0025_topic_view_sources",
  "0026": "0026_thesis_exit_plan_changed_at",
  "0028": "0028_sync_inbound",
};

const file = (name: string) =>
  readFileSync(new URL(`./python-schema/${name}`, import.meta.url), "utf8");

const EXIT_PLAN_COLUMN = "ALTER TABLE inv_theses ADD COLUMN exit_plan_changed_at DATETIME;\n";

/** The DDL of a Python schema revision (without the `alembic_version` row). */
function pythonSchemaDdl(schema: PythonSchema): string {
  const ddl = file("0025.sql");
  if (schema === "0025") return ddl;
  if (schema === "0026") return ddl + EXIT_PLAN_COLUMN;
  return ddl + EXIT_PLAN_COLUMN + file("sync-0027-0028.sql");
}

/**
 * A new in-memory database at `schema`, `alembic_version` set, no rows. Foreign keys are not
 * enforced (Python enforces them, better-sqlite3 by default too) so a test can plant the dangling
 * and unscoped rows older databases carry and genesis must count (gid.md 7.6).
 */
export function pythonDb(schema: PythonSchema = "0026"): SqlDriver {
  const driver = betterSqlite3Driver(new Database(":memory:"));
  driver.exec("PRAGMA foreign_keys = OFF");
  driver.exec(pythonSchemaDdl(schema));
  driver.prepare("INSERT INTO alembic_version (version_num) VALUES (?)").run(REVISION[schema]);
  return driver;
}

/** `table.column:type:notnull:pk` of every table, the format of `head-columns.txt`. */
export function schemaListing(driver: SqlDriver): string[] {
  return driver
    .prepare(
      `SELECT m.name || '.' || p.name || ':' || p.type || ':' || p."notnull" || ':' || p.pk AS line
       FROM sqlite_master m, pragma_table_info(m.name) p
       WHERE m.type = 'table' ORDER BY m.name, p.cid`,
    )
    .all<{ line: string }>()
    .map((r) => r.line);
}

/** The committed listing of a fresh head (0028) database. */
export function headListing(): string[] {
  return file("head-columns.txt")
    .split("\n")
    .filter((l) => l !== "");
}
