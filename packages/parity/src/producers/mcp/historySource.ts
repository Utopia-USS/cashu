/** Native retrospective inputs from the copied/genesis harness, never Python result replay. */

import { performance as perf } from "@cashu/domain/investments";
import { DEFAULT_DATA_QUALITY } from "@cashu/domain/investments/rules";
import type { InvestmentHistoryReads } from "@cashu/mcp";
import { investmentsPerformance, investmentsViews } from "@cashu/store";
import type { PythonDb } from "../../sources/pythonDb.ts";
import { loadPerformance } from "../investments/performance.ts";
import { strategyInputs } from "../investments/strategy.ts";
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
    performance: () => {
      const request = { marketData: source.marketData, asOf: db.asOf, strategy };
      const native = investmentsPerformance.performanceInputs(store.read.bind(store), request);
      if (native.benchmark === null || native.benchmarkInstrument !== null)
        return performance.historyMetrics(store, request);
      // Genesis keeps owned financial subjects only. A benchmark is public reference data,
      // so load its actual copied catalog/bar/FX facts without inserting it into the vault.
      const copiedStrategy = strategyInputs(db).get(db.keys.key("profiles", profileId));
      if (copiedStrategy === undefined) throw new Error("copied benchmark strategy is absent");
      const copied = loadPerformance(db, source.profile, copiedStrategy, db.asOf);
      return perf.historyMetrics(
        perf.computePerformance(
          {
            ...native,
            benchmarkInstrument: copied.benchmarkInstrument,
            benchmarkBars: copied.benchmarkBars,
            fx: copied.fx,
          },
          db.asOf,
        ),
      );
    },
  };
}
