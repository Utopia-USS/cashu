// Loans reads for the overview and the blank page: the loans' net-worth source (Python
// `loans/networth.py`: outstanding by the amortization schedule, anchored on balances the bank
// reported after the terms) and the setup facts (`loans/setup.py`).
import { D, type IsoDate, loans } from "@cashu/domain";
import { LOANS_CATEGORY } from "@cashu/domain/core";
import { enabledModuleIds } from "../core/queries.js";
import type { Read } from "../query.js";
import type { NetWorthSource, SetupSource } from "../registry.js";

interface LoanRow {
  readonly gid: string;
  readonly account: string;
  readonly principal: string;
  readonly annualRate: string;
  readonly termMonths: number;
  readonly startDate: IsoDate;
  readonly originationDate: IsoDate | null;
  readonly updatedAt: string;
  readonly paymentIban: string | null;
  readonly paymentText: string | null;
}

/** The vault's loan terms (a loan row is visible once its terms exist), oldest first. */
export function loanTerms(read: Read): loans.LoanTerms[] {
  return read<LoanRow>(
    `SELECT l.gid, a.gid AS account, l.principal, l.annual_rate AS annualRate,
       l.term_months AS termMonths, l.start_date AS startDate,
       l.origination_date AS originationDate, l.updated_at AS updatedAt,
       l.payment_iban AS paymentIban, l.payment_text AS paymentText
     FROM loans l JOIN accounts a ON a.id = l.account_id ORDER BY l.id`,
  ).map((l) => ({
    id: l.gid,
    accountId: l.account,
    principal: D(l.principal),
    annualRate: D(l.annualRate),
    termMonths: l.termMonths,
    startDate: l.startDate,
    originationDate: l.originationDate,
    updatedAt: l.updatedAt,
    paymentIban: l.paymentIban,
    paymentText: l.paymentText,
  }));
}

/** Balance rows of the loan accounts with the moment each figure was recorded, in id order. */
export function recordedBalances(read: Read): Map<string, loans.RecordedBalance[]> {
  const out = new Map<string, loans.RecordedBalance[]>();
  for (const b of read<{ gid: string; date: IsoDate; amount: string; recordedAt: string }>(
    `SELECT a.gid, b.date, b.amount, b.created_at AS recordedAt
     FROM balances b JOIN accounts a ON a.id = b.account_id
     WHERE a.id IN (SELECT account_id FROM loans) ORDER BY b.id`,
  )) {
    const row = { date: b.date, amount: D(b.amount), recordedAt: b.recordedAt };
    const list = out.get(b.gid);
    if (list === undefined) out.set(b.gid, [row]);
    else list.push(row);
  }
  return out;
}

export const loansNetWorth: NetWorthSource = (read) =>
  loans.loansContributor({ loans: loanTerms(read), balances: recordedBalances(read) });

/** The facts behind the loans steps (Python `setup_status`). */
function loansSetupFacts(read: Read): loans.LoansSetupFacts {
  const terms = loanTerms(read);
  return {
    loans: terms.length,
    paymentMatching: terms.some((l) => !!l.paymentIban || !!l.paymentText),
    budgetEnabled: enabledModuleIds(read).has("budget"),
    categorizedInstallments:
      read<{ one: number }>(
        "SELECT 1 AS one FROM transactions WHERE category = ? LIMIT 1",
        LOANS_CATEGORY,
      ).length > 0,
  };
}

export const loansSetup: SetupSource = (read, ctx) =>
  loans.loansSetupSteps(loansSetupFacts(read), ctx);
