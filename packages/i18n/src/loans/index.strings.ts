// Texts of the loans module definition and its overview widget (index.tsx). See docs/agents/localization.md.
import { catalog } from "../index.js";

export const S = catalog({
  title: { pl: "Kredyty", en: "Loans" },
  installments: { pl: "raty", en: "installments" },
  perMonth: { pl: " / mies.", en: " / mo" },
  incomeShare: {
    pl: (pct: number) => ` · ${pct} % przychodów`,
    en: (pct: number) => ` · ${pct}% of income`,
  },
  none: { pl: "Brak kredytów.", en: "No loans." },
  installment: {
    pl: (amount: string) => `rata ${amount}`,
    en: (amount: string) => `installment ${amount}`,
  },
  until: { pl: (year: string) => `do ${year}`, en: (year: string) => `until ${year}` },
  short: {
    pl: "Harmonogramy kredytów, odsetki i saldo w czasie",
    en: "Loan repayment schedules, interest and balance over time",
  },
});
