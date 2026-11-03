/** Full local loan summaries, without exposing stored lender account numbers. */
import { D, type IsoDate, ibanKey, loans, normalizeText } from "@cashu/domain";
import { enabledModuleIds, profileOf } from "../core/queries.js";
import { calendarDate } from "../events/v1/primitives.js";
import { defineQuery, type Read } from "../query.js";
import { mcpLoanRows } from "./mcp-queries.js";

export { createUiLoan, setUiLoanPayment } from "./ui-commands.js";

function matched(read: Read, iban: string | null, text: string | null): number {
  if (!enabledModuleIds(read).has("budget")) return 0;
  const phrase = normalizeText(text);
  const key = ibanKey(iban);
  if (!phrase && !key) return 0;
  return read<{
    amount: string;
    iban: string | null;
    reference: string | null;
    description: string | null;
    payee: string | null;
  }>(
    `SELECT amount, counterparty_iban AS iban, reference, description, counterparty_name AS payee FROM transactions WHERE category = 'loans'`,
  ).filter(
    (row) =>
      D(row.amount).lte(D("0")) &&
      ((key !== "" && ibanKey(row.iban) === key) ||
        (phrase !== "" &&
          normalizeText(
            [row.reference, row.description, row.payee].filter(Boolean).join(" "),
          ).includes(phrase))),
  ).length;
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
