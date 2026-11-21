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
  /**
   * Fold-internal table: not reported as touched, not hashed, not queryable by convention (a deriver's
   * aggregate a query reads declares `wakesWith`).
   */
  readonly internal?: boolean;
  /**
   * An internal table queries read (a deriver's aggregate): the public tables written in every apply
   * that changes it. `Store.tablesRead` reports them for a SQL that names this table, so a live query
   * over it wakes with them without reading them. Only on `internal` tables, naming public ones.
   */
  readonly wakesWith?: readonly string[];
  readonly withoutRowid?: boolean;
  /**
   * A virtual table (`CREATE VIRTUAL TABLE <name> USING <using>(<columns>, <args>)`): an FTS5 index
   * a deriver owns. Its `columns` are the module's column names (types are not part of its DDL); `args`
   * are the module options (e.g. `content=''`, `tokenize='...'`). It must be `internal`, with no
   * primary key, indexes or `withoutRowid`. The engine clears it with `clearTableSql`, never hashes it
   * (a contentless table reads its columns as NULL) and leaves it out of snapshots (`inSnapshot`): the
   * owning deriver's `deriveAll` builds it again from the tables it is a function of (snapshot.ts).
   */
  readonly virtual?: { readonly using: "fts5"; readonly args: readonly string[] };
  /**
   * `false`: left out of snapshots like a virtual table, for a deriver's internal table that only
   * makes sense with one it owns (an index's memory of what it indexed). `importSnapshot` rebuilds
   * every such table and every virtual one in one path: their owners' `deriveAll`
   * (`Store.rederiveSnapshotOmitted`). Only on `internal` tables of a deriver.
   */
  readonly snapshot?: false;
}

/** Whether snapshots carry the table (not a virtual table, not `snapshot: false`). */
export function inSnapshot(t: TableDef): boolean {
  return t.virtual === undefined && t.snapshot !== false;
}

/** The columns of a table as stored, including the implicit `id` / `gid` (none on a virtual table). */
export function allColumns(t: TableDef): readonly ColumnDef[] {
  if (t.primaryKey || t.virtual) return t.columns;
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

/** The statement that empties a view table (truncate; an FTS5 table takes its `delete-all` command). */
export function clearTableSql(t: TableDef): string {
  if (t.virtual) return `INSERT INTO ${ident(t.name)}(${ident(t.name)}) VALUES('delete-all')`;
  return `DELETE FROM ${ident(t.name)}`;
}

/** FTS5 options: `key=value` with a quoted or bare value (no statement can hide in one). */
const VIRTUAL_ARG = /^[a-z_]+=(?:'[^']*'|[a-z0-9_]+)$/;

function createVirtualTableSql(t: TableDef, v: NonNullable<TableDef["virtual"]>): string {
  if (!t.internal || t.primaryKey || t.indexes?.length || t.withoutRowid) {
    throw new RangeError(`virtual table ${t.name}: internal only, no keys or indexes`);
  }
  for (const a of v.args) {
    if (!VIRTUAL_ARG.test(a)) throw new RangeError(`virtual table ${t.name}: invalid option ${a}`);
  }
  const args = [...t.columns.map((c) => ident(c.name)), ...v.args];
  return `CREATE VIRTUAL TABLE IF NOT EXISTS ${ident(t.name)} USING ${v.using}(${args.join(", ")});`;
}

export function createTableSql(t: TableDef): string {
  if (t.virtual) return createVirtualTableSql(t, t.virtual);
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
