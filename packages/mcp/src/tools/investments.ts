/** Native bodies share the frozen Python descriptors while S38c completes the whole provider. */
import type { ToolSpec } from "../registry.js";
import { INVESTMENT_READ_TOOLS } from "../runtime/toolSchemas.generated.js";
import type { NativeToolStore } from "../runtime/types.js";
import { inspectExport } from "./exports.js";
import { historyMetrics } from "./investmentsHistory.js";
import { validateInvestmentImport } from "./investmentsImport.js";
import { signals, theses } from "./investmentsJournal.js";
import { portfolioOverview, positions, reviewContext, strategyStatus } from "./investmentsRead.js";

const HANDLERS: Readonly<Record<string, ToolSpec<NativeToolStore>["handler"]>> = {
  portfolio_overview: portfolioOverview,
  positions,
  signals,
  review_context: reviewContext,
  strategy_status: strategyStatus,
  theses,
  validate_import: validateInvestmentImport,
  inspect_export: inspectExport,
  history_metrics: historyMetrics,
};
/** Generated descriptors retain the exact Python wire contract; every read body is native. */
export function investmentTools(): readonly ToolSpec<NativeToolStore>[] {
  return INVESTMENT_READ_TOOLS.flatMap((metadata) => {
    const handler = HANDLERS[metadata.name];
    return handler === undefined ? [] : [{ ...metadata, handler }];
  });
}
