/**
 * The categorization resolver (`modules/budget/categorize/engine.py`): pure, deterministic, first
 * match wins. Every string literal below is Python's (pinned by the matching data, `engineLiterals`).
 */

import type { PaymentPattern } from "../../core/index.js";
import { D, type Decimal, ZERO } from "../../decimal.js";
import { ibanKey } from "../../iban.js";
import { normalizeText } from "../../text.js";
import { merchantKey } from "../ingestion/index.js";
import type { MerchantRule, RuleSource } from "./rules.js";
import { applySeedRules, applyTextRules, INCOME_KEYS } from "./taxonomy.js";

/** `category_source` values the engine produces. */
export type EngineSource = "transfer" | "keyword" | "subscription" | "default" | RuleSource;

export interface Categorization {
  readonly category: string;
  readonly source: EngineSource;
}

/** The transaction fields the engine reads. */
export interface EngineTxn {
  readonly amount: Decimal;
  readonly counterpartyName: string | null;
  readonly counterpartyIban: string | null;
  readonly description: string | null;
  readonly reference: string | null;
  readonly isInternalTransfer: boolean;
}

export interface EngineContext {
  /** D-08.1: `core.ownIbans` over every account of the vault (raw `iban_key`, removed ones too). */
  readonly ownIbans: ReadonlySet<string>;
  /** Merchant key -> rule (key `""` allowed, Q17). */
  readonly rules: ReadonlyMap<string, MerchantRule>;
  /** Module payment patterns (loans: each loan's lender account / title phrase). */
  readonly patterns: readonly PaymentPattern[];
  /** `core.textRules(builtinRegistry())`. */
  readonly moduleTextRules: readonly (readonly [string, string])[];
}

/** @package The two rule lookups the engine repeats per row; `createCategorizer` memoizes them. */
export interface EngineLookups {
  seed(merchantKey: string): string | null;
  text(text: string, moduleTextRules: readonly (readonly [string, string])[]): string | null;
}

/** The plain lookups (no cache). */
const PLAIN_LOOKUPS: EngineLookups = { seed: applySeedRules, text: applyTextRules };

const TRANSFER: Categorization = Object.freeze({ category: "transfer", source: "transfer" });

/** `engine._text`: reference, description and counterparty (non-empty ones) normalized. */
export function txnText(t: EngineTxn): string {
  return normalizeText(
    [t.reference, t.description, t.counterpartyName].filter((f): f is string => !!f).join(" "),
  );
}

/** `merchant_key(counterparty_name, reference, description)` (argument order matters). */
export function txnMerchantKey(t: EngineTxn): string {
  return merchantKey(t.counterpartyName, t.reference, t.description);
}

/** `_pattern_match`: the category of the first payment pattern an outflow (zero included, Q3) hits. */
function patternMatch(
  t: EngineTxn,
  cp: string,
  text: string,
  patterns: readonly PaymentPattern[],
): string | null {
  if (t.amount.gt(ZERO)) return null; // PARITY(Q3): zero counts as an outflow
  for (const p of patterns) {
    if (
      (p.counterpartyIban && cp && ibanKey(p.counterpartyIban) === cp) ||
      (p.text && text.includes(p.text))
    ) {
      return p.category;
    }
  }
  return null;
}

/**
 * The Polish split-payment (MPP) message `/VAT/<vat amount>/IDC/<NIP>/INV/<invoice>` (comma or dot
 * decimals), as banks put it in the title.
 */
const MPP_MESSAGE = /\/VAT\/(\d{1,15}(?:[.,]\d{1,2})?)\/IDC\/[^/]*\/INV\//i;

/**
 * A split-payment VAT move (native rule, not in the Python engine): an outflow whose MPP title names
 * a VAT amount equal to the whole outflow. The bank moves the VAT of a split-paid invoice from the
 * main account to the owner's VAT account (often not visible to cashU, so the transfer matcher
 * cannot pair it). A payment to a supplier carries the gross amount and a smaller VAT amount, so it
 * stays an expense.
 */
export function isSplitPaymentVatMove(t: EngineTxn): boolean {
  if (!t.amount.lt(ZERO)) return false;
  for (const field of [t.reference, t.description]) {
    const m = field ? MPP_MESSAGE.exec(field) : null;
    if (m?.[1] && D(m[1].replace(",", ".")).eq(t.amount.abs())) return true;
  }
  return false;
}

function ownerDecisionAt(t: EngineTxn, mk: string, ctx: EngineContext): Categorization | null {
  const cp = t.counterpartyIban ? ibanKey(t.counterpartyIban) : "";
  if (
    t.isInternalTransfer ||
    (cp && ctx.ownIbans.has(cp)) ||
    mk.includes("TRANSAKCJA WALUT") ||
    mk.includes("PRZEWALUTOWANIE") ||
    isSplitPaymentVatMove(t)
  ) {
    return TRANSFER;
  }
  const rule = ctx.rules.get(mk);
  if (rule?.locked) return { category: rule.category, source: rule.source };
  if (ctx.patterns.length === 0) return null;
  const hit = patternMatch(t, cp, txnText(t), ctx.patterns);
  return hit === null ? null : { category: hit, source: "keyword" };
}

/**
 * `owner_decision` (engine.py:86-121): what structure or the owner's configuration decides, else
 * null. 1. a move between own accounts, an FX conversion or a split-payment VAT move (native) ->
 * transfer; 2. a locked merchant rule;
 * 3. a module payment pattern (outflows) -> keyword.
 */
export function ownerDecision(t: EngineTxn, ctx: EngineContext): Categorization | null {
  return ownerDecisionAt(t, txnMerchantKey(t), ctx);
}

/** @package `categorize` with the given lookups (plain or memoized). */
export function categorizeWith(
  t: EngineTxn,
  ctx: EngineContext,
  subscriptionKeys: ReadonlySet<string>,
  lookups: EngineLookups,
): Categorization {
  const mk = txnMerchantKey(t);
  const decided = ownerDecisionAt(t, mk, ctx);
  if (decided !== null) return decided;
  const rule = ctx.rules.get(mk);
  // 4. A cached LLM answer (or any unlocked rule: its source verbatim, Q17).
  if (rule !== undefined) return { category: rule.category, source: rule.source };
  const seed = lookups.seed(mk);
  // 5. Income (inflows), separate from the expense seeds.
  if (t.amount.gt(ZERO)) {
    if (seed && INCOME_KEYS.has(seed)) return { category: seed, source: "keyword" };
    if (mk.includes("WYNAGRODZENIE") || mk.includes("PENSJA")) {
      return { category: "income_salary", source: "keyword" };
    }
    return { category: "income_other", source: "default" };
  }
  // 6. Expense (zero included, PARITY(Q3)): phrase in the whole text, seed, recurring, default.
  const phrase = lookups.text(txnText(t), ctx.moduleTextRules);
  if (phrase) return { category: phrase, source: "keyword" };
  if (seed && !INCOME_KEYS.has(seed)) return { category: seed, source: "keyword" };
  if (mk && subscriptionKeys.has(mk)) return { category: "subscriptions", source: "subscription" };
  return { category: "other", source: "default" };
}

/**
 * `categorize` (engine.py:16-63): owner decision, merchant rule, income by sign, then for outflows
 * a text phrase, a seed rule, the recurring signal (`subscriptionKeys`) or `other/default`.
 */
export function categorize(
  t: EngineTxn,
  ctx: EngineContext,
  subscriptionKeys: ReadonlySet<string>,
): Categorization {
  return categorizeWith(t, ctx, subscriptionKeys, PLAIN_LOOKUPS);
}
