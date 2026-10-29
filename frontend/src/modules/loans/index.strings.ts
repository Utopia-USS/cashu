// Texts of the loans module definition and its overview widget (index.tsx). See src/i18n.ts.
import { catalog } from "../../i18n.ts";

export const S = catalog({
  title: { pl: "Kredyty", en: "Loans" },
  installments: { pl: "raty", en: "installments" },
  perMonth: { pl: " / mies.", en: " / mo" },
  incomeShare: { pl: (pct: number) => ` · ${pct} % przychodów`, en: (pct: number) => ` · ${pct}% of income` },
  none: { pl: "Brak kredytów.", en: "No loans." },
  installment: { pl: (amount: string) => `rata ${amount}`, en: (amount: string) => `installment ${amount}` },
  until: { pl: (year: string) => `do ${year}`, en: (year: string) => `until ${year}` },
  others: { pl: "Pozostałe", en: "Others" },
  more: { pl: (n: number) => `${n} kolejne`, en: (n: number) => `${n} more` },
  monthlyInstallments: { pl: "Raty w miesiącu", en: "Monthly installments" },
  desc: { pl: "Hipoteka i kredyty: harmonogram, odsetki, saldo w czasie", en: "Mortgage and loans: repayment schedule, interest, balance over time" },
  hint: { pl: "Z Budżetem: raty nie są liczone jako subskrypcje.", en: "With Budget: installments are not counted as subscriptions." },
  short: { pl: "Harmonogramy kredytów, odsetki i saldo w czasie", en: "Loan repayment schedules, interest and balance over time" },
});
