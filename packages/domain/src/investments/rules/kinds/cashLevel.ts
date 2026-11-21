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
/** `cash_level` (`rules/kinds/cash_level.py`), the parsing side. */

import type { PyPlainMap } from "../../../pyYaml/plain.js";
import type { RuleKind } from "../kind.js";
import { type ParamErrors, ParamReader } from "../params.js";
import { SignalPolarity } from "../polarity.js";
import {
  cashHistoryProblem,
  cashValue,
  decimalText,
  formatPct,
  portfolioDataProblem,
  RATIO_EPSILON,
} from "./support.js";

function evaluateCashLevel(ctx: RuleContext, spec: RuleSpec<CashLevelParams>): RuleOutcome[] {
  const problem = portfolioDataProblem(ctx) ?? cashHistoryProblem(ctx);
  if (problem !== null) return [new Skipped(spec.id, problem)];
  const cash = cashValue(ctx);
  const weight = cash.div(ctx.portfolio.totalBase).toFloat();
  const { minWeight, maxWeight } = spec.params;
  const key = signalDedupKey(spec.id);
  const details = {
    cash_weight: weight,
    cash_base: decimalText(cash),
    total_base: decimalText(ctx.portfolio.totalBase),
    currency: ctx.portfolio.baseCurrency,
    min_weight: minWeight,
    max_weight: maxWeight,
  };
  const below = minWeight !== null && weight < minWeight - RATIO_EPSILON;
  const above = maxWeight !== null && weight > maxWeight + RATIO_EPSILON;
  if (!below && !above) return [new NotFired(spec.id, key, details)];
  const threshold = below ? minWeight : maxWeight;
  if (threshold === null) throw new Error("cash threshold missing");
  return [
    new Fired(
      candidate(
        spec,
        key,
        messages.cash[ctx.lang](formatPct(weight, ctx.lang), below, formatPct(threshold, ctx.lang)),
        { ...details, direction: below ? "below_min" : "above_max" },
      ),
    ),
  ];
}

export class CashLevelParams {
  /** Smallest allowed cash share (0.02 = 2%), or null. */
  readonly minWeight: number | null;
  /** Largest allowed cash share (0.15 = 15%), or null. */
  readonly maxWeight: number | null;
  constructor(
    init: { readonly minWeight?: number | null; readonly maxWeight?: number | null } = {},
  ) {
    this.minWeight = init.minWeight ?? null;
    this.maxWeight = init.maxWeight ?? null;
  }
}

export const cashLevelRule: RuleKind<CashLevelParams> = Object.freeze({
  kind: "cash_level",
  defaultPolarity: SignalPolarity.NEGATIVE, // a cash gap: idle cash or too little of it
  paramsType: CashLevelParams,
  evaluate: evaluateCashLevel,
  parseParams(raw: PyPlainMap, errors: ParamErrors): CashLevelParams {
    const reader = new ParamReader(raw, errors);
    const minWeight = reader.optionalNumber("min_weight", {
      minimum: 0,
      maximum: 1,
      exclusiveMax: true,
    });
    const maxWeight = reader.optionalNumber("max_weight", {
      minimum: 0,
      maximum: 1,
      exclusiveMin: true,
    });
    reader.finish();
    if (!reader.has("min_weight") && !reader.has("max_weight")) {
      errors.error("", "cash_level needs min_weight, max_weight or both");
    } else if (minWeight !== null && maxWeight !== null && minWeight >= maxWeight) {
      errors.error("min_weight", "min_weight must be below max_weight");
    }
    return new CashLevelParams({ minWeight, maxWeight });
  },
});
