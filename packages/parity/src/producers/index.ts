/**
 * The TS parity producers: one function per golden check, each reading the dataset through the
 * read-only source (`../sources`) and returning the check's JSON tree. `cli.ts` runs them and writes
 * `<lab>/parity/ts-out/<dataset>/<check>.json`, the comparer's default actual dir.
 */

import type { Dataset, PythonDb } from "../sources/index.ts";
import { readBridge } from "./core/bridge.ts";
import { produceNetworth } from "./core/networth.ts";
import { producePerformance } from "./investments/performance.ts";
import { produceAllocation, produceValuation } from "./investments/portfolio.ts";
import { readStrategyBridge } from "./investments/strategyBridge.ts";
import { readGuardBridge } from "./mcp/guardBridge.ts";
import { produceMcpRead } from "./mcp/privacy.ts";
import type { OutValue } from "./output.ts";

/** Where the producers read their Python-side inputs (`pnpm parity:produce --golden-root / --bridge-mcp`). */
export interface ProduceInputs {
  /** The Python golden root (`golden.py --out`); the MCP producers read `<root>/lab/mcp.read_raw.json`. */
  readonly goldenRoot: string;
  /** The guard bridge root (`guard_bridge.py --out`). */
  readonly bridgeMcpRoot: string;
}

export interface Producer {
  /** The golden check this producer writes. */
  readonly check: string;
  /** Datasets it is enabled for (a lab check may wait for a later port). */
  readonly datasets: readonly Dataset[];
  readonly produce: (db: PythonDb, inputs: ProduceInputs) => OutValue;
}

export const PRODUCERS: readonly Producer[] = [
  {
    check: "core.networth",
    datasets: ["demo", "lab"],
    produce: (db) => produceNetworth(db, readBridge(db.dataset)),
  },
  {
    check: "investments.valuation",
    datasets: ["demo", "lab"],
    produce: (db) => produceValuation(db, readStrategyBridge(db.dataset)),
  },
  {
    check: "investments.allocation",
    datasets: ["demo", "lab"],
    produce: (db) => produceAllocation(db, readStrategyBridge(db.dataset)),
  },
  {
    check: "investments.performance",
    datasets: ["demo", "lab"],
    produce: (db) => producePerformance(db, readStrategyBridge(db.dataset)),
  },
  {
    check: "mcp.read_strict",
    datasets: ["demo", "lab"],
    produce: (db, inputs) =>
      produceMcpRead(
        db,
        "strict",
        readGuardBridge(db.dataset, inputs.bridgeMcpRoot),
        inputs.goldenRoot,
      ),
  },
  {
    check: "mcp.read_amounts",
    datasets: ["demo", "lab"],
    produce: (db, inputs) =>
      produceMcpRead(
        db,
        "amounts",
        readGuardBridge(db.dataset, inputs.bridgeMcpRoot),
        inputs.goldenRoot,
      ),
  },
];
