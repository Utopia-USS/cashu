/** Native retrospective inputs from the copied/genesis harness, never Python result replay. */

import { DEFAULT_DATA_QUALITY } from "@cashu/domain/investments/rules";
import type { InvestmentHistoryReads } from "@cashu/mcp";
import { investmentsPerformance, investmentsViews } from "@cashu/store";
import type { PythonDb } from "../../sources/pythonDb.ts";
import { nativeViewSources } from "../investments/viewSource.ts";

export function bindInvestmentHistory(db: PythonDb, profileId: number): InvestmentHistoryReads {
  const source = nativeViewSources(db).find((row) => row.profile.id === profileId);
  if (source === undefined) throw new Error("native investment history vault is absent");
  const { store } = source.vault;
  const config = source.strategy.config;
  const data = config?.data ?? DEFAULT_DATA_QUALITY;
  const strategy = {
    state: source.strategy.state,
    benchmark: config?.benchmark ?? null,
    policy: { maxPriceAgeDays: data.maxPriceAgeDays, maxFxAgeDays: data.maxFxAgeDays },
    strategy:
      config === null ? null : { baseCurrency: config.baseCurrency, allocation: config.allocation },
  };
  const performance = new investmentsPerformance.PerformanceService();
  return {
    portfolio: (asOf) => {
      const result = investmentsViews.portfolioAt(store.read.bind(store), {
        ...source.request,
        asOf,
      });
      if (!result.ok) throw new Error("native historical portfolio context is invalid");
      return result.value;
    },
    performance: () =>
      performance.historyMetrics(store, { marketData: source.marketData, asOf: db.asOf, strategy }),
  };
}
