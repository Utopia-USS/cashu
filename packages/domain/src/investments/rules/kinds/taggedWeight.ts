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
/** `tagged_weight` (`rules/kinds/tagged_weight.py`), the parsing side. */

import type { PyPlainMap } from "../../../pyYaml/plain.js";
import type { RuleKind } from "../kind.js";
import { type ParamErrors, ParamReader } from "../params.js";
import { SignalPolarity } from "../polarity.js";
import {
  formatPct,
  portfolioDataProblem,
  RATIO_EPSILON,
  taggedWeight,
  unclassifiedProblem,
} from "./support.js";

function evaluateTaggedWeight(ctx: RuleContext, spec: RuleSpec<TaggedWeightParams>): RuleOutcome[] {
  const problem = portfolioDataProblem(ctx) ?? unclassifiedProblem(ctx);
  if (problem !== null) return [new Skipped(spec.id, problem)];
  const { tags, maxWeight } = spec.params;
  const [weight, labels] = taggedWeight(ctx, tags);
  const key = signalDedupKey(spec.id);
  const details = { tags: [...tags], weight, max_weight: maxWeight, instruments: labels };
  if (weight <= maxWeight + RATIO_EPSILON) return [new NotFired(spec.id, key, details)];
  const text = messages.tagged[ctx.lang](
    tags.join(", "),
    formatPct(weight, ctx.lang),
    formatPct(maxWeight, ctx.lang),
    labels.join(", "),
  );
  return [new Fired(candidate(spec, key, text, details))];
}

export class TaggedWeightParams {
  /** Every holding carrying ALL of these tags counts (case-insensitive, like bucket `match.tags`). */
  readonly tags: readonly string[];
  /** Largest allowed summed weight (0.30 = 30%). */
  readonly maxWeight: number;
  constructor(init: { readonly tags: readonly string[]; readonly maxWeight: number }) {
    this.tags = init.tags;
    this.maxWeight = init.maxWeight;
  }
}

export const taggedWeightRule: RuleKind<TaggedWeightParams> = Object.freeze({
  kind: "tagged_weight",
  defaultPolarity: SignalPolarity.NEGATIVE, // a tagged group out of its weight range
  paramsType: TaggedWeightParams,
  evaluate: evaluateTaggedWeight,
  parseParams(raw: PyPlainMap, errors: ParamErrors): TaggedWeightParams {
    const reader = new ParamReader(raw, errors);
    const tags = reader.strings("tags");
    if (tags.length === 0 && !reader.has("tags")) {
      errors.error("tags", "tags is required (one tag or a list of tags)");
    }
    const maxWeight = reader.number("max_weight", { minimum: 0, maximum: 1, exclusiveMin: true });
    reader.finish();
    return new TaggedWeightParams({ tags, maxWeight });
  },
});
