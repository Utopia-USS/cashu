/**
 * Investments rules (`rules/__init__.py`): parsed catalog, policies, polarity, expression compiler
 * and evaluator, built-in evaluators, engine and pure signal lifecycle. Persistence lives in store.
 */

export { BUILT_IN_KINDS, RuleCatalog } from "./catalog.js";
export { buildRuleContext, type RuleContext } from "./context.js";
export { RulesEngine } from "./engine.js";
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
  AllocationDriftParams,
  allocationDriftRule,
  DEFAULT_REBALANCE,
  REBALANCE_KEYS,
  type RebalancePolicy,
  readRebalancePolicy,
  rebalanceToRaw,
} from "./kinds/allocationDrift.js";
export { driftBucketGeneric, withBucketGeneric } from "./kinds/allocationDriftRead.js";
export { CashLevelParams, cashLevelRule } from "./kinds/cashLevel.js";
export {
  CONTRIBUTION_GAP,
  ContributionGapParams,
  contributionGapRule,
  DEFAULT_GRACE_DAYS,
  DEFAULT_PERIOD_DAYS,
} from "./kinds/contributionGap.js";
export {
  CUSTOM,
  CustomParams,
  customBucketReferences,
  customRule,
  MAX_MESSAGE_LENGTH,
} from "./kinds/custom.js";
export {
  DEFAULT_WINDOW_DAYS,
  DrawdownFromHighParams,
  drawdownFromHighRule,
} from "./kinds/drawdownFromHigh.js";
export {
  PositionConcentrationParams,
  positionConcentrationRule,
} from "./kinds/positionConcentration.js";
export {
  decimalText,
  EMPTY_INSTRUMENT_FILTER,
  INSTRUMENT_FILTER_KEYS,
  type InstrumentFilter,
  readInstrumentFilter,
} from "./kinds/support.js";
export { TaggedWeightParams, taggedWeightRule } from "./kinds/taggedWeight.js";
export {
  gainFromCostRule,
  lossFromCostRule,
  UnrealizedThresholdParams,
} from "./kinds/unrealizedFromCost.js";
export {
  type ClosedSignal,
  type CreateSignal,
  type EscalateSignal,
  type ExpireSignal,
  type OpenSignal,
  type ReconcileSignalsInput,
  type RefreshSignal,
  type ResolveSignal,
  reconcileSignals,
  type SignalAction,
  SignalReconciliation,
  type SuppressCandidate,
  UNVERIFIED,
} from "./lifecycle.js";
export {
  Fired,
  NotFired,
  outcomeScope,
  type RuleOutcome,
  type SignalCandidate,
  Skipped,
  signalDedupKey,
} from "./outcomes.js";
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
