/// <reference types="node" />
/**
 * `pnpm parity:produce --dataset demo|lab [--check <name>]... [--out <dir>] [--golden-root <dir>]
 * [--force]`: run the TS producers and write their outputs for the comparer
 * (`pnpm parity`). `--out` is the TS output dir (default `<lab>/parity/ts-out/<dataset>`);
 * `--golden-root` is where the Python-side inputs were written (`golden.py --out`;
 * default: the shared dir, which only lab/ts-stack HEAD writes). Prints
 * check names, row counts and hashes only, never values (the lab dataset is real data). `index.json`
 * in the output dir records, per check, the source commit, the dirty state and the inputs' commits
 * (`tsIndex.ts`), which the comparer's staleness guard checks.
 */

import { createHash } from "node:crypto";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { goldenRoot, isDataset, labRoot, withPythonDb } from "../sources/index.ts";
import { readTreeState } from "../staleness.ts";
import { inputDir, PRODUCERS } from "./index.ts";
import { dumps, writeCheck } from "./output.ts";
import { useBridgeStoreSource } from "./store/genesisRun.ts";
import { indexEntry, type TsIndexEntry, updateTsIndex } from "./tsIndex.ts";

/** The repository root: this file is `packages/parity/src/producers/cli.ts`. */
const REPO_ROOT = resolve(import.meta.dirname, "..", "..", "..", "..");

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
      "golden-root": { type: "string" },
      force: { type: "boolean", default: false },
      "source-dir": { type: "string" },
      "store-source": { type: "string" },
    },
  });
  const dataset = values.dataset ?? "";
  if (!isDataset(dataset)) {
    process.stderr.write(
      "usage: pnpm parity:produce --dataset demo|lab [--check name] [--out dir] [--golden-root dir]\n",
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
  const inputs = {
    goldenRoot: values["golden-root"] ? resolve(values["golden-root"]) : goldenRoot(),
  };
  const tree = readTreeState(REPO_ROOT);
  if (tree === null)
    process.stdout.write(`[${dataset}] warning: no git HEAD, no source commit recorded\n`);
  else if (tree.dirty)
    process.stdout.write(`[${dataset}] note: dirty tree at ${tree.commit.slice(0, 12)}\n`);
  const produced: TsIndexEntry[] = [];
  const failed: string[] = [];
  // TRANSITIONAL(S49): the S31a milestone reads a bridge run: the run's data copy as the source and
  // its verifier stores as the `store.table.*` views. Both must lie under <lab>/parity.
  const parityDir = join(labRoot(), "parity");
  const underParity = (dir: string) => {
    const rel = relative(parityDir, resolve(dir));
    return rel !== "" && !rel.startsWith("..") && !rel.startsWith("/");
  };
  const sourceDir = values["source-dir"];
  const storeSource = values["store-source"];
  if (sourceDir !== undefined && !underParity(sourceDir)) {
    process.stderr.write("--source-dir must be inside <lab>/parity\n");
    return 64;
  }
  if (storeSource !== undefined) {
    const run = storeSource.startsWith("bridge:") ? storeSource.slice("bridge:".length) : "";
    if (run === "" || !underParity(run)) {
      process.stderr.write("--store-source takes bridge:<run dir inside <lab>/parity>\n");
      return 64;
    }
    useBridgeStoreSource(resolve(run));
  }
  const open = sourceDir === undefined ? { dataset } : { dataset, sourceDir: resolve(sourceDir) };
  const status = withPythonDb(open, (db) => {
    let status = 0;
    for (const p of selected) {
      if (!p.datasets.includes(dataset) && !values.force) {
        process.stdout.write(
          `[${dataset}] ${p.check.padEnd(34)} skipped (not enabled for ${dataset})\n`,
        );
        continue;
      }
      try {
        const value = p.produce(db, inputs);
        writeCheck(out, p.check, value);
        const sha = createHash("sha256").update(dumps(value)).digest("hex");
        const dirs = Object.fromEntries(p.inputs.map((n) => [n, inputDir(n, dataset, inputs)]));
        produced.push(indexEntry(p.check, rows(value), sha, tree, dirs));
        for (const [name, rec] of Object.entries(produced.at(-1)?.inputs ?? {})) {
          // A committed input (golden-demo) is versioned with the code; the comparer cross-checks it.
          if (rec.commit === tree?.commit || !relative(REPO_ROOT, rec.dir).startsWith(".."))
            continue;
          const from = rec.commit === null ? "no recorded commit" : rec.commit.slice(0, 12);
          process.stdout.write(
            `[${dataset}] ${p.check.padEnd(34)} warning: input ${name} is from ${from}\n`,
          );
        }
        process.stdout.write(
          `[${dataset}] ${p.check.padEnd(34)} rows=${rows(value)} sha256=${sha.slice(0, 16)}\n`,
        );
      } catch (e) {
        status = 1;
        failed.push(p.check);
        // The error class only: messages could carry data.
        process.stdout.write(`[${dataset}] ${p.check.padEnd(34)} ERROR ${(e as Error).name}\n`);
        if (process.env.CASHU_PARITY_DEBUG && dataset === "demo") console.error(e);
      }
    }
    return status;
  });
  updateTsIndex(out, dataset, produced, failed);
  return status;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
