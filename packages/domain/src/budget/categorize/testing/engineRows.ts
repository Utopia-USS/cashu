/** Builders of engine inputs for hand-written tests (tests only). */
import { builtinRegistry, ownIbans, type PaymentPattern, textRules } from "../../../core/index.js";
import { D } from "../../../decimal.js";
import type { EngineContext, EngineTxn } from "../engine.js";
import { type MerchantRule, type RuleSource, rulesByMerchant } from "../rules.js";

export type RuleVector = [string, string, string, boolean];
export type PatternVector = [string, string | null, string | null];

export const MODULE_TEXT_RULES = textRules(builtinRegistry());

function ruleFromVector([merchantKey, category, source, locked]: RuleVector): MerchantRule {
  return { merchantKey, category, source: source as RuleSource, locked };
}

function patternFromVector([category, counterpartyIban, text]: PatternVector): PaymentPattern {
  return { category, counterpartyIban, text };
}

export function contextFrom(
  accountIbans: readonly (string | null)[],
  rules: readonly RuleVector[],
  patterns: readonly PatternVector[],
): EngineContext {
  return {
    ownIbans: ownIbans(accountIbans.map((iban) => ({ iban }))),
    rules: rulesByMerchant(rules.map(ruleFromVector)),
    patterns: patterns.map(patternFromVector),
    moduleTextRules: MODULE_TEXT_RULES,
  };
}

/** A transaction like the oracle tests' `_txn(amount, title, cp=, iban=)`: title in reference and description. */
export function titled(
  amount: string,
  title: string,
  opts: { cp?: string; iban?: string; internal?: boolean } = {},
): EngineTxn {
  return {
    amount: D(amount),
    counterpartyName: opts.cp ?? null,
    counterpartyIban: opts.iban ?? null,
    reference: title,
    description: title,
    isInternalTransfer: opts.internal ?? false,
  };
}

export const EMPTY_CONTEXT: EngineContext = contextFrom([], [], []);
