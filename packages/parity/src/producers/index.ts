/**
 * The TS parity producers: one function per golden check, each reading the dataset through the
 * read-only source (`../sources`) and returning the check's JSON tree. `cli.ts` runs them and writes
 * `<lab>/parity/ts-out/<dataset>/<check>.json`, the comparer's default actual dir.
 */

import type { Dataset, PythonDb } from "../sources/index.ts";
import { produceAssetsDepreciation } from "./assets/depreciation.ts";
import { produceBudgetAnalytics } from "./budget/analytics.ts";
import { produceBudgetCategories } from "./budget/categories.ts";
import { produceBudgetDedup } from "./budget/dedup.ts";
import { produceIngestFixtures } from "./budget/ingestFixtures.ts";
import { produceBudgetMonthClose } from "./budget/monthClose.ts";
import { produceBudgetTransfers } from "./budget/transfers.ts";
import { produceNetworth } from "./core/networth.ts";
import { produceNetworthSeries } from "./core/networthSeries.ts";
import { produceOverview } from "./core/overview.ts";
import { produceImportPlan } from "./investments/importPlan.ts";
import { producePerformance } from "./investments/performance.ts";
import { produceAllocation, produceValuation } from "./investments/portfolio.ts";
import { strategyInputs } from "./investments/strategy.ts";
import { produceStrategyLoader } from "./investments/strategyLoader.ts";
import { produceLoansValuation } from "./loans/valuation.ts";
import { guardBridgeDir, readGuardBridge } from "./mcp/guardBridge.ts";
import { produceMcpRead, rawGoldenDir } from "./mcp/privacy.ts";
import type { OutValue } from "./output.ts";
import { produceStoreTable, STORE_TABLES } from "./store/tables.ts";

/**
 * Where the producers read their Python-side inputs (`pnpm parity:produce --golden-root /
 * --bridge-mcp`).
 */
export interface ProduceInputs {
  /** The Python golden root (`golden.py --out`); the MCP producers read `<root>/lab/mcp.read_raw.json`. */
  readonly goldenRoot: string;
  /** The guard bridge root (`guard_bridge.py --out`). */
  readonly bridgeMcpRoot: string;
}

/** The Python-side dirs a producer reads; their commits go into the TS index (staleness guard). */
export type InputName = "golden" | "bridge-mcp";

/** The dir an input is read from for a dataset (where its producer wrote its `index.json`). */
export function inputDir(name: InputName, dataset: Dataset, inputs: ProduceInputs): string {
  switch (name) {
    case "golden":
      return rawGoldenDir(dataset, inputs.goldenRoot);
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
    inputs: [],
    produce: produceNetworth,
  },
  {
    check: "core.networth_series",
    datasets: ["demo", "lab"],
    inputs: [],
    produce: produceNetworthSeries,
  },
  {
    check: "core.overview",
    datasets: ["demo", "lab"],
    inputs: [],
    produce: produceOverview,
  },
  {
    check: "loans.valuation",
    datasets: ["demo", "lab"],
    inputs: [],
    produce: produceLoansValuation,
  },
  {
    check: "assets.depreciation",
    datasets: ["demo", "lab"],
    inputs: [],
    produce: produceAssetsDepreciation,
  },
  {
    check: "budget.dedup",
    // lab has no bank transactions yet (R3): enable lab here once it does.
    datasets: ["demo"],
    inputs: [],
    produce: produceBudgetDedup,
  },
  {
    check: "budget.ingest_fixtures",
    // Synthetic fixtures, not dataset state: one dataset is enough.
    datasets: ["demo"],
    inputs: [],
    produce: () => produceIngestFixtures(),
  },
  {
    check: "budget.transfers",
    // lab has no bank transactions yet (R3): enable lab here once it does.
    datasets: ["demo"],
    inputs: [],
    produce: produceBudgetTransfers,
  },
  {
    check: "budget.categories",
    // lab has no bank transactions yet (R3): enable lab here once it does.
    datasets: ["demo"],
    inputs: [],
    produce: produceBudgetCategories,
  },
  {
    check: "budget.analytics",
    // lab has no bank transactions yet (R3): enable lab here once it does.
    datasets: ["demo"],
    inputs: [],
    produce: produceBudgetAnalytics,
  },
  {
    check: "budget.month_close",
    // lab has no bank transactions yet (R3): enable lab here once it does.
    datasets: ["demo"],
    inputs: [],
    produce: (db) => produceBudgetMonthClose(db, strategyInputs(db)),
  },
  {
    check: "investments.valuation",
    datasets: ["demo", "lab"],
    inputs: [],
    produce: (db) => produceValuation(db, strategyInputs(db)),
  },
  {
    check: "investments.allocation",
    datasets: ["demo", "lab"],
    inputs: [],
    produce: (db) => produceAllocation(db, strategyInputs(db)),
  },
  {
    check: "investments.performance",
    datasets: ["demo", "lab"],
    inputs: [],
    produce: (db) => producePerformance(db, strategyInputs(db)),
  },
  {
    check: "investments.strategy_loader",
    datasets: ["demo", "lab"],
    inputs: [],
    produce: produceStrategyLoader,
  },
  {
    check: "investments.import_plan",
    datasets: ["demo", "lab"],
    inputs: [],
    produce: produceImportPlan,
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
  // S26 genesis roundtrip: one check per synced table (store/tables.ts), no Python-side inputs.
  ...STORE_TABLES.map(
    (table): Producer => ({
      check: `store.table.${table}`,
      datasets: ["demo", "lab"],
      inputs: [],
      produce: (db) => produceStoreTable(db, table),
    }),
  ),
];
