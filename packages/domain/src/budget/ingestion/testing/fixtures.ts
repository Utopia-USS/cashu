/// <reference types="node" />
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** `packages/domain/test/fixtures/budget-csv` (written by the retired Python `vectors_budget.py`). */
const FIXTURE_DIR = fileURLToPath(new URL("../../../../test/fixtures/budget-csv", import.meta.url));

/** The repository root (the committed schema and docs the tests compare with). */
export const REPO_ROOT = fileURLToPath(new URL("../../../../../../", import.meta.url));

/** Bytes of a fixture by its path relative to `FIXTURE_DIR` (`"mbank/mbank-edge.csv"`). */
export function fixtureBytes(rel: string): Uint8Array {
  return new Uint8Array(readFileSync(join(FIXTURE_DIR, rel)));
}
