// The cash wallet of one vault (`@cashu/store/overview/cash`): the cash pool of a currency, its native
// rows and balance. Its own entry so the phone, whose bundler (Metro) does not tree-shake, reads it
// without the overview barrel; `widgets.ts` re-exports it for the desktop overview.
import { budget, D, type Decimal, type IsoDate } from "@cashu/domain";
import { profileOf } from "../core/queries.js";
import { defineQuery, type Read } from "../query.js";

export interface CashWalletRow {
  readonly gid: string;
  readonly date: IsoDate;
  readonly amount: Decimal;
  readonly title: string | null;
  readonly category: string | null;
  readonly kind: "withdrawal" | "expense";
}

export interface CashWalletView {
  readonly exists: boolean;
  readonly currency: string;
  readonly balance: Decimal;
  readonly withdrawals: Decimal;
  readonly expenses: Decimal;
  readonly transactions: readonly CashWalletRow[];
}

/**
 * The cash drawer's own native rows, newest first; actions address their opaque gids. Direct SQL over
 * the cash pool account of the currency (the base currency by default), never the whole book.
 */
export function cashWallet(read: Read, currency?: string | null): CashWalletView {
  const selected = currency || budget.budgetBaseCurrency(profileOf(read)?.baseCurrency);
  const account = read<{ id: number }>(
    `SELECT id FROM accounts WHERE type = ? AND currency = ? AND removed_at IS NULL
     ORDER BY id LIMIT 1`,
    budget.CASH_ACCOUNT_TYPE,
    selected,
  )[0];
  const rows =
    account === undefined
      ? []
      : read<{
          gid: string;
          date: IsoDate;
          amount: string;
          reference: string | null;
          description: string | null;
          name: string | null;
          category: string | null;
        }>(
          `SELECT gid, booking_date AS date, amount, reference, description,
             counterparty_name AS name, category
           FROM transactions WHERE account_id = ? ORDER BY booking_date DESC, id DESC`,
          account.id,
        ).map((row): CashWalletRow => {
          const amount = D(row.amount);
          return {
            gid: row.gid,
            date: row.date,
            amount,
            title: row.reference || row.description || row.name,
            category: row.category,
            kind: amount.gt(D("0")) ? "withdrawal" : "expense",
          };
        });
  let balance = D("0");
  let withdrawals = D("0");
  let expenses = D("0");
  for (const row of rows) {
    balance = balance.add(row.amount);
    if (row.amount.gt(D("0"))) withdrawals = withdrawals.add(row.amount);
    else if (row.amount.lt(D("0"))) expenses = expenses.sub(row.amount);
  }
  return {
    exists: account !== undefined,
    currency: selected,
    balance,
    withdrawals,
    expenses,
    transactions: rows,
  };
}

export const overviewCashWallet = defineQuery({
  id: "core.overviewCashWallet",
  run: (read, args: { readonly currency?: string | null }) => cashWallet(read, args.currency),
});
