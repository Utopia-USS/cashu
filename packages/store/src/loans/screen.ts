/** Full local loan summaries, without exposing stored lender account numbers. */
import { D, type IsoDate, ibanKey, loans, normalizeText, ZERO } from "@cashu/domain";
import { enabledModuleIds, profileOf } from "../core/queries.js";
import { calendarDate } from "../events/v1/primitives.js";
import { defineQuery, type Read } from "../query.js";
import { mcpLoanRows } from "./mcp-queries.js";

export { createUiLoan, setUiLoanPayment } from "./ui-commands.js";

/** The columns of a `loans` row the installment predicate reads. */
interface InstallmentRow {
  readonly amount: string;
  readonly iban: string | null;
  readonly reference: string | null;
  readonly description: string | null;
  readonly payee: string | null;
}

const INSTALLMENT_COLUMNS = `t.amount, t.counterparty_iban AS iban, t.reference, t.description,
  t.counterparty_name AS payee`;

/**
 * The installment predicate of a loan: an outflow (filed `loans` by the caller's SQL) to the lender's
 * IBAN or carrying its payment phrase. Null when the loan names neither (nothing can match).
 */
function installmentMatch(
  iban: string | null,
  text: string | null,
): ((row: InstallmentRow) => boolean) | null {
  const phrase = normalizeText(text);
  const key = ibanKey(iban);
  if (!phrase && !key) return null;
  return (row) =>
    D(row.amount).lte(ZERO) &&
    ((key !== "" && ibanKey(row.iban) === key) ||
      (phrase !== "" &&
        normalizeText(
          [row.reference, row.description, row.payee].filter(Boolean).join(" "),
        ).includes(phrase)));
}

function matched(read: Read, iban: string | null, text: string | null): number {
  if (!enabledModuleIds(read).has("budget")) return 0;
  const match = installmentMatch(iban, text);
  if (match === null) return 0;
  return read<InstallmentRow>(
    `SELECT ${INSTALLMENT_COLUMNS} FROM transactions t WHERE t.category = 'loans'`,
  ).filter(match).length;
}

/**
 * The account that paid the loan's newest matched installment (the predicate `loans.screen` counts
 * with), among the visible accounts; null without one or without the budget module. The one rule for
 * the loan page and the upcoming installment row.
 */
export function loanPayingAccount(
  read: Read,
  loan: { readonly paymentIban: string | null; readonly paymentText: string | null },
): { readonly gid: string; readonly name: string } | null {
  if (!enabledModuleIds(read).has("budget")) return null;
  const match = installmentMatch(loan.paymentIban, loan.paymentText);
  if (match === null) return null;
  const hit = read<InstallmentRow & { gid: string; name: string }>(
    `SELECT ${INSTALLMENT_COLUMNS}, a.gid, a.name
     FROM transactions t JOIN accounts a ON a.id = t.account_id
     WHERE t.category = 'loans' AND a.removed_at IS NULL
     ORDER BY t.booking_date DESC, t.gid DESC`,
  ).find(match);
  return hit === undefined ? null : { gid: hit.gid, name: hit.name };
}

export function readLoansScreen(read: Read, today: IsoDate) {
  calendarDate.parse(today);
  const base = profileOf(read)?.baseCurrency ?? "PLN";
  return mcpLoanRows(read).map(({ loan, account, balances }) => ({
    ...loans.loanSummary(
      loan,
      { id: account.gid, name: account.name, type: account.type, currency: account.currency },
      loans.loanValuation(loan, balances),
      today,
      base,
    ),
    matched: matched(read, loan.paymentIban, loan.paymentText),
  }));
}
export const loansScreen = defineQuery({
  id: "loans.screen",
  run: (read, args: { readonly today: IsoDate }) => readLoansScreen(read, args.today),
});
export type LoanScreenRow = ReturnType<typeof readLoansScreen>[number];

export interface LoanSchedule {
  /** Every installment of the terms (`loans.schedule`), first to last. */
  readonly rows: readonly loans.ScheduleRow[];
  /** The first installment dated today or later; null once the loan is paid off. */
  readonly next: loans.ScheduleRow | null;
  /** How many installments are dated before today. */
  readonly paid: number;
  /** The name of the account the newest matched installment came from (`loanPayingAccount`). */
  readonly payingAccount: string | null;
}

/** One loan's installment schedule from its terms; null for an unknown loan. */
export function readLoanSchedule(read: Read, loan: string, today: IsoDate): LoanSchedule | null {
  calendarDate.parse(today);
  const terms = mcpLoanRows(read).find((row) => row.loan.id === loan)?.loan;
  if (terms === undefined) return null;
  const rows = loans.schedule(terms.principal, terms.annualRate, terms.termMonths, terms.startDate);
  const at = rows.findIndex((row) => row.date >= today);
  return {
    rows,
    next: at === -1 ? null : (rows[at] ?? null),
    paid: at === -1 ? rows.length : at,
    payingAccount: loanPayingAccount(read, terms)?.name ?? null,
  };
}

export const loanSchedule = defineQuery({
  id: "loans.schedule",
  run: (read, args: { readonly loan: string; readonly today: IsoDate }) =>
    readLoanSchedule(read, args.loan, args.today),
});
