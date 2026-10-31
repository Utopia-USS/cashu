/// <reference types="node" />
/**
 * The TS output dir's `index.json`, the producer side of the staleness guard (`../staleness.ts`):
 * per check its row count, sha256, the source commit and dirty state of the tree that produced it,
 * and the Python-side input dirs it read with the commits their own `index.json` recorded then.
 * A `--check` run replaces only its checks' entries, so every file in the dir keeps the commit it
 * was really produced from.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readJson, recordedState, type TreeState } from "../staleness.ts";

interface InputRecord {
  readonly dir: string;
  readonly commit: string | null;
  readonly dirty: boolean;
}

export interface TsIndexEntry {
  readonly check: string;
  readonly rows: number;
  readonly sha256: string;
  readonly commit: string | null;
  readonly dirty: boolean;
  readonly inputs: Readonly<Record<string, InputRecord>>;
}

const FORMAT = 1;

/** The commit / dirty state a Python producer recorded in `<dir>/index.json` (null commit: none). */
function recordedInput(dir: string): InputRecord {
  return { dir, ...recordedState(readJson(join(dir, "index.json")) ?? undefined) };
}

/** Index entry of one produced check. */
export function indexEntry(
  check: string,
  rows: number,
  sha256: string,
  tree: TreeState | null,
  inputs: Readonly<Record<string, string>>,
): TsIndexEntry {
  return {
    check,
    rows,
    sha256,
    commit: tree?.commit ?? null,
    dirty: tree?.dirty ?? false,
    inputs: Object.fromEntries(
      Object.entries(inputs).map(([name, dir]) => [name, recordedInput(dir)]),
    ),
  };
}

/**
 * Merge `produced` into `<dir>/index.json` and drop the entries (and output files) of `failed`
 * checks, so a failed run leaves no older file behind that looks current.
 */
export function updateTsIndex(
  dir: string,
  dataset: string,
  produced: readonly TsIndexEntry[],
  failed: readonly string[],
): void {
  if (produced.length === 0 && failed.length === 0) return;
  mkdirSync(dir, { recursive: true });
  const old = readJson(join(dir, "index.json"));
  const kept = new Map<string, unknown>();
  if (old?.dataset === dataset && Array.isArray(old.checks)) {
    for (const e of old.checks as { check?: unknown }[]) {
      if (typeof e?.check === "string") kept.set(e.check, e);
    }
  }
  for (const check of failed) {
    kept.delete(check);
    rmSync(join(dir, `${check}.json`), { force: true });
  }
  for (const e of produced) kept.set(e.check, e);
  const checks = [...kept.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const index = {
    format: FORMAT,
    producer: "pnpm parity:produce",
    dataset,
    checks: checks.map(([, e]) => e),
  };
  writeFileSync(join(dir, "index.json"), `${JSON.stringify(index, null, 1)}\n`, "utf8");
}
