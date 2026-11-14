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
import { EMPTY_INSTRUMENT_FILTER } from "./support.js";
/** `loss_from_cost` / `gain_from_cost` (`rules/kinds/unrealized_from_cost.py`), the parsing side. */

import type { PyPlainMap } from "../../../pyYaml/plain.js";
import type { RuleKind } from "../kind.js";
import { type ParamErrors, ParamReader } from "../params.js";
import { SignalPolarity } from "../polarity.js";
import {
  decimalText,
  formatPct,
  type InstrumentFilter,
  positionsByInstrument,
  RATIO_EPSILON,
  readInstrumentFilter,
} from "./support.js";

function evaluateUnrealized(kind: string) {
  return (ctx: RuleContext, spec: RuleSpec<UnrealizedThresholdParams>): RuleOutcome[] => {
    const loss = kind === "loss_from_cost";
    const threshold = spec.params.threshold;
    return positionsByInstrument(ctx, spec.params.filter).map((p): RuleOutcome => {
      const key = signalDedupKey(spec.id, { instrumentId: p.id });
      const problem = p.manualProblem ?? p.priceProblem ?? p.costProblem;
      const pct = p.unrealizedPct;
      if (problem !== null || pct === null)
        return new Skipped(spec.id, problem ?? messages.noUnrealized[ctx.lang], key);
      const value = p.marketValueBase;
      const cost = p.costBasisBase;
      if (value === null || cost === null)
        throw new Error("usable unrealized result lacks value or cost");
      const details = {
        ...p.payload(),
        unrealized_pct: pct,
        threshold,
        market_value_base: decimalText(value),
        cost_basis_base: decimalText(cost),
        currency: ctx.portfolio.baseCurrency,
      };
      const hit = loss ? pct <= -threshold + RATIO_EPSILON : pct >= threshold - RATIO_EPSILON;
      if (!hit) return new NotFired(spec.id, key, details);
      const sign = loss ? "-" : "+";
      return new Fired(
        candidate(
          spec,
          key,
          messages.unrealized[ctx.lang](
            p.label,
            `${sign}${formatPct(loss ? -pct : pct, ctx.lang)}`,
            `${sign}${formatPct(threshold, ctx.lang)}`,
          ),
          details,
          p.id,
        ),
      );
    });
  };
}

export class UnrealizedThresholdParams {
  /** Size of the move as a positive fraction of the cost basis (0.25 = 25%). */
  readonly threshold: number;
  readonly filter: InstrumentFilter;
  constructor(init: { readonly threshold: number; readonly filter?: InstrumentFilter }) {
    this.threshold = init.threshold;
    this.filter = init.filter ?? EMPTY_INSTRUMENT_FILTER;
  }
}

function unrealizedRule(
  kind: string,
  defaultPolarity: SignalPolarity,
  maxThreshold: number | undefined,
): RuleKind<UnrealizedThresholdParams> {
  return Object.freeze({
    kind,
    defaultPolarity,
    paramsType: UnrealizedThresholdParams,
    evaluate: evaluateUnrealized(kind),
    parseParams(raw: PyPlainMap, errors: ParamErrors): UnrealizedThresholdParams {
      const reader = new ParamReader(raw, errors);
      const params = {
        threshold: reader.number("threshold", {
          minimum: 0,
          ...(maxThreshold === undefined ? {} : { maximum: maxThreshold }),
          exclusiveMin: true,
          exclusiveMax: true,
        }),
        filter: readInstrumentFilter(reader),
      };
      reader.finish();
      return new UnrealizedThresholdParams(params);
    },
  });
}

/** Fires when (value - cost) / cost <= -threshold (`threshold: 0.25` = a 25% loss; below 1). */
export const lossFromCostRule = unrealizedRule("loss_from_cost", SignalPolarity.NEGATIVE, 1.0);

/** Fires when (value - cost) / cost >= threshold (`threshold: 0.5` = a 50% gain; > 1 allowed). */
export const gainFromCostRule = unrealizedRule(
  "gain_from_cost",
  SignalPolarity.POSITIVE,
  undefined,
);
