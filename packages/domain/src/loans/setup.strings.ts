/**
 * UI texts of the loans' blank-page steps (`modules/loans/setup.py`), Polish and English, byte-equal to
 * the Python source (parity check `core.overview`). The example title phrase `RATA KREDYTU` in the
 * command stays Polish: it matches Polish bank transfer titles.
 */

export const loansSetupStrings = {
  loanTitle: { pl: "Kredyt", en: "Loan" },
  loanDescription: {
    pl: "Kwota, oprocentowanie, okres, pierwsza rata.",
    en: "Amount, interest rate, term, first installment.",
  },
  loanName: { pl: "Hipoteka", en: "Mortgage" },
  paymentsTitle: { pl: "Rozpoznawanie rat", en: "Recognizing installments" },
  paymentsDescription: {
    pl: "Fraza z tytułu przelewu albo IBAN banku; raty liczą się jako spłata, nie subskrypcja.",
    en: "A phrase from the transfer title or the bank's IBAN; installments count as repayment, not a subscription.",
  },
  loanIdPlaceholder: { pl: "KREDYT_ID", en: "LOAN_ID" },
} as const;
