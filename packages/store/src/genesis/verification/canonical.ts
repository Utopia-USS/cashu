/**
 * Canonical values of the `store.table.*` rows (S26 spec 8.1; the retired Python parity check `checks/store.py`
 * `_value` / `_json` / `_timestamp`): timestamps `YYYY-MM-DDTHH:MM:SS.ffffff` (UTC, six digits, no
 * `Z`), dates ISO, decimals as their plain strings, integers as `bigint`, JSON with integers as
 * `bigint` and fractions as Python floats, rows sorted by the UTF-8 bytes of their canonical JSON.
 */

import { floatRepr } from "@cashu/domain";

/** Portable canonical value model shared by migration and parity. */
export class PyFloat {
  readonly value: number;
  constructor(value: number) {
    this.value = value;
  }
}

export function pyFloat(value: number): PyFloat {
  return new PyFloat(value);
}

export type OutValue =
  | null
  | boolean
  | string
  | bigint
  | PyFloat
  | { toJSON(): string }
  | readonly OutValue[]
  | { readonly [key: string]: OutValue };

function floatJson(x: number): string {
  if (Number.isNaN(x)) return '"NaN"';
  if (x === Number.POSITIVE_INFINITY) return '"Infinity"';
  if (x === Number.NEGATIVE_INFINITY) return '"-Infinity"';
  return floatRepr(x);
}

function canon(value: OutValue): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number")
    throw new Error("producers write decimals or integers, not floats");
  if (value instanceof PyFloat) return floatJson(value.value);
  if (Array.isArray(value)) return `[${value.map(canon).join(",")}]`;
  if ("toJSON" in value && typeof value.toJSON === "function")
    return JSON.stringify(value.toJSON());
  const obj = value as { readonly [key: string]: OutValue };
  const keys = Object.keys(obj).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canon(obj[key] as OutValue)}`).join(",")}}`;
}

export function dumps(value: OutValue): string {
  return `${canon(value)}\n`;
}

export type CanonRow = Readonly<Record<string, OutValue>>;

/** An event timestamp (`...T..[.f]Z`) or a view timestamp (`... ..ffffff`) in canonical form. */
export function timestamp(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?Z?$/.exec(String(value));
  if (m === null) throw new RangeError("not a timestamp");
  return `${m[1]}T${m[2]}.${(m[3] ?? "").padEnd(6, "0")}`;
}

/** A text (or null) value as stored: dates, decimals, enums, plain strings. */
export function text(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw new TypeError("expected a string");
  return value;
}

/** An integer column (SQLite integer or a payload number). */
export function int(value: unknown): bigint | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value);
  throw new TypeError("expected an integer");
}

/** A boolean column (SQLite 0 / 1 or a payload boolean). */
export function bool(value: unknown): boolean | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean") return value;
  if (value === 0 || value === 1 || value === 0n || value === 1n) return Number(value) === 1;
  throw new TypeError("expected a boolean");
}

/**
 * A JSON value with every string `mapString` maps replaced (gids -> natural keys); numbers become
 * `bigint` (integers) or Python floats (fractions), as Python's `json.loads` reads them back.
 */
/** `mapString`'s answer for a reference to a row that no longer exists: dropped from a list, null. */
export const DANGLING: unique symbol = Symbol("dangling");

export function json(
  value: unknown,
  mapString: (s: string) => string | undefined | typeof DANGLING,
): OutValue {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const mapped = mapString(value);
    return mapped === DANGLING ? null : (mapped ?? value);
  }
  if (typeof value === "number") {
    return Number.isSafeInteger(value) ? BigInt(value) : pyFloat(value);
  }
  if (Array.isArray(value)) {
    // A dangling id in a list is dropped, as store.py's canonical form drops it.
    return value
      .filter((v) => typeof v !== "string" || mapString(v) !== DANGLING)
      .map((v) => json(v, mapString));
  }
  if (typeof value === "object") {
    const out: Record<string, OutValue> = {};
    for (const [k, v] of Object.entries(value)) out[k] = json(v, mapString);
    return out;
  }
  throw new TypeError("no canonical JSON form");
}

const utf8 = new TextEncoder();

/** Rows sorted by the UTF-8 bytes of their canonical JSON (store.py: `canon.dumps(r).encode()`). */
export function sortRows(rows: readonly CanonRow[]): CanonRow[] {
  const keyed = rows.map((row) => ({ row, bytes: utf8.encode(dumps(row)) }));
  keyed.sort((a, b) => compareBytes(a.bytes, b.bytes));
  return keyed.map((k) => k.row);
}

/** Python's order of two strings by their UTF-8 bytes (code point order). */
export function compareUtf8(a: string, b: string): number {
  return compareBytes(utf8.encode(a), utf8.encode(b));
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const d = (a[i] as number) - (b[i] as number);
    if (d !== 0) return d;
  }
  return a.length - b.length;
}
