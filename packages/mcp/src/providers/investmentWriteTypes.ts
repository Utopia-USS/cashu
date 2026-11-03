/** Genuine per-call inputs for synchronous investment writes; no network or publication capability. */

import type { PriceBar } from "@cashu/domain/investments";
import type { RuleSpec } from "@cashu/domain/investments/rules";
import type { StrategyConfig } from "@cashu/domain/investments/strategy";
import type { investmentsCommands, investmentsViews } from "@cashu/store";
import type {
  ProposalCreationFiles,
  ResearchPlanInputs,
  RuleBacktestReport,
} from "@cashu/store/investments/services";

export interface InvestmentWriteRequests {
  readonly portfolio: Parameters<typeof investmentsViews.readWatchlist>[1];
  isHolder(vault: string): boolean;
  readonly strategyFiles?: ProposalCreationFiles;
}
export interface InvestmentWriteServices {
  readonly vault: string;
  readonly plans: ResearchPlanInputs;
  readonly strategyFiles?: ProposalCreationFiles;
  alertBars(instrument: string): readonly PriceBar[];
  watchlist(
    pending?: investmentsCommands.WatchAddResult,
  ): Extract<ReturnType<typeof investmentsViews.readWatchlist>, { ok: true }>["value"];
  backtest(rule: RuleSpec, config: StrategyConfig): RuleBacktestReport;
}
