/** `position_concentration` (`rules/kinds/position_concentration.py`), the parsing side. */

import type { PyPlainMap } from "../../../pyYaml/plain.js";
import type { RuleKind } from "../kind.js";
import { type ParamErrors, ParamReader } from "../params.js";
import { SignalPolarity } from "../polarity.js";
import { type InstrumentFilter, readInstrumentFilter } from "./support.js";

export interface PositionConcentrationParams {
  /** Largest allowed weight of one instrument across accounts (0.10 = 10%). */
  readonly maxWeight: number;
  readonly filter: InstrumentFilter;
}

export const positionConcentrationRule: RuleKind<PositionConcentrationParams> = Object.freeze({
  kind: "position_concentration",
  defaultPolarity: SignalPolarity.NEGATIVE, // concentration risk
  parseParams(raw: PyPlainMap, errors: ParamErrors): PositionConcentrationParams {
    const reader = new ParamReader(raw, errors);
    const params = {
      maxWeight: reader.number("max_weight", { minimum: 0, maximum: 1, exclusiveMin: true }),
      filter: readInstrumentFilter(reader),
    };
    reader.finish();
    return params;
  },
});
