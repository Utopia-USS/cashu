// The effective-category oracle of the store tests (S24c, D-24.1): the S09 domain recompute
// (`budget.categorizeAll`) over a plain read of the view, written independently of the
// `budget.categories` deriver (its own SQL, context and claim mapping), compared with the view's
// derived columns. Synthetic data only.
import { budget, core, D } from "@cashu/domain";
import { expect } from "vitest";
import type { Store } from "../materialize.js";
import { vaultPaymentPatterns } from "../overview/index.js";

const NOT_SUBSCRIPTION: ReadonlySet<string> = new Set([
  ...budget.NOT_SUBSCRIPTION_CATEGORIES,
  ...core.notSubscriptionCategories(core.builtinRegistry()),
]);
const BANK_CLAIMS: ReadonlySet<string> = new Set(["manual_txn", "llm_full", "llm_fallback"]);

interface ViewRow {
  gid: string;
  account: string;
  dedup_hash: string;
  occurrence: number;
  booking_date: string;
  amount: string;
  currency: string;
  counterparty_name: string | null;
  counterparty_iban: string | null;
  description: string | null;
  reference: string | null;
  is_internal_transfer: number;
  category: string | null;
  category_source: string | null;
}

/** Row gid -> `[category, category_source]` the recompute gives, and what the view shows. */
function categoryOracle(store: Store): {
  expected: Map<string, [string | null, string | null]>;
  actual: Map<string, [string | null, string | null]>;
} {
  const read = store.read.bind(store);
  const accounts = read<{ gid: string; iban: string | null; type: string }>(
    "SELECT gid, iban, type FROM accounts",
  );
  const cash = new Set(accounts.filter((a) => a.type === "cash").map((a) => a.gid));
  const claims = new Map(
    read<{ partition: string; claim: string | null; claim_by: string | null }>(
      "SELECT partition, claim, claim_by FROM fold_transaction_claims",
    ).map((c) => [c.partition, c]),
  );
  const rules = read<{ merchant_key: string; category: string; source: string; locked: number }>(
    "SELECT merchant_key, category, source, locked FROM category_rules",
  );
  const rows = read<ViewRow>(
    `SELECT t.gid, v.gid AS account, t.dedup_hash, t.occurrence, t.booking_date, t.amount,
       t.currency, t.counterparty_name, t.counterparty_iban, t.description, t.reference,
       t.is_internal_transfer, t.category, t.category_source
     FROM transactions t JOIN view_ids v ON v.id = t.account_id
     WHERE t.dedup_hash NOT LIKE 'cashleg:%'`,
  );
  const ctx: budget.EngineContext = {
    ownIbans: core.ownIbans(accounts),
    rules: budget.rulesByMerchant(
      rules.map((r) => ({
        merchantKey: r.merchant_key,
        category: r.category,
        source: r.source as budget.RuleSource,
        locked: r.locked === 1,
      })),
    ),
    patterns: vaultPaymentPatterns(read),
    moduleTextRules: core.textRules(core.builtinRegistry()),
  };
  const input: budget.CategorizeRow[] = rows.map((r) => {
    const partition = r.dedup_hash.startsWith("cashexp:")
      ? r.dedup_hash
      : `${r.account}|${r.dedup_hash}|${r.occurrence}`;
    const c = claims.get(partition);
    return {
      key: r.gid,
      onCashAccount: cash.has(r.account),
      bookingDate: r.booking_date,
      currency: r.currency,
      amount: D(r.amount),
      counterpartyName: r.counterparty_name,
      counterpartyIban: r.counterparty_iban,
      description: r.description,
      reference: r.reference,
      isInternalTransfer: r.is_internal_transfer === 1,
      claim:
        c?.claim != null && c.claim_by != null && BANK_CLAIMS.has(c.claim_by)
          ? { category: c.claim, source: c.claim_by as budget.ClaimSource }
          : null,
    };
  });
  const { results } = budget.categorizeAll(input, ctx, NOT_SUBSCRIPTION);
  const expected = new Map<string, [string | null, string | null]>();
  for (const [gid, e] of results) expected.set(gid, [e?.category ?? null, e?.source ?? null]);
  const actual = new Map<string, [string | null, string | null]>(
    rows.map((r) => [r.gid, [r.category, r.category_source]]),
  );
  return { expected, actual };
}

/** The view's effective categories equal the domain recompute. */
export function expectCategoriesRecomputed(store: Store): void {
  const { expected, actual } = categoryOracle(store);
  expect(actual).toEqual(expected);
}
