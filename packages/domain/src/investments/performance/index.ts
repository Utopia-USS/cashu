/**
 * Portfolio performance vs a benchmark (port of `cashu.modules.investments.performance`, the pure
 * core): pure functions, no I/O, no clock.
 *
 * - `buildSeries`: daily value and external-flow series per account in the base currency (exact
 *   lots, the overview's valuation rules, split-adjusted closes, implied funding of cash gaps);
 * - returns: contributions-neutral TWR, XIRR, drawdowns, annualizing;
 * - benchmark: the proxy in the base currency and the same-cash-flow simulation;
 * - attribution: P/L by instrument and bucket, profit concentration;
 * - segment attribution: the short-window move by market segment and currency (P5), topic trends (P7);
 * - report: range metrics (`1m 3m ytd 1y 3y max`), rolling relative windows, calendar years.
 *
 * - service + views: the pure part of the performance service (the inputs it computes from, the
 *   full-history computation, the API / MCP views);
 * - backfill + proxy: the price backfill plan, the proxy probe and the reference instrument a
 *   benchmark symbol names.
 *
 * Floats appear only where Python uses float, with Python's float semantics (`floats.ts`).
 * Not here: loading the inputs from a vault, the computation cache and the backfill orchestration
 * (store writes, the device's price cache): `@cashu/store` investments performance.
 */

export {
  type AccountLevel,
  type AttributeInput,
  type Attribution,
  accountLevel,
  accountLevelTotal,
  attribute,
  bucketOf,
  type Concentration,
  concentration,
  groupByBucket,
  type InstrumentPnl,
  instrumentPnl,
  instrumentsPnl,
  pnlOf,
  TOP_N,
} from "./attribution.js";
export {
  type BackfillPlan,
  type BackfillReport,
  type BackfillRole,
  type BenchmarkBackfill,
  backfillReport,
  type FxBackfill,
  HEAD_MARGIN_DAYS,
  HEAD_TOLERANCE_DAYS,
  type InstrumentBackfill,
  mismatchOf,
  type PlanInput,
  PROBE_DAYS,
  type ProbeResult,
  planBackfill,
  planBenchmark,
  probeProxy,
} from "./backfill.js";
export { benchmarkPrices, priceIndex, type Simulation, simulate } from "./benchmark.js";
export { fractionToFloat, pySum } from "./floats.js";
export {
  PriceAdjuster,
  type PriceMismatch,
  type PriceScale,
  SCALE_BAR_WINDOW_DAYS,
  SCALE_SNAP,
  SCALE_TOLERANCE,
  snapScale,
} from "./priceAdjuster.js";
export { PLANNED_PROXY_ID, referenceInstrument } from "./proxy.js";
export { Renames } from "./renames.js";
export {
  computeRange,
  isRangeKey,
  monthEndPositions,
  perYear,
  RANGES,
  type RangeBenchmark,
  type RangeKey,
  type RangeMetrics,
  type RangeSummary,
  ROLLING_MONTHS,
  type RollingPoint,
  type RollingSummary,
  rangeBase,
  rangeEnd,
  rangeStart,
  rolling,
  rollingSummary,
  type YearReturn,
} from "./report.js";
export {
  annualized,
  CAPITAL_EPSILON,
  type Drawdown,
  drawdown,
  drawdownSeries,
  drawdownToDict,
  MIN_ANNUALIZE_DAYS,
  maxDrawdown,
  periodReturn,
  twrIndex,
  type Xirr,
  xirr,
  xirrAnnual,
  xirrPeriod,
} from "./returns.js";
export {
  type AttributeSegmentsOptions,
  attributeSegments,
  type CurrencyMove,
  closeOnOrBefore,
  DEFAULT_MAX_PRICE_AGE_DAYS,
  type InstrumentMove,
  isEmptyAttribution,
  type MemberMove,
  memberReturn,
  type SegmentAttribution,
  type SegmentMove,
  type SegmentTrend,
  type StartHolding,
  type StartPortfolio,
  segmentTrends,
  snapshotOpenings,
  startHolding,
  startPortfolio,
  TREND_WINDOWS,
} from "./segmentAttribution.js";
export {
  type AccountSeries,
  type BuildSeriesInput,
  buildSeries,
  type Combined,
  cashFlowBase,
  combineSeries,
  DEFAULT_VALUATION_POLICY,
  emptySeries,
  type HoldingValue,
  type HoldingValues,
  holdingKey,
  type PortfolioSeries,
  seriesIndexOf,
  type ValuationPolicy,
} from "./series.js";
export {
  baseCurrencyOf,
  type ComputedPerformance,
  checkRange,
  computePerformance,
  HISTORY_MARGIN_DAYS,
  hasHistory,
  isIsin,
  type PerformanceAccount,
  type PerformanceBenchmark,
  type PerformanceInputs,
  PerformanceRangeError,
  type PerformanceStrategy,
  type SampleStep,
  type StrategyState,
  sample,
} from "./service.js";
export { SnapshotStream } from "./snapshotStream.js";
export {
  type AccountPerformance,
  type AccountScope,
  type AttributionRow,
  type AttributionView,
  attributionView,
  type BenchmarkMeta,
  type BenchmarkStatus,
  type BenchmarkView,
  benchmarkMeta,
  type DataQuality,
  type DataQualityNote,
  type DrawdownView,
  type HistoryMetrics,
  historyMetrics,
  type InstrumentLabel,
  type PerformancePoint,
  type PerformanceView,
  type PriceScaleView,
  performanceView,
  type RollingView,
  type SimulationView,
  type SummaryView,
} from "./views.js";
