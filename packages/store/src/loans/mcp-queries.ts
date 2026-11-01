// Loan summaries use the same recorded-balance valuation input as the overview.
import type { loans } from "@cashu/domain";
import type { Read } from "../query.js";
import { loanTerms, recordedBalances } from "./read-models.js";

export interface McpLoanAccount {
  /** Local view ID, used only to select the generated account label. */
  readonly id: number;
  readonly gid: string;
  readonly name: string;
  readonly type: string;
  readonly currency: string;
}
export interface McpLoanRow {
  readonly loan: loans.LoanTerms;
  readonly account: McpLoanAccount;
  readonly balances: readonly loans.RecordedBalance[];
}
/** Python list_loans: oldest loan first, removed accounts excluded, inactive ones retained. */
export function mcpLoanRows(read: Read): McpLoanRow[] {
  const accounts = new Map(
    read<McpLoanAccount>(
      "SELECT id, gid, name, type, currency FROM accounts WHERE removed_at IS NULL",
    ).map((account) => [account.gid, account]),
  );
  const balances = recordedBalances(read);
  return loanTerms(read).flatMap((loan) => {
    const account = accounts.get(loan.accountId);
    return account === undefined
      ? []
      : [{ loan, account, balances: balances.get(account.gid) ?? [] }];
  });
}
