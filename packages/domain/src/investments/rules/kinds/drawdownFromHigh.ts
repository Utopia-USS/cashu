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

/** `drawdown_from_high` (`rules/kinds/drawdown_from_high.py`), the parsing side. */

import { ONE } from "../../../decimal.js";
import type { PyPlainMap } from "../../../pyYaml/plain.js";
import { dividedBy } from "../../domain/values.js";
import type { RuleKind } from "../kind.js";
import { type ParamErrors, ParamReader } from "../params.js";
import { SignalPolarity } from "../polarity.js";
import {
  decimalText,
  formatDecimal,
  formatPct,
  type InstrumentFilter,
  positionsByInstrument,
  RATIO_EPSILON,
  readInstrumentFilter,
  windowBars,
} from "./support.js";

function evaluateDrawdownFromHigh(
  ctx: RuleContext,
  spec: RuleSpec<DrawdownFromHighParams>,
): RuleOutcome[] {
  const params = spec.params;
  return positionsByInstrument(ctx, params.filter).map((p): RuleOutcome => {
    const key = signalDedupKey(spec.id, { instrumentId: p.id });
    const window = windowBars(ctx, p, params.windowDays);
    if (typeof window === "string") return new Skipped(spec.id, window, key);
    const { last, high } = window;
    const drawdown = ONE.sub(dividedBy(last.close, high.close)).toFloat();
    const details = {
      ...p.payload(),
      drawdown,
      threshold: params.threshold,
      window_days: params.windowDays,
      high_close: decimalText(high.close),
      high_date: high.date,
      last_close: decimalText(last.close),
      last_date: last.date,
    };
    if (drawdown < params.threshold - RATIO_EPSILON) return new NotFired(spec.id, key, details);
    return new Fired(
      candidate(
        spec,
        key,
        messages.drawdown[ctx.lang](
          p.label,
          formatPct(drawdown, ctx.lang),
          params.windowDays,
          formatDecimal(last.close, ctx.lang),
          last.date,
          formatDecimal(high.close, ctx.lang),
          high.date,
          formatPct(params.threshold, ctx.lang),
        ),
        details,
        p.id,
      ),
    );
  });
}

export const DEFAULT_WINDOW_DAYS = 252;

export class DrawdownFromHighParams {
  /** Size of the drop from the high as a fraction (0.15 = 15% below the high). */
  readonly threshold: number;
  /** Window length in daily bars (sessions), including the last one; 252 is about one year. */
  readonly windowDays: number;
  readonly filter: InstrumentFilter;
  constructor(init: {
    readonly threshold: number;
    readonly windowDays?: number;
    readonly filter?: InstrumentFilter;
  }) {
    this.threshold = init.threshold;
    this.windowDays = init.windowDays ?? DEFAULT_WINDOW_DAYS;
    this.filter = init.filter ?? EMPTY_INSTRUMENT_FILTER;
  }
}

export const drawdownFromHighRule: RuleKind<DrawdownFromHighParams> = Object.freeze({
  kind: "drawdown_from_high",
  defaultPolarity: SignalPolarity.POSITIVE, // a dip: a tranche per the plan on a core holding
  paramsType: DrawdownFromHighParams,
  evaluate: evaluateDrawdownFromHigh,
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
    return new DrawdownFromHighParams(params);
  },
});
