/**
 * The parsing side of the rules contract (`rules/kind.py`): configured rule specs, the rule-kind
 * interface as the strategy loader uses it (`parseParams`) and the strategy policies the rules read.
 * Evaluation is pure and guards parsed parameters by their actual runtime class.
 */

import type { PyPlainMap } from "../../pyYaml/plain.js";
import type { RuleSpec } from "./config.js";
import type { RuleContext } from "./context.js";
import type { RuleOutcome } from "./outcomes.js";
import type { ParamErrors } from "./params.js";
import type { SignalPolarity } from "./polarity.js";

/** One kind of rule from the fixed catalog, as far as the strategy loader needs it. */
export interface RuleKind<P = unknown> {
  /** The `kind:` value in strategy.yaml. */
  readonly kind: string;
  /** The polarity of its signals unless the rule sets `polarity:` (`DEFAULT_POLARITY`). */
  readonly defaultPolarity: SignalPolarity;
  /**
   * Validates and converts the rule's raw `params:` map. Problems go to `errors`; when any error was
   * recorded the returned value is discarded, so it returns something with fallback values.
   */
  readonly paramsType: abstract new (
    ...args: never[]
  ) => P;
  evaluate(ctx: RuleContext, spec: RuleSpec<P>): Iterable<RuleOutcome>;
  parseParams(raw: PyPlainMap, errors: ParamErrors): P;
}

export {
  type ContributionPlan,
  DATA_QUALITY_KEYS,
  type DataQualityPolicy,
  DEFAULT_DATA_QUALITY,
  DEFAULT_MAX_UNVERIFIED_DAYS,
  MAX_UNVERIFIED_DAYS,
  type RuleSpec,
} from "./config.js";
