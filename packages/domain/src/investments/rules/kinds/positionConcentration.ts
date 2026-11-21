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
/** `position_concentration` (`rules/kinds/position_concentration.py`), the parsing side. */

import type { PyPlainMap } from "../../../pyYaml/plain.js";
import type { RuleKind } from "../kind.js";
import { type ParamErrors, ParamReader } from "../params.js";
import { SignalPolarity } from "../polarity.js";
import {
  formatPct,
  type InstrumentFilter,
  portfolioDataProblem,
  positionsByInstrument,
  RATIO_EPSILON,
  readInstrumentFilter,
} from "./support.js";

function evaluatePositionConcentration(
  ctx: RuleContext,
  spec: RuleSpec<PositionConcentrationParams>,
): RuleOutcome[] {
  const positions = positionsByInstrument(ctx, spec.params.filter);
  if (!positions.length) return [];
  const problem = portfolioDataProblem(ctx);
  if (problem !== null) return [new Skipped(spec.id, problem)];
  return positions.map((p): RuleOutcome => {
    const key = signalDedupKey(spec.id, { instrumentId: p.id });
    const weight = p.weight;
    const reason =
      p.priceProblem ?? (weight === null ? `${messages.noWeight[ctx.lang]}: ${p.label}` : null);
    if (reason !== null || weight === null)
      return new Skipped(spec.id, reason ?? messages.noWeight[ctx.lang], key);
    const details = { ...p.payload(), weight, max_weight: spec.params.maxWeight };
    if (weight <= spec.params.maxWeight + RATIO_EPSILON) return new NotFired(spec.id, key, details);
    return new Fired(
      candidate(
        spec,
        key,
        messages.concentration[ctx.lang](
          p.label,
          formatPct(weight, ctx.lang),
          formatPct(spec.params.maxWeight, ctx.lang),
        ),
        details,
        p.id,
      ),
    );
  });
}

export class PositionConcentrationParams {
  /** Largest allowed weight of one instrument across accounts (0.10 = 10%). */
  readonly maxWeight: number;
  readonly filter: InstrumentFilter;
  constructor(init: { readonly maxWeight: number; readonly filter?: InstrumentFilter }) {
    this.maxWeight = init.maxWeight;
    this.filter = init.filter ?? EMPTY_INSTRUMENT_FILTER;
  }
}

export const positionConcentrationRule: RuleKind<PositionConcentrationParams> = Object.freeze({
  kind: "position_concentration",
  defaultPolarity: SignalPolarity.NEGATIVE, // concentration risk
  paramsType: PositionConcentrationParams,
  evaluate: evaluatePositionConcentration,
  parseParams(raw: PyPlainMap, errors: ParamErrors): PositionConcentrationParams {
    const reader = new ParamReader(raw, errors);
    const params = {
      maxWeight: reader.number("max_weight", { minimum: 0, maximum: 1, exclusiveMin: true }),
      filter: readInstrumentFilter(reader),
    };
    reader.finish();
    return new PositionConcentrationParams(params);
  },
});
