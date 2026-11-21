/** Native unlabelled projection DTOs. No runtime context or handler dependency. */
import type { investmentsViews } from "@cashu/store";

type Views = typeof investmentsViews;
export interface InvestmentReads {
  readonly positions: () => Extract<ReturnType<Views["readPositions"]>, { ok: true }>["value"];
  readonly overview: () => Extract<ReturnType<Views["readOverview"]>, { ok: true }>["value"];
  readonly reviewContext: () => ReturnType<Views["readReviewContext"]>;
  readonly strategyStatus: () => ReturnType<Views["projectStoredStrategyStatus"]>;
}
export interface InvestmentReadRequests {
  readonly portfolio: Parameters<Views["readOverview"]>[1];
  readonly review: Parameters<Views["readReviewContext"]>[1];
  readonly strategy: Parameters<Views["projectStoredStrategyStatus"]>[1];
}
