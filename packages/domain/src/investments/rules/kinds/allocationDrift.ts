/**
 * `allocation_drift` (`rules/kinds/allocation_drift.py`), the parsing side: the rebalance bands (also
 * strategy.yaml's `allocation.rebalance`) and the rule's params.
 */

import { Decimal } from "../../../decimal.js";
import type { PyPlain, PyPlainMap } from "../../../pyYaml/plain.js";
import type { RuleKind } from "../kind.js";
import { type ParamErrors, ParamReader } from "../params.js";
import { SignalPolarity } from "../polarity.js";
import { decimalText } from "./support.js";

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

export const REBALANCE_KEYS = ["absolute_band_pp", "relative_band", "min_trade_value"] as const;

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

export interface AllocationDriftParams {
  readonly bands: RebalancePolicy;
  /** Bucket ids to check; empty = every bucket. */
  readonly buckets: readonly string[];
}

export const ALLOCATION_DRIFT = "allocation_drift";

export const allocationDriftRule: RuleKind<AllocationDriftParams> = Object.freeze({
  kind: ALLOCATION_DRIFT,
  // Owner decision (F6): drift below or above target is neither good nor bad news, just a review.
  defaultPolarity: SignalPolarity.NEUTRAL,
  parseParams(raw: PyPlainMap, errors: ParamErrors): AllocationDriftParams {
    const reader = new ParamReader(raw, errors);
    const bands = readRebalancePolicy(reader);
    const buckets = reader.strings("buckets");
    reader.finish();
    return { bands, buckets };
  },
});
