import { budget, core, D, loans } from "@cashu/domain";
import type { SqlDriver } from "../../sql/driver.js";

interface Account {
  readonly id: number;
  readonly iban: string | null;
  readonly type: string;
}

interface Transaction {
  readonly id: number;
  readonly account_id: number;
  readonly booking_date: string;
  readonly amount: string;
  readonly currency: string;
  readonly counterparty_name: string | null;
  readonly counterparty_iban: string | null;
  readonly description: string | null;
  readonly reference: string | null;
  readonly category: string | null;
  readonly category_source: string | null;
}

export interface DerivedTransaction {
  readonly category: string | null;
  readonly categorySource: string | null;
  readonly isInternalTransfer: boolean;
  readonly transferOutId: number | null;
}

class SourceDerivedError extends Error {
  constructor() {
    super("source_derived_mismatch");
    this.name = "SourceDerivedError";
  }
}

const CLAIM_SOURCES = new Set(["manual_txn", "llm_full", "llm_fallback", "cash_leg"]);

/**
 * Recompute D-24.1 from the frozen Python rows, without reading the exported log or replay view.
 * The transfer matcher accepts counterparty IBAN only, in Python numeric row order. Both net worth
 * and profile isolation rely on the account join and never on names or amount alone.
 */
export function sourceDerivedTransactions(
  driver: SqlDriver,
  profileId: number,
): ReadonlyMap<number, DerivedTransaction> {
  if (!Number.isSafeInteger(profileId) || profileId <= 0) throw new SourceDerivedError();
  const accounts = driver
    .prepare("SELECT id, iban, type FROM accounts WHERE profile_id=? ORDER BY id")
    .all<Account>(profileId);
  const rows = driver
    .prepare(
      "SELECT t.* FROM transactions t JOIN accounts a ON a.id=t.account_id WHERE a.profile_id=? ORDER BY t.id",
    )
    .all<Transaction>(profileId);
  const accountById = new Map(accounts.map((account) => [account.id, account]));
  const matchKeys = budget.transferAccountKeys(
    accounts.map((account) => ({ key: String(account.id), iban: account.iban })),
  );
  const pairs = budget.matchTransfers(
    rows.map((row) => ({
      key: String(row.id),
      account: String(row.account_id),
      bookingDate: row.booking_date,
      amount: D(row.amount),
      counterpartyIban: row.counterparty_iban,
    })),
    matchKeys,
  );
  const transferOut = new Map<number, number>();
  for (const pair of pairs) {
    const out = Number(pair.out);
    transferOut.set(out, out);
    transferOut.set(Number(pair.in), out);
  }
  const rules = driver
    .prepare(
      "SELECT merchant_key, category, source, locked FROM category_rules WHERE profile_id=? ORDER BY id",
    )
    .all<{ merchant_key: string; category: string; source: string; locked: number }>(profileId)
    .map((row) => ({
      merchantKey: row.merchant_key,
      category: row.category,
      source: row.source as budget.MerchantRule["source"],
      locked: row.locked === 1,
    }));
  const loanPatterns = loans.paymentPatterns(
    driver
      .prepare(
        "SELECT l.payment_iban, l.payment_text FROM loans l JOIN accounts a ON a.id=l.account_id WHERE a.profile_id=? ORDER BY l.id",
      )
      .all<{ payment_iban: string | null; payment_text: string | null }>(profileId)
      .map((row) => ({ paymentIban: row.payment_iban, paymentText: row.payment_text })),
  );
  const registry = core.builtinRegistry();
  const context: budget.EngineContext = {
    ownIbans: core.ownIbans(accounts),
    rules: budget.rulesByMerchant(rules),
    patterns: loanPatterns,
    moduleTextRules: core.textRules(registry),
  };
  const categoryRows: budget.CategorizeRow[] = rows.map((row) => {
    const account = accountById.get(row.account_id);
    if (!account) throw new SourceDerivedError();
    const claim =
      row.category !== null &&
      row.category_source !== null &&
      CLAIM_SOURCES.has(row.category_source)
        ? { category: row.category, source: row.category_source as budget.ClaimSource }
        : null;
    return {
      key: String(row.id),
      onCashAccount: account.type === budget.CASH_ACCOUNT_TYPE,
      bookingDate: row.booking_date,
      currency: row.currency,
      amount: D(row.amount),
      counterpartyName: row.counterparty_name,
      counterpartyIban: row.counterparty_iban,
      description: row.description,
      reference: row.reference,
      isInternalTransfer: transferOut.has(row.id),
      claim,
    };
  });
  const categories = budget.categorizeAll(
    categoryRows,
    context,
    budget.subscriptionExclusions(registry),
  );
  const out = new Map<number, DerivedTransaction>();
  for (const row of rows) {
    const category = categories.results.get(String(row.id)) ?? null;
    out.set(row.id, {
      category: category?.category ?? null,
      categorySource: category?.source ?? null,
      isInternalTransfer: transferOut.has(row.id),
      transferOutId: transferOut.get(row.id) ?? null,
    });
  }
  return out;
}
