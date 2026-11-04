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
import { produceAccounts } from "./investments/accounts.ts";
import { produceAlerts } from "./investments/alerts.ts";
import { produceAllocationView } from "./investments/allocationView.ts";
import { produceImportPlan } from "./investments/importPlan.ts";
import { produceOverview as produceInvestmentsOverview } from "./investments/overview.ts";
import { producePerformance } from "./investments/performance.ts";
import { produceAllocation, produceValuation } from "./investments/portfolio.ts";
import { producePositionDetail } from "./investments/positionDetail.ts";
import { producePositions } from "./investments/positions.ts";
import { produceReviewDigest } from "./investments/reviewDigest.ts";
import { produceRules } from "./investments/rules.ts";
import { produceSignals } from "./investments/signals.ts";
import { strategyInputs } from "./investments/strategy.ts";
import { produceStrategyLoader } from "./investments/strategyLoader.ts";
import { produceStrategyStatus } from "./investments/strategyStatus.ts";
import { produceWatchlist } from "./investments/watchlist.ts";
import { produceLoansValuation } from "./loans/valuation.ts";
import { produceMcpRead, rawGoldenDir } from "./mcp/privacy.ts";
import { produceMcpToolSchemas } from "./mcp/toolSchemas.ts";
import type { OutValue } from "./output.ts";
import { produceStoreTable, STORE_TABLES } from "./store/tables.ts";

/**
 * Where the producers read their Python-side inputs (`pnpm parity:produce --golden-root`).
 */
export interface ProduceInputs {
  /** The Python golden root (`golden.py --out`); the MCP producers read `<root>/lab/mcp.read_raw.json`. */
  readonly goldenRoot: string;
}

/** The Python-side dirs a producer reads; their commits go into the TS index (staleness guard). */
export type InputName = "golden";

/** The dir an input is read from for a dataset (where its producer wrote its `index.json`). */
export function inputDir(name: InputName, dataset: Dataset, inputs: ProduceInputs): string {
  switch (name) {
    case "golden":
      return rawGoldenDir(dataset, inputs.goldenRoot);
  }
}

export interface Producer {
  /** The golden check this producer writes. */
  readonly check: string;
  /** The Python-side inputs it reads (recorded with their commits in the TS `index.json`). */
  readonly inputs: readonly InputName[];
  /** Datasets it is enabled for (a lab check may wait for a later port). */
  readonly datasets: readonly Dataset[];
  readonly produce: (db: PythonDb, inputs: ProduceInputs) => OutValue | Promise<OutValue>;
}

export const PRODUCERS: readonly Producer[] = [
  {
    check: "mcp.tool_schemas",
    datasets: ["demo", "lab"],
    inputs: [],
    produce: produceMcpToolSchemas,
  },
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
    datasets: ["demo", "lab"],
    inputs: [],
    produce: produceBudgetDedup,
  },
  {
    check: "budget.ingest_fixtures",
    datasets: ["demo", "lab"],
    inputs: [],
    produce: () => produceIngestFixtures(),
  },
  {
    check: "budget.transfers",
    datasets: ["demo", "lab"],
    inputs: [],
    produce: produceBudgetTransfers,
  },
  {
    check: "budget.categories",
    datasets: ["demo", "lab"],
    inputs: [],
    produce: produceBudgetCategories,
  },
  {
    check: "budget.analytics",
    datasets: ["demo", "lab"],
    inputs: [],
    produce: produceBudgetAnalytics,
  },
  {
    check: "budget.month_close",
    datasets: ["demo", "lab"],
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
    check: "investments.rules",
    datasets: ["demo", "lab"],
    inputs: [],
    produce: (db) => produceRules(db, strategyInputs(db)),
  },
  {
    check: "investments.strategy_loader",
    datasets: ["demo", "lab"],
    inputs: [],
    produce: produceStrategyLoader,
  },
  {
    check: "investments.signals",
    datasets: ["demo", "lab"],
    inputs: [],
    produce: produceSignals,
  },
  {
    check: "investments.alerts",
    datasets: ["demo", "lab"],
    inputs: [],
    produce: produceAlerts,
  },
  {
    check: "investments.import_plan",
    datasets: ["demo", "lab"],
    inputs: [],
    produce: produceImportPlan,
  },
  {
    check: "investments.overview",
    datasets: ["demo", "lab"],
    inputs: [],
    produce: produceInvestmentsOverview,
  },
  {
    check: "investments.positions",
    datasets: ["demo", "lab"],
    inputs: [],
    produce: producePositions,
  },
  {
    check: "investments.position_detail",
    datasets: ["demo", "lab"],
    inputs: [],
    produce: producePositionDetail,
  },
  {
    check: "investments.allocation_view",
    datasets: ["demo", "lab"],
    inputs: [],
    produce: produceAllocationView,
  },
  {
    check: "investments.strategy_status",
    datasets: ["demo", "lab"],
    inputs: [],
    produce: produceStrategyStatus,
  },
  {
    check: "investments.review_digest",
    datasets: ["demo", "lab"],
    inputs: [],
    produce: (db) => produceReviewDigest(db),
  },
  {
    check: "investments.accounts",
    datasets: ["demo", "lab"],
    inputs: [],
    produce: produceAccounts,
  },
  {
    check: "investments.watchlist",
    datasets: ["demo", "lab"],
    inputs: [],
    produce: produceWatchlist,
  },
  {
    check: "mcp.read_strict",
    datasets: ["demo", "lab"],
    inputs: ["golden"],
    produce: (db, inputs) => produceMcpRead(db, "strict", inputs.goldenRoot),
  },
  {
    check: "mcp.read_amounts",
    datasets: ["demo", "lab"],
    inputs: ["golden"],
    produce: (db, inputs) => produceMcpRead(db, "amounts", inputs.goldenRoot),
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
