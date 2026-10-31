/**
 * Column decoders of the read-only source: SQLite values (read with `setReadBigInts`) to typed
 * fields. A value of the wrong type throws (naming the column only, never the value).
 */

import type { SqlValue } from "./naturalKeys.ts";

export type Row = Readonly<Record<string, SqlValue>>;

export function int(row: Row, col: string): number {
  const v = row[col];
  if (typeof v === "bigint" && v <= BigInt(Number.MAX_SAFE_INTEGER)) return Number(v);
  if (typeof v === "number" && Number.isSafeInteger(v)) return v;
  throw new Error(`column ${col} is not an integer`);
}

export function intOrNull(row: Row, col: string): number | null {
  return row[col] === null ? null : int(row, col);
}

export function text(row: Row, col: string): string {
  const v = row[col];
  if (typeof v === "string") return v;
  throw new Error(`column ${col} is not text`);
}

export function textOrNull(row: Row, col: string): string | null {
  return row[col] === null ? null : text(row, col);
}

export function bool(row: Row, col: string): boolean {
  return int(row, col) !== 0;
}

export function boolOrNull(row: Row, col: string): boolean | null {
  return row[col] === null ? null : bool(row, col);
}

/**
 * A SQLAlchemy `JSON` column holding a list of strings: SQL NULL and the JSON text `null` (how the
 * ORM stores Python None by default) are both null.
 */
export function stringListOrNull(row: Row, col: string): string[] | null {
  const raw = textOrNull(row, col);
  if (raw === null) return null;
  const value: unknown = JSON.parse(raw);
  if (value === null) return null;
  if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) {
    throw new Error(`column ${col} is not a JSON list of strings`);
  }
  return value;
}
