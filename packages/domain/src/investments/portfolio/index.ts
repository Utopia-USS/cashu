/**
 * Portfolio math (port of `cashu.modules.investments.portfolio`): pure functions, no I/O. FIFO lots,
 * snapshot, FX lookup, valuation, allocation.
 *
 * Pipeline: `buildSnapshot` -> `valuePortfolio` (with a `MarketView` and an `FxLookup`) -> `allocate`
 * (with an `AllocationPlan` from the strategy loader). Prices, bars and FX rates come in as data.
 */

export { allocate, matchesBucket, matchesCashBucket } from "./allocation.js";
export { orderEvents, type PortfolioEvent } from "./events.js";
export { Fraction } from "./fraction.js";
export {
  convert,
  FX_BASE,
  type FxNeeds,
  fxCurrenciesFor,
  InMemoryFxLookup,
  preloadRates,
} from "./fxLookup.js";
export { lastTradePrices, SPLIT_DEDUP_WINDOW_DAYS } from "./lastTradePrices.js";
export {
  fractionToDecimal,
  IncrementalLotEngine,
  type LotEngineResult,
  QUANTITY_DIGITS,
  type RunningCash,
  type RunningLot,
  type RunningQueue,
  runLots,
  SPLIT_REMAINDER_TOLERANCE,
} from "./lotEngine.js";
export { buildSnapshot, restrictSnapshot } from "./snapshotBuilder.js";
export { decimalPlaces, SPLIT_RATIO_MAX_DENOMINATOR, splitFraction } from "./splitRatio.js";
export { effectiveValuationMode, valuePortfolio } from "./valuation.js";
