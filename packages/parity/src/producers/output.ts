/// <reference types="node" />
/**
 * Producer output: canonical JSON like `parity/python/canon.py` writes it (sorted keys, compact,
 * UTF-8, trailing newline). Decimals are written through their `toJSON()` (Python's `str()`), so a
 * producer passes `Decimal` values straight in; plain JS numbers are refused (money is never a float
 * here). A value Python keeps as a float (weights, drift) is wrapped with `pyFloat(x)` and written
 * like `json.dumps` writes a float (`repr`: `0.1`, `1e-05`, `2.0`); NaN / Infinity become the strings
 * `"NaN"` / `"Infinity"` / `"-Infinity"` as canon.py writes them.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { floatRepr } from "@cashu/domain";

/** A Python float in the output (see `pyFloat`). */
export class PyFloat {
  readonly value: number;
  constructor(value: number) {
    this.value = value;
  }
}

/** Wrap a float the Python check writes as a float. */
export function pyFloat(value: number): PyFloat {
  return new PyFloat(value);
}

function floatJson(x: number): string {
  if (Number.isNaN(x)) return '"NaN"';
  if (x === Number.POSITIVE_INFINITY) return '"Infinity"';
  if (x === Number.NEGATIVE_INFINITY) return '"-Infinity"';
  return floatRepr(x);
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
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canon(obj[k] as OutValue)}`).join(",")}}`;
}

/** Canonical JSON text of a producer result. */
export function dumps(value: OutValue): string {
  return `${canon(value)}\n`;
}

/** Write `<dir>/<check>.json`. */
export function writeCheck(dir: string, check: string, value: OutValue): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${check}.json`);
  writeFileSync(path, dumps(value), "utf8");
  return path;
}
