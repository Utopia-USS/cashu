/// <reference types="node" />
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/** `packages/domain/test/fixtures/budget-csv` (written by `parity/python/vectors_budget.py`). */
const FIXTURE_DIR = fileURLToPath(
  new URL("../../../../test/fixtures/budget-csv", import.meta.url),
);

/** The repository root (for byte-comparing fixtures with their sources). */
export const REPO_ROOT = fileURLToPath(new URL("../../../../../../", import.meta.url));

/** Bytes of a fixture by its path relative to `FIXTURE_DIR` (`"mbank/mbank-edge.csv"`). */
export function fixtureBytes(rel: string): Uint8Array {
  return new Uint8Array(readFileSync(join(FIXTURE_DIR, rel)));
}

/** Every fixture's relative path, sorted. */
export function fixturePaths(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else out.push(relative(FIXTURE_DIR, full).split("\\").join("/"));
    }
  };
  walk(FIXTURE_DIR);
  return out.sort();
}
