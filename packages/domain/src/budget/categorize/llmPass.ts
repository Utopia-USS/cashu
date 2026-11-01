/** The LLM half of `categorize_all` (service.py:195-230) around the merchant classifier port. */

import type { Decimal } from "../../decimal.js";
import { ZERO } from "../../decimal.js";
import { AUTO_CATEGORY_KEYS, STRUCTURAL_CATEGORIES } from "./taxonomy.js";

/** Python `sorted` of str: code point order (JavaScript's default sort is UTF-16 order, Q16). */
export function codePointCompare(a: string, b: string): number {
  const ai = a[Symbol.iterator]();
  const bi = b[Symbol.iterator]();
  for (;;) {
    const x = ai.next();
    const y = bi.next();
    if (x.done || y.done) return (x.done ? 0 : 1) - (y.done ? 0 : 1);
    const d = (x.value.codePointAt(0) as number) - (y.value.codePointAt(0) as number);
    if (d !== 0) return d;
  }
}

/**
 * The merchants the LLM pass asks about: merchant keys of outflows whose effective source is
 * `default` (the engine could not decide), without `""`, sorted by code point.
 */
export function unknownMerchants(
  rows: Iterable<{
    readonly amount: Decimal;
    readonly merchantKey: string;
    readonly source: string | null;
  }>,
): string[] {
  const out = new Set<string>();
  for (const r of rows) if (r.amount.lt(ZERO) && r.source === "default") out.add(r.merchantKey);
  out.delete("");
  return [...out].sort(codePointCompare);
}

const ACCEPTED: ReadonlySet<string> = new Set(
  AUTO_CATEGORY_KEYS.filter((k) => k !== "other" && !STRUCTURAL_CATEGORIES.has(k)),
);

/**
 * Whether a merchant answer becomes a cached `llm` rule (`categoryRule.set {llm, locked: false}`).
 * Python accepts any `AUTO_CATEGORY_KEYS` key but `other`. FIX(Q9, D-09.5a): `transfer` and
 * `cash_withdrawal` are refused too, so a real expense can never be hidden from spending as a
 * money move (reclassify already forbids them). The enum sent stays byte-identical.
 */
export function acceptMerchantAnswer(category: string | undefined | null): string | null {
  return category != null && ACCEPTED.has(category) ? category : null;
}
