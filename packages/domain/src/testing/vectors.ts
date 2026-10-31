/// <reference types="node" />
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

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
