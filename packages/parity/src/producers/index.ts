/**
 * The TS parity producers: one function per golden check, each reading the dataset through the
 * read-only source (`../sources`) and returning the check's JSON tree. `cli.ts` runs them and writes
 * `<lab>/parity/ts-out/<dataset>/<check>.json`, the comparer's default actual dir.
 */

import type { Dataset, PythonDb } from "../sources/index.ts";
import { bridgeDir, readBridge } from "./core/bridge.ts";
import { produceBudgetDedup } from "./budget/dedup.ts";
import { produceIngestFixtures } from "./budget/ingestFixtures.ts";
import { readBridge } from "./core/bridge.ts";
import { produceNetworth } from "./core/networth.ts";
import { producePerformance } from "./investments/performance.ts";
import { produceAllocation, produceValuation } from "./investments/portfolio.ts";
import { readStrategyBridge, strategyBridgeDir } from "./investments/strategyBridge.ts";
import { guardBridgeDir, readGuardBridge } from "./mcp/guardBridge.ts";
import { produceMcpRead, rawGoldenDir } from "./mcp/privacy.ts";
import type { OutValue } from "./output.ts";

/** Where the producers read their Python-side inputs (`pnpm parity:produce --golden-root / --bridge-mcp`). */
export interface ProduceInputs {
  /** The Python golden root (`golden.py --out`); the MCP producers read `<root>/lab/mcp.read_raw.json`. */
  readonly goldenRoot: string;
  /** The guard bridge root (`guard_bridge.py --out`). */
  readonly bridgeMcpRoot: string;
}

/** The Python-side dirs a producer reads; their commits go into the TS index (staleness guard). */
export type InputName = "golden" | "bridge" | "bridge-strategy" | "bridge-mcp";

/** The dir an input is read from for a dataset (where its producer wrote its `index.json`). */
export function inputDir(name: InputName, dataset: Dataset, inputs: ProduceInputs): string {
  switch (name) {
    case "golden":
      return rawGoldenDir(dataset, inputs.goldenRoot);
    case "bridge":
      return bridgeDir(dataset);
    case "bridge-strategy":
      return strategyBridgeDir(dataset);
    case "bridge-mcp":
      return guardBridgeDir(dataset, inputs.bridgeMcpRoot);
  }
}

export interface Producer {
  /** The golden check this producer writes. */
  readonly check: string;
  /** The Python-side inputs it reads (recorded with their commits in the TS `index.json`). */
  readonly inputs: readonly InputName[];
  /** Datasets it is enabled for (a lab check may wait for a later port). */
  readonly datasets: readonly Dataset[];
  readonly produce: (db: PythonDb, inputs: ProduceInputs) => OutValue;
}

export const PRODUCERS: readonly Producer[] = [
  {
    check: "core.networth",
    datasets: ["demo", "lab"],
    inputs: ["bridge"],
    produce: (db) => produceNetworth(db, readBridge(db.dataset)),
  },
  {
    check: "budget.dedup",
    // lab has no bank transactions yet (R3): enable lab here once it does.
    datasets: ["demo"],
    produce: produceBudgetDedup,
  },
  {
    check: "budget.ingest_fixtures",
    // Synthetic fixtures, not dataset state: one dataset is enough.
    datasets: ["demo"],
    produce: () => produceIngestFixtures(),
  },
  {
    check: "investments.valuation",
    datasets: ["demo", "lab"],
    inputs: ["bridge-strategy"],
    produce: (db) => produceValuation(db, readStrategyBridge(db.dataset)),
  },
  {
    check: "investments.allocation",
    datasets: ["demo", "lab"],
    inputs: ["bridge-strategy"],
    produce: (db) => produceAllocation(db, readStrategyBridge(db.dataset)),
  },
  {
    check: "investments.performance",
    datasets: ["demo", "lab"],
    inputs: ["bridge-strategy"],
    produce: (db) => producePerformance(db, readStrategyBridge(db.dataset)),
  },
  {
    check: "mcp.read_strict",
    datasets: ["demo", "lab"],
    inputs: ["golden", "bridge-mcp"],
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
    inputs: ["golden", "bridge-mcp"],
    produce: (db, inputs) =>
      produceMcpRead(
        db,
        "amounts",
        readGuardBridge(db.dataset, inputs.bridgeMcpRoot),
        inputs.goldenRoot,
      ),
  },
];
