// CLI-only cash projection. The vault is already profile scoped; SQL ids remain private ordering keys.
import { budget, core, D, type Decimal, type IsoDate } from "@cashu/domain";
import { MANUAL_INSTITUTION } from "@cashu/domain/core";
import { pyUpper } from "@cashu/domain/text";
import { profileOf } from "../core/queries.js";
import type { Read } from "../query.js";

export interface CashCliRow {
  readonly bookingDate: string;
  readonly reference: string | null;
  readonly description: string | null;
  readonly category: string | null;
  readonly amount: Decimal;
  readonly currency: string;
}
export interface CashCliSnapshot {
  readonly currency: string;
  readonly balance: Decimal;
  readonly rows: readonly CashCliRow[];
}

/** Python `get_cash_account(create=False)` plus unambiguous date ordering. */
export function cashCliSnapshot(
  read: Read,
  requestedCurrency: string | null,
): CashCliSnapshot | null | undefined {
  const currency =
    requestedCurrency === null
      ? budget.budgetBaseCurrency(profileOf(read)?.baseCurrency)
      : pyUpper(requestedCurrency);
  const account = read<{ id: number; currency: string }>(
    `SELECT id, currency FROM accounts WHERE bank = ? AND external_id = ? ORDER BY id LIMIT 1`,
    MANUAL_INSTITUTION,
    `cash:${currency}`,
  )[0];
  if (!account) return null;
  const transactions = read<{
    bookingDate: string;
    reference: string | null;
    description: string | null;
    category: string | null;
    amount: string;
    currency: string;
  }>(
    `SELECT booking_date AS bookingDate, reference, description, category, amount, currency
     FROM transactions WHERE account_id = ? ORDER BY booking_date DESC, id DESC`,
    account.id,
  );
  // A local ViewId is assigned on fold, not the legacy Python row id. Check the displayed first
  // 40 rows and row 41, whose tie with row 40 could change which row reaches the cutoff.
  if (
    transactions
      .slice(0, 41)
      .some((txn, i) => i > 0 && txn.bookingDate === transactions[i - 1]?.bookingDate)
  )
    return undefined;
  let balance = D("0");
  for (const t of transactions) balance = balance.add(D(t.amount));
  return {
    currency: account.currency,
    balance,
    rows: transactions.slice(0, 40).map((t) => ({ ...t, amount: D(t.amount) })),
  };
}

/** Project the one cushion settings row without exposing local account ids as Python ids. */
export function budgetCliSettings(read: Read): budget.BudgetSettings | null {
  const rows = read<{
    enabled: number;
    currency: string | null;
    targetAmount: string | null;
    targetMonths: number | null;
    accounts: string;
    monthlyMax: string | null;
  }>(`SELECT enabled, currency, target_amount AS targetAmount,
      target_months AS targetMonths, accounts, monthly_max AS monthlyMax
      FROM budget_settings ORDER BY id`);
  if (rows.length === 0) return budget.defaultBudgetSettings();
  if (rows.length !== 1) return null;
  const row = rows[0];
  if (!row) return null;
  try {
    const accounts: unknown = JSON.parse(row.accounts);
    if (!Array.isArray(accounts) || !accounts.every((x) => typeof x === "string")) return null;
    return {
      cushion: {
        enabled: row.enabled === 1,
        currency: row.currency,
        targetAmount: row.targetAmount === null ? null : D(row.targetAmount),
        targetMonths: row.targetMonths,
        accountIds: accounts,
        monthlyMax: row.monthlyMax === null ? null : D(row.monthlyMax),
      },
    };
  } catch {
    return null;
  }
}

/** Balance snapshots and account type policy used by `monthClose` cushion calculations. */
export function budgetCliCushionEnv(read: Read): budget.CushionEnv {
  return {
    types: core.builtinRegistry().accountTypes,
    latestAt(asOf) {
      const latest = new Map<string, readonly [IsoDate, Decimal]>();
      for (const row of read<{ gid: string; date: IsoDate; amount: string }>(
        `SELECT a.gid, b.date, b.amount FROM balances b
         JOIN accounts a ON a.id = b.account_id
         WHERE b.date <= ? ORDER BY b.date, b.id`,
        asOf,
      ))
        latest.set(row.gid, [row.date, D(row.amount)]);
      return latest;
    },
  };
}
