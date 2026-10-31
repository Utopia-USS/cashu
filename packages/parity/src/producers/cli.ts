/// <reference types="node" />
/**
 * `pnpm parity:produce --dataset demo|lab [--check <name>]... [--out <dir>] [--force]`: run the TS
 * producers and write their outputs for the comparer (`pnpm parity`). Prints check names, row counts
 * and hashes only, never values (the lab dataset is real data).
 */

import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { isDataset, labRoot, withPythonDb } from "../sources/index.ts";
import { PRODUCERS } from "./index.ts";
import { dumps, writeCheck } from "./output.ts";

function rows(value: unknown): number {
  if (Array.isArray(value)) return value.length;
  if (value !== null && typeof value === "object") {
    return Object.values(value).reduce<number>(
      (n, v) =>
        n + (Array.isArray(v) || (v !== null && typeof v === "object") ? Object.keys(v).length : 1),
      0,
    );
  }
  return 1;
}

export function main(argv: string[]): number {
  const { values } = parseArgs({
    args: argv,
    options: {
      dataset: { type: "string" },
      check: { type: "string", multiple: true },
      out: { type: "string" },
      force: { type: "boolean", default: false },
    },
  });
  const dataset = values.dataset ?? "";
  if (!isDataset(dataset)) {
    process.stderr.write(
      "usage: pnpm parity:produce --dataset demo|lab [--check name] [--out dir]\n",
    );
    return 64;
  }
  const wanted = values.check ?? [];
  const selected = PRODUCERS.filter((p) => wanted.length === 0 || wanted.includes(p.check));
  const unknown = wanted.filter((c) => !PRODUCERS.some((p) => p.check === c));
  if (unknown.length > 0) {
    process.stderr.write(`no producer for: ${unknown.join(", ")}\n`);
    return 64;
  }
  const out = values.out ? resolve(values.out) : join(labRoot(), "parity", "ts-out", dataset);
  return withPythonDb({ dataset }, (db) => {
    let status = 0;
    for (const p of selected) {
      if (!p.datasets.includes(dataset) && !values.force) {
        process.stdout.write(
          `[${dataset}] ${p.check.padEnd(34)} skipped (not enabled for ${dataset})\n`,
        );
        continue;
      }
      try {
        const value = p.produce(db);
        writeCheck(out, p.check, value);
        const sha = createHash("sha256").update(dumps(value)).digest("hex");
        process.stdout.write(
          `[${dataset}] ${p.check.padEnd(34)} rows=${rows(value)} sha256=${sha.slice(0, 16)}\n`,
        );
      } catch (e) {
        status = 1;
        // The error class only: messages could carry data.
        process.stdout.write(`[${dataset}] ${p.check.padEnd(34)} ERROR ${(e as Error).name}\n`);
        if (process.env.CASHU_PARITY_DEBUG && dataset === "demo") console.error(e);
      }
    }
    return status;
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
