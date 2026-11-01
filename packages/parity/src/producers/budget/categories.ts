/**
 * Producer of `budget.categories` (`parity/python/checks/budget_derived.py:categories`): per profile
 * with the budget module, the deterministic categorization (`budget.categorizeAll`, the D-24.1
 * recompute) over every stored row after a fresh transfer match (`budget.matchTransfers`, S08).
 *
 * Inputs: every account of the profile, removed ones too (`core.ownIbans`, D-08.1, and the transfer
 * keys); the profile's merchant rules and loan payment patterns; claims taken from the stored rows as
 * the genesis takes them (S26 4.2): a bank row's `manual_txn` / `llm_full` / `llm_fallback` category, a
 * cash-account row's decided category (D-09.4: an undecided cash row gets no category). The recurring
 * list runs over the non-internal rows in the reader's `(account_id, id)` order (Q21).
 */

import { budget, core, D } from "@cashu/domain";
import type { PythonDb } from "../../sources/index.ts";
import type { OutValue } from "../output.ts";

type Row = ReturnType<PythonDb["transactions"]>[number];

const BANK_CLAIMS: ReadonlySet<string> = new Set(["manual_txn", "llm_full", "llm_fallback"]);
const NOT_SUBSCRIPTION: ReadonlySet<string> = new Set([
  ...budget.NOT_SUBSCRIPTION_CATEGORIES,
  ...core.notSubscriptionCategories(core.builtinRegistry()),
]);
const MODULE_TEXT_RULES = core.textRules(core.builtinRegistry());

function claimOf(r: Row, onCash: boolean): budget.CategoryClaimValue | null {
  const { category, categorySource: source } = r;
  if (!category || source === null) return null;
  const decided = onCash ? budget.TXN_DECIDED_SOURCES.has(source) : BANK_CLAIMS.has(source);
  return decided ? { category, source: source as budget.ClaimSource } : null;
}

/** Python `sorted` of str (code point order). */
const sortedPy = (xs: Iterable<string>): string[] => [...xs].sort(budget.codePointCompare);

function profileOut(db: PythonDb, profileId: number): OutValue {
  const accounts = db.accounts(profileId, { includeRemoved: true });
  const cashIds = new Set(
    accounts.filter((a) => a.type === budget.CASH_ACCOUNT_TYPE).map((a) => a.id),
  );
  const rows = db.transactions(profileId); // (account_id, id): Python's detect_recurring order (Q21)
  const pairs = budget.matchTransfers(
    [...rows]
      .sort((a, b) => a.id - b.id)
      .map((r) => ({
        key: String(r.id),
        account: String(r.accountId),
        bookingDate: r.bookingDate,
        amount: D(r.amount),
        counterpartyIban: r.counterpartyIban,
      })),
    budget.transferAccountKeys(accounts.map((a) => ({ key: String(a.id), iban: a.iban }))),
  );
  const internal = new Set(pairs.flatMap((p) => [p.out, p.in]));
  const ctx: budget.EngineContext = {
    ownIbans: core.ownIbans(accounts),
    rules: budget.rulesByMerchant(
      db.categoryRules(profileId).map((r) => ({ ...r, source: r.source as budget.RuleSource })),
    ),
    patterns: db.loanPaymentPatterns(profileId),
    moduleTextRules: MODULE_TEXT_RULES,
  };
  const input: budget.CategorizeRow[] = rows.map((r) => {
    const onCash = cashIds.has(r.accountId);
    return {
      key: String(r.id),
      onCashAccount: onCash,
      bookingDate: r.bookingDate,
      currency: r.currency,
      amount: D(r.amount),
      counterpartyName: r.counterpartyName,
      counterpartyIban: r.counterpartyIban,
      reference: r.reference,
      description: r.description,
      isInternalTransfer: internal.has(String(r.id)),
      claim: claimOf(r, onCash),
    };
  });
  const { results, recurring, subscriptionPayees } = budget.categorizeAll(
    input,
    ctx,
    NOT_SUBSCRIPTION,
  );
  const byId = [...rows].sort((a, b) => a.id - b.id);
  const drift: Record<string, { changed: bigint; same: bigint }> = {};
  const out = byId.map((r) => {
    const e = results.get(String(r.id)) ?? null;
    const category = e?.category ?? null;
    const source = e?.source ?? null;
    const kind = r.categorySource ?? "null";
    const d = drift[kind] ?? { changed: 0n, same: 0n };
    drift[kind] = d;
    if (r.category === category && r.categorySource === source) d.same++;
    else d.changed++;
    return { txn: db.keys.key("transactions", r.id), category, category_source: source };
  });
  return {
    rows: out,
    subscription_payees: sortedPy(subscriptionPayees),
    recurring: recurring.map((c) => ({
      counterparty: c.counterparty,
      typical_amount: c.typicalAmount.toString(),
      occurrences: BigInt(c.occurrences),
      months_covered: BigInt(c.monthsCovered),
      median_gap_days: BigInt(c.medianGapDays),
      last_date: c.lastDate,
      currency: c.currency,
    })),
    drift,
    cash_unclaimed: BigInt(input.filter((r) => r.onCashAccount && r.claim === null).length),
  };
}

export function produceBudgetCategories(db: PythonDb): OutValue {
  const out: Record<string, OutValue> = {};
  for (const p of db.profiles()) {
    if (!db.enabledModules(p.id).includes("budget")) continue;
    out[db.keys.key("profiles", p.id)] = profileOut(db, p.id);
  }
  return out;
}
