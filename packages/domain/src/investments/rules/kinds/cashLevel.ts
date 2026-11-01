/** `cash_level` (`rules/kinds/cash_level.py`), the parsing side. */

import type { PyPlainMap } from "../../../pyYaml/plain.js";
import type { RuleKind } from "../kind.js";
import { type ParamErrors, ParamReader } from "../params.js";
import { SignalPolarity } from "../polarity.js";

export interface CashLevelParams {
  /** Smallest allowed cash share (0.02 = 2%), or null. */
  readonly minWeight: number | null;
  /** Largest allowed cash share (0.15 = 15%), or null. */
  readonly maxWeight: number | null;
}

export const cashLevelRule: RuleKind<CashLevelParams> = Object.freeze({
  kind: "cash_level",
  defaultPolarity: SignalPolarity.NEGATIVE, // a cash gap: idle cash or too little of it
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
    return { minWeight, maxWeight };
  },
});
