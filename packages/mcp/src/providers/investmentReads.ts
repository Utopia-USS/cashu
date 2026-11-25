/** Per-call native view dependency seam. The caller owns coherent market and strategy authority. */
import { investmentsViews } from "@cashu/store";
import type { ToolContext } from "../registry.js";
import type { NativeToolStore } from "../runtime/types.js";
import type { InvestmentReadRequests, InvestmentReads } from "./investmentReadTypes.js";

export type { InvestmentReadRequests, InvestmentReads } from "./investmentReadTypes.js";
/** Build anew from the context's fixed clock, never retain request DTOs across calls. */
export function investmentReads(
  context: ToolContext<NativeToolStore>,
  requests: InvestmentReadRequests,
): InvestmentReads {
  const { read } = context.store;
  const checked = <T>(result: { ok: true; value: T } | { ok: false; reason: string }): T => {
    if (!result.ok) throw new Error("native investment context is invalid");
    return result.value;
  };
  if (
    requests.portfolio.clock.today !== context.today ||
    requests.review.clock.today !== context.today
  )
    throw new Error("native investment clock is inconsistent");
  return {
    positions: () =>
      checked(investmentsViews.readPositions(read, { ...requests.portfolio, forOwner: false })),
    overview: () =>
      checked(investmentsViews.readOverview(read, { ...requests.portfolio, forOwner: false })),
    reviewContext: () => investmentsViews.readReviewContext(read, requests.review),
    strategyStatus: () => investmentsViews.projectStoredStrategyStatus(read, requests.strategy),
  };
}
