/** `drawdown_from_high` (`rules/kinds/drawdown_from_high.py`), the parsing side. */

import type { PyPlainMap } from "../../../pyYaml/plain.js";
import type { RuleKind } from "../kind.js";
import { type ParamErrors, ParamReader } from "../params.js";
import { SignalPolarity } from "../polarity.js";
import { type InstrumentFilter, readInstrumentFilter } from "./support.js";

export const DEFAULT_WINDOW_DAYS = 252;

export interface DrawdownFromHighParams {
  /** Size of the drop from the high as a fraction (0.15 = 15% below the high). */
  readonly threshold: number;
  /** Window length in daily bars (sessions), including the last one; 252 is about one year. */
  readonly windowDays: number;
  readonly filter: InstrumentFilter;
}

export const drawdownFromHighRule: RuleKind<DrawdownFromHighParams> = Object.freeze({
  kind: "drawdown_from_high",
  defaultPolarity: SignalPolarity.POSITIVE, // a dip: a tranche per the plan on a core holding
  parseParams(raw: PyPlainMap, errors: ParamErrors): DrawdownFromHighParams {
    const reader = new ParamReader(raw, errors);
    const params = {
      threshold: reader.number("threshold", {
        minimum: 0,
        maximum: 1,
        exclusiveMin: true,
        exclusiveMax: true,
      }),
      windowDays: reader.integer("window_days", { fallback: DEFAULT_WINDOW_DAYS, minimum: 2 }),
      filter: readInstrumentFilter(reader),
    };
    reader.finish();
    return params;
  },
});
