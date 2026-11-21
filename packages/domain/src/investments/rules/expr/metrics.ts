/** Values for every compiler catalog metric (`rules/expr/metrics.py`). Pure and profile-local. */
import { D, type Decimal, floatRepr, ONE, ZERO } from "../../../decimal.js";
import { pyUpper } from "../../../text.js";
import { AssetClass, parseAssetClass } from "../../domain/enums.js";
import type { PriceBar } from "../../domain/marketData.js";
import type { BucketAllocation } from "../../domain/snapshot.js";
import { daysBetween } from "../../domain/values.js";
import { pySum } from "../../performance/index.js";
import type { RuleContext } from "../context.js";
import {
  bucketCashGapProblem,
  bucketNamed,
  cashHistoryProblem,
  noAllocationProblem,
  noAllocations,
  portfolioDataProblem,
  portfolioValueProblem,
  unclassifiedProblem,
} from "../dataQuality.js";
import {
  cashValue,
  lastDepositDate,
  noContributionsPlan,
  taggedWeight,
  windowBars,
} from "../metricInputs.js";
import {
  hasAllTags,
  type InstrumentPosition,
  positionsByInstrument,
  unknownCostProblem,
} from "../positions.js";
import { METRICS } from "./catalog.js";
import type { MetricRef } from "./compiled.js";
import { Unknown, type Value } from "./evaluator.js";
import { metricStrings as s } from "./metrics.strings.js";
export class MetricEnv {
  readonly ctx: RuleContext;
  readonly position: InstrumentPosition | null;
  readonly bucketId: string | null;
  readonly allocation: BucketAllocation | null;
  constructor(
    ctx: RuleContext,
    options: {
      readonly position?: InstrumentPosition | null;
      readonly bucketId?: string | null;
      readonly allocation?: BucketAllocation | null;
    } = {},
  ) {
    this.ctx = ctx;
    this.position = options.position ?? null;
    this.bucketId = options.bucketId ?? null;
    this.allocation = options.allocation ?? null;
  }
  resolve(ref: MetricRef): Value {
    const resolver = RESOLVERS.get(ref.name);
    if (resolver === undefined) throw new Error(`unknown catalog metric ${ref.name}`);
    return resolver(this, ref.args);
  }
}
type Args = readonly (string | number)[];
type Resolver = (env: MetricEnv, args: Args) => Value;
const unknown = (reason: string): Unknown => new Unknown([reason]);
const ratio = (value: number | null, reason: string): Value =>
  value === null || !Number.isFinite(value) ? unknown(reason) : D(floatRepr(value));
// Python sum() starts with integer zero, but nonempty float sums retain float repr/scale.
const summedRatio = (values: readonly number[], reason: string): Value =>
  values.length === 0 ? ZERO : ratio(pySum(values), reason);
const count = (value: number): Decimal => D(String(value));
function position(env: MetricEnv): InstrumentPosition {
  if (env.position === null) throw new Error("instrument metric outside the instrument scope");
  return env.position;
}
function bucketId(env: MetricEnv): string {
  if (env.bucketId === null) throw new Error("bucket metric outside the bucket scope");
  return env.bucketId;
}
function bucket(env: MetricEnv, id: string, needsWeights = true): BucketAllocation | Unknown {
  const ctx = env.ctx;
  if (needsWeights) {
    const problem = portfolioDataProblem(ctx);
    if (problem) return unknown(problem);
  }
  if (!ctx.allocations.length) return unknown(noAllocations(ctx.lang));
  if (needsWeights) {
    const problem = unclassifiedProblem(ctx);
    if (problem) return unknown(problem);
  }
  const allocation = ctx.allocations.find((a) => a.bucketId === id);
  if (allocation === undefined) return unknown(noAllocationProblem(id, ctx.lang));
  if (needsWeights && allocation.cashHistoryGap) return unknown(bucketCashGapProblem(id, ctx.lang));
  return allocation;
}
type AllocationField =
  | "weight"
  | "target"
  | "driftPp"
  | "driftRel"
  | "valueBase"
  | "driftValueBase";
