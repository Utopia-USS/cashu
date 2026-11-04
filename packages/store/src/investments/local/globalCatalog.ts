import type { SqlDriver } from "../../sql/driver.js";

export interface SourceGlobalCatalogRow {
  readonly kind: "instrument" | "alias";
  readonly id: number;
  /** Canonical JSON of every original SQLite column, including source IDs and raw JSON text. */
  readonly sourceJson: string;
}

/** Device-local source catalog rows that had no profile reference at import time. */
export class SqlGlobalCatalog {
  private readonly driver: SqlDriver;
  constructor(driver: SqlDriver) {
    this.driver = driver;
    driver.exec(`CREATE TABLE IF NOT EXISTS local_source_global_catalog (
      kind TEXT NOT NULL CHECK(kind IN ('instrument','alias')),
      id INTEGER NOT NULL CHECK(id>0), source_json TEXT NOT NULL,
      PRIMARY KEY(kind,id)
    )`);
  }

  restore(rows: readonly SourceGlobalCatalogRow[]): void {
    const insert = this.driver.prepare(
      "INSERT INTO local_source_global_catalog(kind,id,source_json) VALUES (?,?,?)",
    );
    for (const row of rows) insert.run(row.kind, row.id, row.sourceJson);
  }

  /** Read exact original column values without assigning global rows to any vault. */
  rows(): readonly SourceGlobalCatalogRow[] {
    return this.driver
      .prepare(
        "SELECT kind,id,source_json AS sourceJson FROM local_source_global_catalog ORDER BY kind,id",
      )
      .all<SourceGlobalCatalogRow>();
  }
}
