// Texts of the loans tab (Loans.tsx). See src/i18n.ts.
import { catalog, enCount, plCount } from "../../i18n.ts";

export const S = catalog({
  /** Range buttons of the balance chart. */
  oneYear: { pl: "1R", en: "1Y" },
  years: { pl: (n: number) => `${n}L`, en: (n: number) => `${n}Y` },
  max: { pl: "Max", en: "Max" },
  error: { pl: (e: string) => `Błąd: ${e}`, en: (e: string) => `Error: ${e}` },
  title: { pl: "Kredyty", en: "Loans" },
  none: { pl: "Brak kredytów.", en: "No loans." },
  setup: { pl: "Konfiguracja", en: "Setup" },
  nLoans: { pl: (n: number) => plCount(n, "kredyt", "kredyty", "kredytów"), en: (n: number) => enCount(n, "loan", "loans") },
  loan: { pl: "Kredyt", en: "Loan" },
  installment: { pl: "Rata", en: "Installment" },
  remaining: { pl: "Pozostało", en: "Remaining" },
  totalInterest: { pl: "Odsetki łącznie", en: "Total interest" },
  payoffBy: { pl: "Spłata do", en: "Paid off by" },
  monthlyInstallment: { pl: "Rata miesięczna", en: "Monthly installment" },
  paidInterest: { pl: "Spłacone odsetki", en: "Interest paid" },
  payoffDate: { pl: "Data spłaty", en: "Payoff date" },
  paidCount: { pl: (n: number) => `${n} rat spłaconych`, en: (n: number) => `${enCount(n, "installment", "installments")} paid` },
  balanceOf: { pl: (name: string) => `Saldo · ${name}`, en: (name: string) => `Balance · ${name}` },
  noSchedule: { pl: "Brak harmonogramu.", en: "No repayment schedule." },
  balance: { pl: "Saldo", en: "Balance" },
  schedule: { pl: "Harmonogram", en: "Repayment schedule" },
  date: { pl: "Data", en: "Date" },
  interest: { pl: "Odsetki", en: "Interest" },
  principal: { pl: "Kapitał", en: "Principal" },
});
