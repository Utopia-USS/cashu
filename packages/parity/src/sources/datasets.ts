/// <reference types="node" />
/**
 * The parity datasets as `parity/python/golden.py` defines them (`DATASETS`, `CLOCKS`). A guard test
 * (`datasets.test.ts`) keeps these in step with golden.py.
 */

import { homedir } from "node:os";
import { join } from "node:path";

const DATASETS = ["demo", "lab"] as const;
export type Dataset = (typeof DATASETS)[number];

/** The frozen local wall clock of each dataset: the day its goldens are "as of". */
export const DATASET_CLOCKS: Readonly<Record<Dataset, string>> = Object.freeze({
  lab: "2026-10-31T12:00:00",
  demo: "2026-10-01T12:00:00",
});

/** `as_of` of every check of the dataset (the clock's date). */
export function datasetAsOf(dataset: Dataset): string {
  return DATASET_CLOCKS[dataset].slice(0, 10);
}

/** The lab root: `$CASHU_LAB_DIR` or `~/cashu-lab` (as the comparer CLI resolves it). */
export function labRoot(env: Record<string, string | undefined> = process.env): string {
  return env.CASHU_LAB_DIR || join(homedir(), "cashu-lab");
}

/** The shared Python golden root (`golden.py` `OUT_ROOT`): `<lab>/parity/out`, written from lab/ts-stack HEAD only. */
export function goldenRoot(env: Record<string, string | undefined> = process.env): string {
  return join(labRoot(env), "parity", "out");
}

/** The shared guard bridge root (`guard_bridge.py --out` default): `<lab>/parity/bridge-mcp`. */
export function bridgeMcpRoot(env: Record<string, string | undefined> = process.env): string {
  return join(labRoot(env), "parity", "bridge-mcp");
}

/** The shared strategy bridge root (`strategy_bridge.py --out` default): `<lab>/parity/bridge-strategy`. */
export function bridgeStrategyRoot(env: Record<string, string | undefined> = process.env): string {
  return join(labRoot(env), "parity", "bridge-strategy");
}

/** The dataset's source dir (golden.py `DATASETS`): never opened directly, only copied. */
export function datasetDir(dataset: Dataset, root: string = labRoot()): string {
  return dataset === "lab" ? join(root, "data") : join(root, "parity", "demo-data");
}

export function isDataset(value: string): value is Dataset {
  return (DATASETS as readonly string[]).includes(value);
}