function allocationValue(
  env: MetricEnv,
  allocation: BucketAllocation,
  field: AllocationField,
): Value {
  const lang = env.ctx.lang;
  const word = bucketNamed(s.bucket[lang], allocation.bucketId);
  switch (field) {
    case "weight":
      return ratio(allocation.weight, s.bucketWeight[lang](word));
    case "target":
      return ratio(allocation.target, s.bucketTarget[lang](word));
    case "driftPp":
      return ratio(allocation.driftPp, s.bucketDrift[lang](word));
    case "driftRel":
      return ratio(allocation.driftRel, s.bucketRelativeDrift[lang](word));
    case "valueBase":
      return allocation.valueBase;
    case "driftValueBase":
      return allocation.driftValueBase;
  }
}
function bucketField(field: AllocationField, needsWeights = true, scoped = false): Resolver {
  return (env, args) => {
    const allocation = bucket(env, scoped ? bucketId(env) : String(args[0]), needsWeights);
    return allocation instanceof Unknown ? allocation : allocationValue(env, allocation, field);
  };
}
function windowMetric(compute: (bars: readonly PriceBar[]) => Decimal): Resolver {
  return (env, args) => {
    const window = windowBars(env.ctx, position(env), args.length ? Number(args[0]) : 1);
    return typeof window === "string" ? unknown(window) : compute(window.bars);
  };
}
const lastClose = (bars: readonly PriceBar[]): Decimal => (bars[bars.length - 1] as PriceBar).close;
const RESOLVERS: ReadonlyMap<string, Resolver> = new Map<string, Resolver>([
  [
    "total_value",
    (env) => {
      const problem = portfolioValueProblem(env.ctx);
      return problem ? unknown(problem) : env.ctx.portfolio.totalBase;
    },
  ],
  [
    "cash_value",
    (env) => {
      const problem = portfolioValueProblem(env.ctx) ?? cashHistoryProblem(env.ctx);
      return problem ? unknown(problem) : cashValue(env.ctx);
    },
  ],
  [
    "cash_weight",
    (env) => {
      const problem = portfolioDataProblem(env.ctx) ?? cashHistoryProblem(env.ctx);
      return problem ? unknown(problem) : cashValue(env.ctx).div(env.ctx.portfolio.totalBase);
    },
  ],
  ["stale_weight", (env) => ratio(env.ctx.portfolio.staleWeight, s.staleWeight[env.ctx.lang])],
  [
    "unclassified_weight",
    (env) => {
      const problem = portfolioDataProblem(env.ctx);
      if (problem) return unknown(problem);
      if (!env.ctx.allocations.length) return unknown(noAllocations(env.ctx.lang));
      return summedRatio(
        env.ctx.unclassified.map((h) => h.weight ?? 0),
        s.unclassifiedWeight[env.ctx.lang],
      );
    },
  ],
  [
    "max_position_weight",
    (env) => {
      const problem = portfolioDataProblem(env.ctx);
      if (problem) return unknown(problem);
      let best = 0;
      for (const p of positionsByInstrument(env.ctx)) {
        const reason = p.priceProblem;
        const weight = p.weight;
        if (reason || weight === null) return unknown(reason || s.noWeight[env.ctx.lang](p.label));
        // Python max(best, weight) retains best when the later operand is NaN.
        if (weight > best) best = weight;
      }
      return ratio(best, s.maximumWeight[env.ctx.lang]);
    },
  ],
  ["holdings_count", (env) => count(positionsByInstrument(env.ctx).length)],
  [
    "days_since_last_deposit",
    (env) => {
      const date = lastDepositDate(env.ctx);
      return date === null
        ? unknown(s.noDeposits[env.ctx.lang])
        : count(daysBetween(date, env.ctx.asOf));
    },
  ],
  [
    "monthly_contribution",
    (env) => env.ctx.contributions?.monthlyAmount ?? unknown(noContributionsPlan(env.ctx.lang)),
  ],
  ["bucket_weight", bucketField("weight")],
  ["bucket_target", bucketField("target", false)],
  ["bucket_drift_pp", bucketField("driftPp")],
  ["bucket_value", bucketField("valueBase")],
  [
    "tagged_weight",
    (env, args) => {
      const problem = portfolioDataProblem(env.ctx) ?? unclassifiedProblem(env.ctx);
      return problem
        ? unknown(problem)
        : ratio(taggedWeight(env.ctx, args.map(String))[0], s.tagWeight[env.ctx.lang]);
    },
  ],
  [
    "asset_class_weight",
    (env, args) => {
      const asset = parseAssetClass(String(args[0]));
      const cash = asset === AssetClass.CASH;
      const problem = portfolioDataProblem(env.ctx) ?? (cash ? cashHistoryProblem(env.ctx) : null);
      if (problem) return unknown(problem);
      if (cash) return cashValue(env.ctx).div(env.ctx.portfolio.totalBase);
      const weights = env.ctx.portfolio.valued
        .filter((h) => h.instrument.assetClass === asset)
        .map((h) => h.weight ?? 0);
      return summedRatio(weights, s.assetWeight[env.ctx.lang](asset));
    },
  ],
  ["symbol", (env) => position(env).label],
  ["asset_class", (env) => position(env).instrument.assetClass],
  ["currency", (env) => position(env).instrument.currency],
  [
    "mic",
    (env) => {
      const p = position(env);
      return p.instrument.mic ? pyUpper(p.instrument.mic) : unknown(s.noMic[env.ctx.lang](p.label));
    },
  ],
  [
    "weight",
    (env) => {
      if (env.allocation !== null || env.bucketId !== null) {
        const allocation = bucket(env, bucketId(env));
        return allocation instanceof Unknown
          ? allocation
          : allocationValue(env, allocation, "weight");
      }
      const p = position(env);
      const problem = portfolioDataProblem(env.ctx) ?? p.priceProblem;
      return problem ? unknown(problem) : ratio(p.weight, s.noWeight[env.ctx.lang](p.label));
    },
  ],
  [
    "market_value",
    (env) => {
      const p = position(env);
      const problem = p.priceProblem;
      const value = p.marketValueBase;
      return problem || value === null
        ? unknown(problem || s.noPrice[env.ctx.lang](p.label))
        : value;
    },
  ],
  [
    "cost_basis",
    (env) => {
      const p = position(env);
      return p.costBasisBase ?? unknown(unknownCostProblem(p.label, env.ctx.lang));
    },
  ],
  [
    "unrealized_pct",
    (env) => {
      const p = position(env);
      const problem = p.manualProblem ?? p.priceProblem ?? p.costProblem;
      return problem
        ? unknown(problem)
        : ratio(p.unrealizedPct, s.noUnrealized[env.ctx.lang](p.label));
    },
  ],
  [
    "unrealized_value",
    (env) => {
      const p = position(env);
      const value = p.marketValueBase;
      const cost = p.costBasisBase;
      const problem = p.manualProblem ?? p.priceProblem;
      if (problem || value === null) return unknown(problem || s.noPrice[env.ctx.lang](p.label));
      return cost === null ? unknown(unknownCostProblem(p.label, env.ctx.lang)) : value.sub(cost);
    },
  ],
  ["last_close", windowMetric(lastClose)],
  [
    "drawdown_from_high",
    windowMetric((bars) =>
      ONE.sub(
        lastClose(bars).div(
          bars.reduce(
            (high, bar) => (bar.close.gt(high) ? bar.close : high),
            (bars[0] as PriceBar).close,
          ),
        ),
      ),
    ),
  ],
  [
    "price_change",
    windowMetric((bars) =>
      lastClose(bars)
        .div((bars[0] as PriceBar).close)
        .sub(ONE),
    ),
  ],
  [
    "price_vs_sma",
    windowMetric((bars) =>
      lastClose(bars)
        .div(bars.reduce((sum, bar) => sum.add(bar.close), ZERO).div(count(bars.length)))
        .sub(ONE),
    ),
  ],
  ["holding_has_tag", (env, args) => hasAllTags(position(env).instrument, [String(args[0])])],
  ["bucket_id", (env) => bucketId(env)],
  ["target", bucketField("target", false, true)],
  ["drift_pp", bucketField("driftPp", true, true)],
  ["drift_rel", bucketField("driftRel", true, true)],
  ["value", bucketField("valueBase", true, true)],
  ["drift_value", bucketField("driftValueBase", true, true)],
]);
if (RESOLVERS.size !== METRICS.size || [...METRICS.keys()].some((name) => !RESOLVERS.has(name)))
  throw new Error("every catalog metric needs exactly one resolver");
