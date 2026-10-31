// View table definitions as data. DDL, the view hash and snapshots are generated from them, so a
// table is declared once. Public tables mirror today's Python table and column names (minus
// `profile_id`: one view database per vault) plus `gid TEXT NOT NULL UNIQUE`; internal tables
// (`fold_*`) hold fold registers Python does not store and are invisible to queries and hashes.

export type ColumnType = "INTEGER" | "TEXT" | "REAL" | "BLOB";

export interface ColumnDef {
  readonly name: string;
  readonly type: ColumnType;
  readonly notNull?: boolean;
  /** SQL literal default, e.g. `0`, `'neutral'`. */
  readonly default?: string;
  /** View-local integer reference to `<table>.id` (hashed as the referenced row's gid). */
  readonly ref?: string;
  /** JSON text (hashed canonically). */
  readonly json?: boolean;
}

export interface IndexDef {
  readonly columns: readonly string[];
  readonly unique?: boolean;
  readonly where?: string;
}

export interface TableDef {
  readonly name: string;
  readonly columns: readonly ColumnDef[];
  /**
   * Primary key columns. Default: `id INTEGER PRIMARY KEY` is added in front and `gid TEXT NOT NULL
   * UNIQUE` after it (the shape of every public row table).
   */
  readonly primaryKey?: readonly string[];
  readonly indexes?: readonly IndexDef[];
  /** Fold-internal table: not reported as touched, not hashed, not queryable by convention. */
  readonly internal?: boolean;
  readonly withoutRowid?: boolean;
}

/** The columns of a table as stored, including the implicit `id` / `gid`. */
export function allColumns(t: TableDef): readonly ColumnDef[] {
  if (t.primaryKey) return t.columns;
  return [
    { name: "id", type: "INTEGER", notNull: true },
    { name: "gid", type: "TEXT", notNull: true },
    ...t.columns,
  ];
}

const IDENT = /^[a-z_][a-z0-9_]*$/;

function ident(name: string): string {
  if (!IDENT.test(name)) throw new RangeError(`invalid SQL identifier: ${name}`);
  return name;
}

/** The name of an index of `t` (one generator for create and drop). */
export function indexName(t: TableDef, ix: IndexDef): string {
  return ident(`${t.name}_${ix.columns.join("_")}${ix.unique ? "_uq" : "_ix"}`);
}

/** `CREATE INDEX` for one index of `t`. */
export function createIndexSql(t: TableDef, ix: IndexDef): string {
  const where = ix.where ? ` WHERE ${ix.where}` : "";
  return `CREATE ${ix.unique ? "UNIQUE " : ""}INDEX IF NOT EXISTS ${indexName(t, ix)} ON ${t.name} (${ix.columns.map(ident).join(", ")})${where};`;
}

/**
 * Indexes a full re-fold may drop and build again after the rows are in (one sort instead of a
 * B-tree insert per row): plain secondary indexes. Unique ones stay (they carry the folds' CREATE /
 * `INSERT OR IGNORE` semantics), partial ones too.
 */
export function bulkIndexes(t: TableDef): readonly IndexDef[] {
  return (t.indexes ?? []).filter((ix) => !ix.unique && ix.where === undefined);
}

export function createTableSql(t: TableDef): string {
  const cols = allColumns(t).map((c) => {
    if (!t.primaryKey && c.name === "id") return "id INTEGER PRIMARY KEY";
    if (!t.primaryKey && c.name === "gid") return "gid TEXT NOT NULL UNIQUE";
    let s = `${ident(c.name)} ${c.type}`;
    if (c.notNull) s += " NOT NULL";
    if (c.default !== undefined) s += ` DEFAULT ${c.default}`;
    return s;
  });
  if (t.primaryKey) cols.push(`PRIMARY KEY (${t.primaryKey.map(ident).join(", ")})`);
  const tail = t.withoutRowid ? " WITHOUT ROWID" : "";
  const parts = [
    `CREATE TABLE IF NOT EXISTS ${ident(t.name)} (\n  ${cols.join(",\n  ")}\n)${tail};`,
  ];
  for (const ix of t.indexes ?? []) parts.push(createIndexSql(t, ix));
  return parts.join("\n");
}
