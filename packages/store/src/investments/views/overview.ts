/** Production overview uses effective native facts and the same projector as copied-source parity. */

import type { IsoDate } from "@cashu/domain";
import * as views from "@cashu/domain/investments/views";
import { resolveMarketInput } from "../marketInput.js";
import type { Read } from "../queries/shared.js";
import { type PortfolioViewRequest, portfolioViewInputs } from "./portfolio.js";
import { nativeStrategyStatus } from "./strategyStatus.js";
export type OverviewRequest = PortfolioViewRequest & { readonly newestRateDate: IsoDate | null };
export function readOverview(read: Read, request: OverviewRequest) {
  const input = portfolioViewInputs(read, request);
  if (!input.ok) return input;
  const market = resolveMarketInput(request, input.value.state.instruments.values());
  let newestBarDate: IsoDate | null = null;
  for (const holding of input.value.state.valued.valued) {
    const date = market.lastBarDate(holding.instrument.id);
    if (date !== null && (newestBarDate === null || date > newestBarDate)) newestBarDate = date;
  }
  return {
    ok: true as const,
    value: views.overviewView({
      ...input.value,
      strategyStatus: nativeStrategyStatus(request.strategy),
      newestRateDate: request.newestRateDate,
      newestBarDate,
    }),
  };
}
