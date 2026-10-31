// Table-driven column decoding for the genesis source reader (S26 spec 2.3, 9.2 `source.ts`): a
// table spec names the Python table, its unique read order and one codec per row field. The column
// of a field is its snake_case name (`paramsJson` -> `params_json`), so a spec cannot drift from
// the row interface it is typed against.
import type { SqlValue } from "../sql/driver.js";
import {
  type DecodeResult,
  decodeBool,
  decodeDate,
  decodeDecimal,
  decodeInt,
  decodeJson,
  decodeSource,
  decodeText,
  decodeTimestamp,
  type Source,
} from "./values.js";

/** JSON number tokens `JSON.parse` cannot keep exactly, summed over one row (spec R-G9). */
export interface JsonTally {
  floats: number;
  bigInts: number;
}

export type Codec<T> = (v: SqlValue, tally: JsonTally) => DecodeResult<T>;

export interface TableSpec<R> {
  /** The Python table name (also the counter key). */
  readonly table: string;
  /** Columns of a unique key: every read is `ORDER BY` them, so the row order is stable. */
  readonly key: readonly string[];
  readonly fields: { readonly [K in keyof R]-?: Codec<R[K]> };
}

export function columnOf(field: string): string {
  return field.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

const nullable =
  <T>(codec: Codec<T>): Codec<T | null> =>
  (v, tally) =>
    v === null ? { ok: true, value: null } : codec(v, tally);

const json =
  (shape: { readonly nullable: boolean; readonly empty: "object" | "list" }): Codec<unknown> =>
  (v, tally) => {
    const r = decodeJson(v, shape);
    if (!r.ok) return r;
    tally.floats += r.value.floats;
    tally.bigInts += r.value.bigInts;
    return { ok: true, value: r.value.value };
  };

export const int: Codec<number> = decodeInt;
export const intN: Codec<number | null> = nullable(decodeInt);
export const text: Codec<string> = decodeText;
export const textN: Codec<string | null> = nullable(decodeText);
export const bool: Codec<boolean> = decodeBool;
export const boolN: Codec<boolean | null> = nullable(decodeBool);
export const dec: Codec<string> = decodeDecimal;
export const decN: Codec<string | null> = nullable(decodeDecimal);
export const ts: Codec<string> = decodeTimestamp;
export const tsN: Codec<string | null> = nullable(decodeTimestamp);
export const day: Codec<string> = decodeDate;
export const dayN: Codec<string | null> = nullable(decodeDate);
export const source: Codec<Source> = decodeSource;
/** NOT NULL JSON with a `dict` default (`_json_dict()`). */
export const jsonObject: Codec<unknown> = json({ nullable: false, empty: "object" });
/** NOT NULL JSON with a `list` default (`_json_list()`). */
export const jsonList: Codec<unknown> = json({ nullable: false, empty: "list" });
/** Nullable JSON: SQL NULL and JSON `null` both read as null. */
export const jsonN: Codec<unknown> = json({ nullable: true, empty: "object" });
