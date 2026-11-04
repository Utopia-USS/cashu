/// <reference types="node" />
/** Parity output filesystem adapter. Canonical value identity lives in the portable store verifier. */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dumps, type OutValue } from "@cashu/store/genesis/verification";

export { dumps, PyFloat, pyFloat, type OutValue } from "@cashu/store/genesis/verification";

/** Write `<dir>/<check>.json` with the shared canonical printer. */
export function writeCheck(dir: string, check: string, value: OutValue): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${check}.json`);
  writeFileSync(path, dumps(value), "utf8");
  return path;
}
