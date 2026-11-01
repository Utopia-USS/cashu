/**
 * One profile's `budget.BudgetBook` from the read-only source: every account (removed ones too, id
 * order) and every transaction of the profile's accounts in `(account_id, id)` order (Python's SQLite
 * plan for `queries.transactions`), keyed by the goldens' natural keys.
 */

import { budget, D } from "@cashu/domain";
import type { PythonDb } from "../../sources/index.ts";

const LEG_ID = /^cashleg:(\d+)$/;

export function budgetBook(
  db: PythonDb,
  profileId: number,
  baseCurrency: string | null,
): budget.BudgetBook {
  const accountKey = (id: number) => db.keys.key("accounts", id);
  const txnKey = (id: number) => db.keys.key("transactions", id);
  const accounts: budget.BudgetAccount[] = db
    .accounts(profileId, { includeRemoved: true })
    .map((a) => ({
      id: accountKey(a.id),
      name: a.name,
      iban: a.iban,
      type: a.type,
      currency: a.currency,
      active: a.active,
      removedAt: a.removedAt,
    }));
  const transactions: budget.BudgetTxn[] = db.transactions(profileId).map((t) => {
    const leg = LEG_ID.exec(t.dedupHash);
    return {
      key: txnKey(t.id),
      account: accountKey(t.accountId),
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
      isInternalTransfer: t.isInternalTransfer,
      transferGroup: t.transferGroupId,
      cashLegOf: leg === null ? null : txnKey(Number(leg[1])),
    };
  });
  return { baseCurrency: budget.budgetBaseCurrency(baseCurrency), accounts, transactions };
}
