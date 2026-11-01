/**
 * The effective category of a row: the precedence of events.md 8.3 (service.py:158-193 under the
 * D-24.1 full recompute). Claims (the owner's or an LLM's per-row answers) are facts; everything
 * else is derived from them, the rules, the patterns and the recurring signal.
 */

import {
  type Categorization,
  categorizeWith,
  type EngineContext,
  type EngineLookups,
  type EngineTxn,
  ownerDecision,
} from "./engine.js";
import {
  detectRecurringWith,
  type RecurringCandidate,
  type RecurringOptions,
  type RecurringRow,
  subscriptionPayees,
} from "./recurring.js";
import { applySeedRules, applyTextRules } from "./taxonomy.js";

/** Per-row category decisions stored as facts (`txn.categorySet` and the cash legs). */
export type ClaimSource = "manual_txn" | "llm_full" | "llm_fallback" | "cash_leg";

export interface CategoryClaimValue {
  readonly category: string;
  readonly source: ClaimSource;
}

export interface CategorizeRow extends Omit<RecurringRow, "decided"> {
  readonly key: string;
  readonly onCashAccount: boolean;
  readonly claim: CategoryClaimValue | null;
}

/** null = no category (Python `(NULL, NULL)`, D-09.4). */
export type Effective = { readonly category: string; readonly source: string } | null;

/** The engine bound to one context, with the seed and text lookups memoized (one derive run). */
export interface Categorizer {
  categorize(t: EngineTxn, subscriptionKeys: ReadonlySet<string>): Categorization;
  ownerDecision(t: EngineTxn): Categorization | null;
  effective(row: CategorizeRow, subscriptionKeys: ReadonlySet<string>): Effective;
  detectRecurring(
    rows: readonly CategorizeRow[],
    notSubscription: ReadonlySet<string>,
    opts?: RecurringOptions,
  ): RecurringCandidate[];
}

const asRecurring = (row: CategorizeRow): RecurringRow => ({ ...row, decided: row.claim });

/** Seed / text lookups cached by merchant key / text, owned by one categorizer (no global state). */
function memoLookups(): EngineLookups {
  const seeds = new Map<string, string | null>();
  const texts = new Map<string, string | null>();
  return {
    seed(mk) {
      let v = seeds.get(mk);
      if (v === undefined) {
        v = applySeedRules(mk);
        seeds.set(mk, v);
      }
      return v;
    },
    text(text, moduleTextRules) {
      let v = texts.get(text);
      if (v === undefined) {
        v = applyTextRules(text, moduleTextRules);
        texts.set(text, v);
      }
      return v;
    },
  };
}

/** A categorizer for one context (the store deriver creates one per derive run; R5). */
export function createCategorizer(ctx: EngineContext): Categorizer {
  const lookups = memoLookups();
  const categorize = (t: EngineTxn, keys: ReadonlySet<string>) =>
    categorizeWith(t, ctx, keys, lookups);
  return {
    categorize,
    ownerDecision: (t) => ownerDecision(t, ctx),
    effective(row, keys) {
      const claim = row.claim;
      // (a) cash-account rows are managed by hand: the claim, else no category (D-09.4).
      if (row.onCashAccount)
        return claim ? { category: claim.category, source: claim.source } : null;
      if (claim?.source === "manual_txn") return { category: claim.category, source: claim.source };
      if (claim?.source === "llm_full" || claim?.source === "llm_fallback") {
        // Structure and the owner's configuration still win over an LLM answer (Q5).
        return ownerDecision(row, ctx) ?? { category: claim.category, source: claim.source };
      }
      return categorize(row, keys);
    },
    detectRecurring: (rows, notSubscription, opts = {}) =>
      detectRecurringWith(rows.map(asRecurring), notSubscription, opts, categorize),
  };
}

/** `effectiveCategory` without a shared cache. */
export function effectiveCategory(
  row: CategorizeRow,
  ctx: EngineContext,
  subscriptionKeys: ReadonlySet<string>,
): Effective {
  return createCategorizer(ctx).effective(row, subscriptionKeys);
}

/**
 * The whole vault at once (parity, rebuild; `categorize_all(use_llm=False)`): the recurring payees
 * over the non-internal rows (in the given order, decided = claim), then the effective category of
 * every row. `notSubscription` = `NOT_SUBSCRIPTION_CATEGORIES` plus the modules' own.
 */
export function categorizeAll(
  rows: readonly CategorizeRow[],
  ctx: EngineContext,
  notSubscription: ReadonlySet<string>,
): {
  readonly results: ReadonlyMap<string, Effective>;
  readonly recurring: readonly RecurringCandidate[];
  readonly subscriptionPayees: ReadonlySet<string>;
} {
  const c = createCategorizer(ctx);
  const recurring = c.detectRecurring(
    rows.filter((r) => !r.isInternalTransfer),
    notSubscription,
  );
  const payees = subscriptionPayees(recurring);
  const results = new Map<string, Effective>();
  for (const row of rows) results.set(row.key, c.effective(row, payees));
  return { results, recurring, subscriptionPayees: payees };
}
