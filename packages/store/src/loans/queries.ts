// Typed reads of the loans view the commands need.
import type { Read } from "../core/queries.js";

export interface LoanView {
  readonly gid: string;
  readonly paymentIban: string | null;
  readonly paymentText: string | null;
}

/** The loan of account `account` (a visible loan row: its terms exist). */
export function loanOfAccount(read: Read, account: string): LoanView | undefined {
  return read<LoanView>(
    `SELECT l.gid, l.payment_iban AS paymentIban, l.payment_text AS paymentText
     FROM loans l JOIN accounts a ON a.id = l.account_id WHERE a.gid = ?`,
    account,
  )[0];
}
