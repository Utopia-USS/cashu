/**
 * Portfolio math (port of `cashu.modules.investments.portfolio`): pure functions, no I/O. FIFO lots,
 * snapshot, FX lookup, valuation, allocation.
 *
 * Pipeline: `buildSnapshot` -> `valuePortfolio` (with a `MarketView` and an `FxLookup`) -> `allocate`
 * (with an `AllocationPlan` from the strategy loader). Prices, bars and FX rates come in as data.
 */

export { allocate, matchesBucket, matchesCashBucket } from "./allocation.js";
export { Fraction } from "./fraction.js";
export { convert, type FxNeeds, fxCurrenciesFor, InMemoryFxLookup } from "./fxLookup.js";
export { lastTradePrices, SPLIT_DEDUP_WINDOW_DAYS } from "./lastTradePrices.js";
export {
  fractionToDecimal,
  type LotEngineResult,
  QUANTITY_DIGITS,
  runLots,
  SPLIT_REMAINDER_TOLERANCE,
} from "./lotEngine.js";
export { buildSnapshot, restrictSnapshot } from "./snapshotBuilder.js";
export { decimalPlaces, SPLIT_RATIO_MAX_DENOMINATOR, splitFraction } from "./splitRatio.js";
export { effectiveValuationMode, valuePortfolio } from "./valuation.js";
