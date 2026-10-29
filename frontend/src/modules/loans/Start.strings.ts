// Texts of the loans first steps (Start.tsx). See src/i18n.ts.
import { catalog, enCount, plCount } from "../../i18n.ts";

export const S = catalog({
  installment: { pl: (amount: string) => `rata ${amount}`, en: (amount: string) => `installment ${amount}` },
  until: { pl: (year: string) => `do ${year}`, en: (year: string) => `until ${year}` },
  loan: { pl: "Kredyt", en: "Loan" },
  nLoans: { pl: (n: number) => plCount(n, "kredyt", "kredyty", "kredytów"), en: (n: number) => enCount(n, "loan", "loans") },
  loanHint: { pl: "Kwota, oprocentowanie, okres, pierwsza rata.", en: "Amount, interest rate, term, first installment." },
  addAnother: { pl: "Dodaj kolejny", en: "Add another" },
  addLoan: { pl: "Dodaj kredyt", en: "Add a loan" },
  payments: { pl: "Rozpoznawanie rat", en: "Recognizing installments" },
  paymentsHint: {
    pl: "Fraza z tytułu przelewu albo IBAN banku; raty liczą się jako spłata, nie subskrypcja.",
    en: "A phrase from the transfer title or the bank's IBAN; installments count as repayment, not a subscription.",
  },
  change: { pl: "Zmień", en: "Change" },
  pick: { pl: "Wskaż ratę", en: "Pick the installment" },
  title: { pl: "Kredyty", en: "Loans" },
  added: { pl: (name: string) => `Dodano kredyt ${name}`, en: (name: string) => `Added loan ${name}` },
});
