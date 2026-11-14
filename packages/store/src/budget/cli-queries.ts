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
/** The pool's rows in one other currency: their own balance, never added to the pool's. */
export interface CashCliPart {
  /** `budget.netWorthLineMeta` name: the pool's name plus the currency code, as net worth shows it. */
  readonly name: string;
  readonly currency: string;
  readonly balance: Decimal;
}
export interface CashCliSnapshot {
  readonly currency: string;
  /** Sum of the pool's rows in its own currency only (data-safety rule 5, `budget.cashContributor`). */
  readonly balance: Decimal;
  /** The pool's parts in other currencies, by currency code; empty for a single-currency pool. */
  readonly parts: readonly CashCliPart[];
  readonly rows: readonly CashCliRow[];
}

/** Python `get_cash_account(create=False)` with stable native row ordering. */
export function cashCliSnapshot(
  read: Read,
  requestedCurrency: string | null,
): CashCliSnapshot | null | undefined {
  const currency =
    requestedCurrency === null
      ? budget.budgetBaseCurrency(profileOf(read)?.baseCurrency)
      : pyUpper(requestedCurrency);
  const account = read<{ id: number; gid: string; name: string; currency: string }>(
    `SELECT id, gid, name, currency FROM accounts WHERE bank = ? AND external_id = ? ORDER BY id LIMIT 1`,
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
     FROM transactions WHERE account_id = ?
     ORDER BY booking_date DESC, created_at DESC, gid DESC, dedup_hash DESC, occurrence DESC`,
    account.id,
  );
  // Event-backed timestamps and keys keep same-day ties stable across independent folds.
  // Their order may differ from old Python ids after genesis; no legacy id is reconstructed.
  // Per currency, as net worth counts a pool: a row in another currency is a separate part.
  const sums = new Map<string, Decimal>([[account.currency, D("0")]]);
  for (const t of transactions)
    sums.set(t.currency, (sums.get(t.currency) ?? D("0")).add(D(t.amount)));
  const pool = { name: account.name };
  const parts = [...sums.entries()]
    .filter(([cur]) => cur !== account.currency)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([cur, partBalance]) => {
      const meta = budget.netWorthLineMeta(budget.cashPoolPartId(account.gid, cur), (gid) =>
        gid === account.gid ? pool : undefined,
      );
      return { name: meta?.name ?? account.name, currency: cur, balance: partBalance };
    });
  return {
    currency: account.currency,
    balance: sums.get(account.currency) ?? D("0"),
    parts,
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
