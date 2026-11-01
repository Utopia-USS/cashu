/**
 * Investments rules (`rules/__init__.py`), the parsing side the strategy loader needs: the catalog of
 * rule kinds with their params, the param reader, the policies and polarity, and the compile front-end
 * of custom expressions. The engine, evaluation and signal lifecycle are S15b; the expression
 * evaluator and metrics S15a.
 */

export { BUILT_IN_KINDS, RuleCatalog } from "./catalog.js";
export * as expr from "./expr/index.js";
export { closestMatch, didYouMean } from "./hints.js";
export {
  type ContributionPlan,
  DATA_QUALITY_KEYS,
  type DataQualityPolicy,
  DEFAULT_DATA_QUALITY,
  DEFAULT_MAX_UNVERIFIED_DAYS,
  MAX_UNVERIFIED_DAYS,
  type RuleKind,
  type RuleSpec,
} from "./kind.js";
export {
  ALLOCATION_DRIFT,
  type AllocationDriftParams,
  allocationDriftRule,
  DEFAULT_REBALANCE,
  REBALANCE_KEYS,
  type RebalancePolicy,
  readRebalancePolicy,
  rebalanceToRaw,
} from "./kinds/allocationDrift.js";
export { type CashLevelParams, cashLevelRule } from "./kinds/cashLevel.js";
export {
  CONTRIBUTION_GAP,
  type ContributionGapParams,
  contributionGapRule,
  DEFAULT_GRACE_DAYS,
  DEFAULT_PERIOD_DAYS,
} from "./kinds/contributionGap.js";
export {
  CUSTOM,
  type CustomParams,
  customBucketReferences,
  customRule,
  MAX_MESSAGE_LENGTH,
} from "./kinds/custom.js";
export {
  DEFAULT_WINDOW_DAYS,
  type DrawdownFromHighParams,
  drawdownFromHighRule,
} from "./kinds/drawdownFromHigh.js";
export {
  type PositionConcentrationParams,
  positionConcentrationRule,
} from "./kinds/positionConcentration.js";
export {
  decimalText,
  EMPTY_INSTRUMENT_FILTER,
  INSTRUMENT_FILTER_KEYS,
  type InstrumentFilter,
  readInstrumentFilter,
} from "./kinds/support.js";
export { type TaggedWeightParams, taggedWeightRule } from "./kinds/taggedWeight.js";
export {
  gainFromCostRule,
  lossFromCostRule,
  type UnrealizedThresholdParams,
} from "./kinds/unrealizedFromCost.js";
export {
  formatNumber,
  type IntegerBounds,
  type NumberBounds,
  ParamErrors,
  type ParamIssue,
  ParamReader,
  parseCurrency,
} from "./params.js";
export { SIGNAL_POLARITIES, SignalPolarity } from "./polarity.js";
