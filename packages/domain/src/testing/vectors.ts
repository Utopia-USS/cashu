/// <reference types="node" />
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";

export interface VectorFile {
  readonly meta: { readonly name: string; readonly count: number; readonly layout: string };
  readonly rows: readonly unknown[][];
}

/** Loads `packages/domain/test/vectors/<name>.jsonl` (written by `parity/python/vectors.py`). */
export function loadVectors(name: string): VectorFile {
  const url = new URL(`../../test/vectors/${name}.jsonl`, import.meta.url);
  const lines = readFileSync(fileURLToPath(url), "utf8")
    .split("\n")
    .filter((line) => line !== "");
  const head = JSON.parse(lines[0] as string) as { meta: VectorFile["meta"] };
  const rows = lines.slice(1).map((line) => JSON.parse(line) as unknown[]);
  if (rows.length !== head.meta.count) {
    throw new Error(`${name}: ${rows.length} rows, meta says ${head.meta.count}`);
  }
  return { meta: head.meta, rows };
}

/** Collects mismatches so a failing suite reports the first few instead of stopping at one. */
export class Mismatches {
  readonly items: string[] = [];
  checked = 0;

  check(label: string, actual: unknown, expected: unknown): void {
    this.checked++;
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a !== e) this.items.push(`${label}: got ${a}, want ${e}`);
  }

  report(): string {
    return `${this.items.length} of ${this.checked} mismatched:\n${this.items.slice(0, 25).join("\n")}`;
  }
}

/** The assertion every vector test ends with: no mismatch, and something was checked. */
export function expectAll(m: Mismatches): void {
  expect(m.items, m.report()).toEqual([]);
  expect(m.checked).toBeGreaterThan(0);
}

/** Runs `fn`, mapping a thrown error with a Python class name to `{error: name}` like the vectors. */
export function outcome<T>(
  fn: () => T,
  errorName: (error: unknown) => string | null,
): T | { error: string } {
  try {
    return fn();
  } catch (error) {
    const name = errorName(error);
    if (name === null) throw error;
    return { error: name };
  }
}

export const BLOCK_SIZE = 4096;
export const BLOCKS_PER_PLANE = 0x10000 / BLOCK_SIZE;
/** The 17 Unicode planes: the unit of the code point sweeps (one test each). */
export const PLANES: readonly number[] = Array.from({ length: 0x110000 / 0x10000 }, (_, i) => i);

/**
 * sha256 (first 16 hex digits) of fn(chr(c)) joined by NUL over one 4096-code-point block, surrogates
 * skipped (as `parity/python/vectors.py`). One digest input per block: the same bytes as feeding the
 * hash per code point, without two native hash calls per code point.
 */
export function blockHash(fn: (s: string) => string, block: number): string {
  let joined = "";
  for (let c = block * BLOCK_SIZE; c < (block + 1) * BLOCK_SIZE; c++) {
    if (c >= 0xd800 && c <= 0xdfff) continue;
    joined += `${fn(String.fromCodePoint(c))}\0`;
  }
  return createHash("sha256").update(joined, "utf8").digest("hex").slice(0, 16);
}
