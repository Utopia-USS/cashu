/**
 * Loans' net-worth contributor (`modules/loans/networth.py`): a loan account is worth what is still
 * owed (the amortization schedule, anchored on balances recorded after the terms; `valuation.ts`).
 *
 * Python reads the loans and balances through the session; here the caller (the store, a parity
 * producer) hands over the profile's loan terms and each loan account's balance rows.
 */

import type { NetWorthAccount, NetWorthContributor, Valuation } from "../core/index.js";
import { isLoanAccount } from "./service.js";
import { type LoanTerms, loanValuation, type RecordedBalance } from "./valuation.js";

/** One profile's loans rows. */
export interface LoansBook {
  /** The profile's loan terms (any account; at most one per account), in storage order. */
  readonly loans: readonly LoanTerms[];
  /** Balance rows per account id (with the moment each was recorded), each list in storage order. */
  readonly balances: ReadonlyMap<string, readonly RecordedBalance[]>;
}

/**
 * `LoansContributor`. Terms are only honoured on mortgage / loan accounts: rows left on another type
 * (written before add_loan / set_loan checked it) must not replace that account's value.
 */
export function loansContributor(book: LoansBook): NetWorthContributor {
  return {
    valuations(accounts: ReadonlyMap<string, NetWorthAccount>): ReadonlyMap<string, Valuation> {
      const out = new Map<string, Valuation>();
      for (const loan of book.loans) {
        const account = accounts.get(loan.accountId);
        if (account === undefined || !isLoanAccount(account)) continue;
        out.set(loan.accountId, loanValuation(loan, book.balances.get(loan.accountId) ?? []));
      }
      return out;
    },
  };
}
