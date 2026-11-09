// Budget reads for the overview and the blank page: the cash pool's net-worth source (Python
// `budget/networth.py`), the vault's `BudgetBook` and categorization context (the analytics' input:
// cashflow, recurring payments) and the setup facts (`budget/setup.py`).
import { budget, core, D, type IsoDate } from "@cashu/domain";
import type { PaymentPattern } from "@cashu/domain/core";
import { MANUAL_INSTITUTION } from "@cashu/domain/core";
import { netWorthBalances } from "../core/networth.js";
import { profileOf } from "../core/queries.js";
import type { Read } from "../query.js";
import type { NetWorthSource, SetupSource } from "../registry.js";

/**
 * The cash pool valued by its running transaction sum (`CashContributor`) and the bank accounts by
 * their balance snapshots, walked back over their transactions before the first one
 * (`budgetContributor`).
 */
export const budgetNetWorth: NetWorthSource = (read) =>
  budget.budgetContributor(
    read<{ account: string; bookingDate: IsoDate; amount: string }>(
      `SELECT a.gid AS account, t.booking_date AS bookingDate, t.amount
       FROM transactions t JOIN accounts a ON a.id = t.account_id
       WHERE a.type IN (?, ?, ?, ?) ORDER BY t.id`,
      budget.CASH_ACCOUNT_TYPE,
      ...budget.BANK_BALANCE_TYPES,
    ).map((t) => ({ account: t.account, bookingDate: t.bookingDate, amount: D(t.amount) })),
    netWorthBalances(read),
  );

interface AccountRow {
  readonly gid: string;
  readonly name: string;
  readonly iban: string | null;
  readonly type: string;
  readonly currency: string;
  readonly active: number;
  readonly removedAt: string | null;
}

interface TxnRow {
  readonly gid: string;
  readonly account: string;
  readonly bookingDate: IsoDate;
  readonly amount: string;
  readonly currency: string;
  readonly counterpartyName: string | null;
  readonly counterpartyIban: string | null;
  readonly description: string | null;
  readonly reference: string | null;
  readonly bankTransactionId: string | null;
  readonly category: string | null;
  readonly categorySource: string | null;
  readonly internal: number;
  readonly transferGroup: string | null;
  readonly dedupHash: string;
}

const CASHLEG = "cashleg:";

/**
 * The vault's `BudgetBook`: every account (removed ones too, so their IBANs stay own IBANs) in fold
 * order and the transactions of the accounts that are not removed, by account, then in the order the
 * view first recorded it (Python's id order: only ties of equal sort keys in the analytics depend on
 * it). A removed account's history leaves the budget (spending, income, cash flow, recurring
 * payments, uncategorized merchants) and comes back with `account.restored`; the live side of a
 * transfer with it stays an own transfer (pair flag or own counterparty IBAN). A cash leg names the
 * bank row it mirrors.
 */
export function budgetBook(read: Read): budget.BudgetBook {
  const accounts = read<AccountRow>(
    `SELECT gid, name, iban, type, currency, active, removed_at AS removedAt FROM accounts
     ORDER BY id`,
  );
  const order = new Map(accounts.map((a, i) => [a.gid, i]));
  const rows = read<TxnRow>(
    `SELECT t.gid, a.gid AS account, t.booking_date AS bookingDate, t.amount, t.currency,
       t.counterparty_name AS counterpartyName, t.counterparty_iban AS counterpartyIban,
       t.description, t.reference, t.bank_transaction_id AS bankTransactionId, t.category,
       t.category_source AS categorySource, t.is_internal_transfer AS internal,
       t.transfer_group_id AS transferGroup, t.dedup_hash AS dedupHash
     FROM transactions t JOIN accounts a ON a.id = t.account_id
     WHERE a.removed_at IS NULL ORDER BY t.id`,
  );
  rows.sort((x, y) => (order.get(x.account) ?? 0) - (order.get(y.account) ?? 0));
  const profile = profileOf(read);
  return {
    baseCurrency: budget.budgetBaseCurrency(profile?.baseCurrency),
    accounts: accounts.map((a) => ({
      id: a.gid,
      name: a.name,
      iban: a.iban,
      type: a.type,
      currency: a.currency,
      active: a.active === 1,
      removedAt: a.removedAt,
    })),
    transactions: rows.map((t) => ({
      key: t.gid,
      account: t.account,
      bookingDate: t.bookingDate,
      amount: D(t.amount),
      currency: t.currency,
      counterpartyName: t.counterpartyName,
      counterpartyIban: t.counterpartyIban,
      description: t.description,
      reference: t.reference,
      bankTransactionId: t.bankTransactionId,
      category: t.category,
      categorySource: t.categorySource,
      isInternalTransfer: t.internal === 1,
      transferGroup: t.transferGroup,
      cashLegOf: t.dedupHash.startsWith(CASHLEG) ? t.dedupHash.slice(CASHLEG.length) : null,
    })),
  };
}

