/** Scenario rows of the S09 vectors (`all`, `llm`, `reclassify`) as domain inputs (tests only). */
import { builtinRegistry, notSubscriptionCategories } from "../../../core/index.js";
import { D } from "../../../decimal.js";
import type { CategorizeRow, ClaimSource } from "../effective.js";
import type { EngineContext } from "../engine.js";
import { NOT_SUBSCRIPTION_CATEGORIES, TXN_DECIDED_SOURCES } from "../recurring.js";
import { contextFrom, type PatternVector, type RuleVector } from "./engineRows.js";

/** `ROW_FIELDS` of the generator. */
export type ScenarioRow = [
  id: number,
  account: number,
  onCashAccount: boolean,
  bookingDate: string,
  amount: string,
  currency: string,
  counterpartyName: string | null,
  counterpartyIban: string | null,
  reference: string | null,
  description: string | null,
  isInternalTransfer: boolean,
  category: string | null,
  source: string | null,
];

export interface ScenarioContext {
  readonly accountIbans: (string | null)[];
  readonly ownIbans: string[];
  readonly rules: RuleVector[];
  readonly patterns: PatternVector[];
}

export const NOT_SUBSCRIPTION: ReadonlySet<string> = new Set([
  ...NOT_SUBSCRIPTION_CATEGORIES,
  ...notSubscriptionCategories(builtinRegistry()),
]);

export function scenarioContext(c: ScenarioContext): EngineContext {
  return contextFrom(c.accountIbans, c.rules, c.patterns);
}

/** Claims as the genesis takes them from stored rows: a decided source with a category (S26). */
export function categorizeRow(r: ScenarioRow): CategorizeRow {
  const [
    id,
    ,
    onCashAccount,
    bookingDate,
    amount,
    currency,
    name,
    iban,
    reference,
    description,
    internal,
    cat,
    src,
  ] = r;
  const claim =
    src !== null && cat !== null && TXN_DECIDED_SOURCES.has(src)
      ? { category: cat, source: src as ClaimSource }
      : null;
  return {
    key: String(id),
    onCashAccount,
    bookingDate,
    amount: D(amount),
    currency,
    counterpartyName: name,
    counterpartyIban: iban,
    reference,
    description,
    isInternalTransfer: internal,
    claim,
  };
}

/** Rows in Python's query order: the given ids first (in that order), then the rest by id. */
export function inQueryOrder<T extends { readonly key: string }>(
  rows: readonly T[],
  order: readonly number[],
): T[] {
  const byKey = new Map(rows.map((r) => [r.key, r]));
  const seen = new Set<string>();
  const out: T[] = [];
  for (const id of order) {
    const r = byKey.get(String(id));
    if (r !== undefined) {
      out.push(r);
      seen.add(r.key);
    }
  }
  for (const r of rows) if (!seen.has(r.key)) out.push(r);
  return out;
}
