/// <reference types="node" />
/**
 * Producer output: canonical JSON like `parity/python/canon.py` writes it (sorted keys, compact,
 * UTF-8, trailing newline). Decimals are written through their `toJSON()` (Python's `str()`), so a
 * producer passes `Decimal` values straight in; plain JS numbers are refused (money is never a float
 * here; a check with float values converts them explicitly before writing).
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type OutValue =
  | null
  | boolean
  | string
  | bigint
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
