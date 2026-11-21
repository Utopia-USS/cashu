import type { RuleContext } from "../context.js";
import type { RuleSpec } from "../kind.js";
import {
  candidate,
  Fired,
  NotFired,
  type RuleOutcome,
  Skipped,
  signalDedupKey,
} from "../outcomes.js";
import { kindStrings as messages } from "./evaluate.strings.js";
/**
 * `allocation_drift` (`rules/kinds/allocation_drift.py`), the parsing side: the rebalance bands (also
 * strategy.yaml's `allocation.rebalance`) and the rule's params.
 */

import { Decimal } from "../../../decimal.js";
import type { PyPlain, PyPlainMap } from "../../../pyYaml/plain.js";
import { isGenericBucket } from "../../domain/buckets.js";
import type { RuleKind } from "../kind.js";
import { type ParamErrors, ParamReader } from "../params.js";
import { SignalPolarity } from "../polarity.js";
import {
  bucketCashGapProblem,
  bucketNamed,
  bucketWord,
  decimalText,
  formatAmount,
  formatPct,
  formatPp,
  noAllocationProblem,
  noAllocations,
  portfolioDataProblem,
  RATIO_EPSILON,
  unclassifiedProblem,
} from "./support.js";

/**
 * Rebalance bands: a bucket is out of band when |drift| > `absoluteBandPp` percentage points OR
 * |relative drift| > `relativeBand` (the "5/25" rule), and only worth a signal when the money to move
 * is at least `minTradeValue` (base currency).
 */
export interface RebalancePolicy {
  readonly absoluteBandPp: number;
  readonly relativeBand: number;
  readonly minTradeValue: Decimal;
}

export const DEFAULT_REBALANCE: RebalancePolicy = Object.freeze({
  absoluteBandPp: 5.0,
  relativeBand: 0.25,
  minTradeValue: Decimal.fromInt(0),
});

/** `RebalancePolicy.read`: the three keys, all optional. */
export function readRebalancePolicy(reader: ParamReader): RebalancePolicy {
  return {
    absoluteBandPp: reader.number("absolute_band_pp", {
      fallback: 5.0,
      minimum: 0,
      maximum: 100,
      exclusiveMin: true,
    }),
    relativeBand: reader.number("relative_band", {
      fallback: 0.25,
      minimum: 0,
      exclusiveMin: true,
    }),
    minTradeValue: reader.decimal("min_trade_value", {
      fallback: Decimal.fromInt(0),
      minimum: Decimal.fromInt(0),
    }),
  };
}

/** `RebalancePolicy.to_raw`: the values as raw YAML params (allocation_drift defaults). */
export function rebalanceToRaw(policy: RebalancePolicy): Map<string, PyPlain> {
  return new Map<string, PyPlain>([
    ["absolute_band_pp", policy.absoluteBandPp],
    ["relative_band", policy.relativeBand],
    ["min_trade_value", decimalText(policy.minTradeValue)],
  ]);
}

export class AllocationDriftParams {
  readonly bands: RebalancePolicy;
  /** Bucket ids to check; empty = every bucket. */
  readonly buckets: readonly string[];
  constructor(
    init: { readonly bands?: RebalancePolicy; readonly buckets?: readonly string[] } = {},
  ) {
    this.bands = init.bands ?? DEFAULT_REBALANCE;
    this.buckets = init.buckets ?? [];
  }
}

export const ALLOCATION_DRIFT = "allocation_drift";

function evaluateAllocationDrift(
  ctx: RuleContext,
  spec: RuleSpec<AllocationDriftParams>,
): RuleOutcome[] {
  const problem = portfolioDataProblem(ctx);
  if (problem !== null) return [new Skipped(spec.id, problem)];
  if (!ctx.allocations.length) return [new Skipped(spec.id, noAllocations(ctx.lang))];
  const unclassified = unclassifiedProblem(ctx);
  if (unclassified !== null) return [new Skipped(spec.id, unclassified)];
  const bands = spec.params.bands;
  const byId = new Map(ctx.allocations.map((a) => [a.bucketId, a]));
  const ids = spec.params.buckets.length ? spec.params.buckets : [...byId.keys()];
  const currency = ctx.portfolio.baseCurrency;
  return ids.map((id): RuleOutcome => {
    const key = signalDedupKey(spec.id, { scope: id });
    const a = byId.get(id);
    if (!a) return new Skipped(spec.id, noAllocationProblem(id, ctx.lang), key);
    if (a.cashHistoryGap) return new Skipped(spec.id, bucketCashGapProblem(id, ctx.lang), key);
    const outside =
      Math.abs(a.driftPp) > bands.absoluteBandPp + RATIO_EPSILON ||
      Math.abs(a.driftRel) > bands.relativeBand + RATIO_EPSILON;
    const details = {
      bucket_id: id,
      bucket_generic: isGenericBucket(id),
      weight: a.weight,
      target: a.target,
      drift_pp: a.driftPp,
      drift_rel: Number.isFinite(a.driftRel) ? a.driftRel : null,
      value_base: decimalText(a.valueBase),
      drift_value_base: decimalText(a.driftValueBase),
      currency,
      absolute_band_pp: bands.absoluteBandPp,
      relative_band: bands.relativeBand,
      min_trade_value: decimalText(bands.minTradeValue),
    };
    if (!outside || a.driftValueBase.abs().lt(bands.minTradeValue))
      return new NotFired(spec.id, key, details);
    const over = a.driftPp > 0;
    const text = messages.drift[ctx.lang](
      bucketNamed(bucketWord(ctx.lang), id),
      over,
      formatPp(Math.abs(a.driftPp), ctx.lang),
      formatPct(a.weight, ctx.lang),
      formatPct(a.target, ctx.lang),
      `${formatAmount(a.driftValueBase.abs(), ctx.lang)} ${currency}`,
    );
    return new Fired(
      candidate(spec, key, text, { ...details, direction: over ? "overweight" : "underweight" }),
    );
  });
}

export const allocationDriftRule: RuleKind<AllocationDriftParams> = Object.freeze({
  kind: ALLOCATION_DRIFT,
  // Owner decision (F6): drift below or above target is neither good nor bad news, just a review.
  defaultPolarity: SignalPolarity.NEUTRAL,
  paramsType: AllocationDriftParams,
  evaluate: evaluateAllocationDrift,
  parseParams(raw: PyPlainMap, errors: ParamErrors): AllocationDriftParams {
    const reader = new ParamReader(raw, errors);
    const bands = readRebalancePolicy(reader);
    const buckets = reader.strings("buckets");
    reader.finish();
    return new AllocationDriftParams({ bands, buckets });
  },
});
