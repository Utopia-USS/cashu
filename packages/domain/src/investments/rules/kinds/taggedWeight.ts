/** `tagged_weight` (`rules/kinds/tagged_weight.py`), the parsing side. */

import type { PyPlainMap } from "../../../pyYaml/plain.js";
import type { RuleKind } from "../kind.js";
import { type ParamErrors, ParamReader } from "../params.js";
import { SignalPolarity } from "../polarity.js";

export interface TaggedWeightParams {
  /** Every holding carrying ALL of these tags counts (case-insensitive, like bucket `match.tags`). */
  readonly tags: readonly string[];
  /** Largest allowed summed weight (0.30 = 30%). */
  readonly maxWeight: number;
}

export const taggedWeightRule: RuleKind<TaggedWeightParams> = Object.freeze({
  kind: "tagged_weight",
  defaultPolarity: SignalPolarity.NEGATIVE, // a tagged group out of its weight range
  parseParams(raw: PyPlainMap, errors: ParamErrors): TaggedWeightParams {
    const reader = new ParamReader(raw, errors);
    const tags = reader.strings("tags");
    if (tags.length === 0 && !reader.has("tags")) {
      errors.error("tags", "tags is required (one tag or a list of tags)");
    }
    const maxWeight = reader.number("max_weight", { minimum: 0, maximum: 1, exclusiveMin: true });
    reader.finish();
    return { tags, maxWeight };
  },
});
