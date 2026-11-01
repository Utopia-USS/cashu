/** Builders of engine inputs from the S09 vectors and for hand-written tests (tests only). */
import { builtinRegistry, ownIbans, type PaymentPattern, textRules } from "../../../core/index.js";
import { D } from "../../../decimal.js";
import type { Mismatches } from "../../../testing/vectors.js";
import { categorize, type EngineContext, type EngineTxn, ownerDecision } from "../engine.js";
import { type MerchantRule, type RuleSource, rulesByMerchant } from "../rules.js";
import { ENGINE_OWN_IBANS } from "./vectors.js";

type TxnVector = [
  string,
  string | null,
  string | null,
  string | null,
  string | null,
  boolean,
];
export type RuleVector = [string, string, string, boolean];
export type PatternVector = [string, string | null, string | null];

export const MODULE_TEXT_RULES = textRules(builtinRegistry());

function txnFromVector([
  amount,
  name,
  iban,
  reference,
  description,
  internal,
]: TxnVector): EngineTxn {
  return {
    amount: D(amount),
    counterpartyName: name,
    counterpartyIban: iban,
    reference,
    description,
    isInternalTransfer: internal,
  };
}

function ruleFromVector([merchantKey, category, source, locked]: RuleVector): MerchantRule {
  return { merchantKey, category, source: source as RuleSource, locked };
}

function patternFromVector([
  category,
  counterpartyIban,
  text,
]: PatternVector): PaymentPattern {
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

export type EngineCase = [
  number,
  TxnVector[],
  RuleVector[],
  PatternVector[],
  string[],
  [[string, string] | null, [string, string]][],
];

/** Runs engine vector cases (`budget-categorize-engine`) into `m`. */
export function checkEngine(cases: readonly EngineCase[], m: Mismatches): void {
  for (const [n, txns, rules, patterns, subs, want] of cases) {
    const ctx = contextFrom(ENGINE_OWN_IBANS, rules, patterns);
    const keys = new Set(subs);
    txns.forEach((tv, i) => {
      const t = txnFromVector(tv);
      const od = ownerDecision(t, ctx);
      const c = categorize(t, ctx, keys);
      m.check(
        `case ${n} txn ${i}`,
        [od && [od.category, od.source], [c.category, c.source]],
        want[i],
      );
    });
  }
}
