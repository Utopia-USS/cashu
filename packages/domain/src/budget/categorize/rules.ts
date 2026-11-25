/** Learned merchant -> category rules (`modules/budget/categorize/rules.py`), as pure decisions. */

/** Who set a merchant rule: the owner (`manual`) or a cached LLM answer (`llm`). */
export type RuleSource = "manual" | "llm";

export interface MerchantRule {
  readonly merchantKey: string;
  readonly category: string;
  readonly source: RuleSource;
  /** A locked rule is the owner's decision: an LLM answer never replaces it. */
  readonly locked: boolean;
}

/**
 * `upsert_rule` (rules.py:21-54) as a decision: the rule an upsert stores, or `"keep"` when the
 * existing rule is locked and the new source is not `manual` (an LLM guess never clobbers a human
 * decision). `locked` defaults to `source === "manual"`. The store command uses it to skip a no-op.
 */
export function ruleUpsert(
  existing: MerchantRule | undefined,
  merchantKey: string,
  next: { readonly category: string; readonly source: RuleSource; readonly locked?: boolean },
): MerchantRule | "keep" {
  if (existing?.locked && next.source !== "manual") return "keep";
  return {
    merchantKey,
    category: next.category,
    source: next.source,
    locked: next.locked ?? next.source === "manual",
  };
}

/** `load_rules`: merchant key -> rule (a later duplicate key wins, like the Python dict). */
export function rulesByMerchant(rules: Iterable<MerchantRule>): Map<string, MerchantRule> {
  const out = new Map<string, MerchantRule>();
  for (const r of rules) out.set(r.merchantKey, r);
  return out;
}
