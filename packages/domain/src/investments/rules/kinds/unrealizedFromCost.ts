/** `loss_from_cost` / `gain_from_cost` (`rules/kinds/unrealized_from_cost.py`), the parsing side. */

import type { PyPlainMap } from "../../../pyYaml/plain.js";
import type { RuleKind } from "../kind.js";
import { type ParamErrors, ParamReader } from "../params.js";
import { SignalPolarity } from "../polarity.js";
import { type InstrumentFilter, readInstrumentFilter } from "./support.js";

export interface UnrealizedThresholdParams {
  /** Size of the move as a positive fraction of the cost basis (0.25 = 25%). */
  readonly threshold: number;
  readonly filter: InstrumentFilter;
}

function unrealizedRule(
  kind: string,
  defaultPolarity: SignalPolarity,
  maxThreshold: number | undefined,
): RuleKind<UnrealizedThresholdParams> {
  return Object.freeze({
    kind,
    defaultPolarity,
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
      return params;
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