/**
 * The categorization context of the vault (`EngineContext`): own IBAN keys of every account, the
 * merchant rules and the module payment patterns the caller collected (`ModuleContributions`).
 * Own IBANs are Python's `own_ibans` (D-08.1): `iban_key` of the raw stored IBAN of every account,
 * removed ones too, with no checksum (the identity `iban_key` column stays valid-only; matching never
 * fuses accounts, and the signal is still the counterparty IBAN only, rule 5).
 */
export function budgetEngineContext(
  read: Read,
  patterns: readonly PaymentPattern[],
  registry: core.CoreRegistry = core.builtinRegistry(),
): budget.EngineContext {
  const rules = read<{ merchantKey: string; category: string; source: string; locked: number }>(
    "SELECT merchant_key AS merchantKey, category, source, locked FROM category_rules ORDER BY id",
  ).map((r) => ({
    merchantKey: r.merchantKey,
    category: r.category,
    source: r.source as budget.MerchantRule["source"],
    locked: r.locked === 1,
  }));
  return {
    ownIbans: core.ownIbans(read<{ iban: string | null }>("SELECT iban FROM accounts")),
    rules: budget.rulesByMerchant(rules),
    patterns,
    moduleTextRules: core.textRules(registry),
  };
}

const count = (read: Read, sql: string, ...params: string[]): number =>
  read<{ n: number }>(sql, ...params)[0]?.n ?? 0;

const BANK_TXNS = "FROM transactions t JOIN accounts a ON a.id = t.account_id WHERE a.bank != ?";

/**
 * The counts behind the budget steps (Python `setup_status`): bank accounts are those of an
 * institution other than the manual one, removed ones included. Uncategorized = outflows whose
 * derived source is `default` (the engine could not decide).
 */
function budgetSetupFacts(read: Read): budget.BudgetSetupFacts {
  const m = MANUAL_INSTITUTION;
  return {
    bankAccounts: count(read, "SELECT count(*) AS n FROM accounts WHERE bank != ?", m),
    transactions: count(read, `SELECT count(*) AS n ${BANK_TXNS}`, m),
    // A removed account's rows are out of the budget, so they need no category.
    uncategorized: count(
      read,
      `SELECT count(*) AS n ${BANK_TXNS} AND CAST(t.amount AS REAL) < 0
       AND t.category_source = 'default' AND a.removed_at IS NULL`,
      m,
    ),
    manualDecisions:
      count(read, "SELECT count(*) AS n FROM category_rules WHERE source = 'manual'") +
      count(read, `SELECT count(*) AS n ${BANK_TXNS} AND t.category_source = 'manual_txn'`, m),
    internalTransfers: count(
      read,
      `SELECT count(*) AS n ${BANK_TXNS} AND t.is_internal_transfer = 1`,
      m,
    ),
    ownMoves: count(read, `SELECT count(*) AS n ${BANK_TXNS} AND t.category = 'transfer'`, m),
  };
}

export const budgetSetup: SetupSource = (read, ctx) =>
  budget.budgetSetupSteps(budgetSetupFacts(read), ctx);
