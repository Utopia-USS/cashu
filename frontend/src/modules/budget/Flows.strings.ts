// Texts of the cash flow tab (Flows.tsx). See src/i18n.ts.
import { catalog } from "../../i18n.ts";

export const S = catalog({
  /** Range buttons: n years ("3L" / "3Y"); the first quarterly one is a single year ("1R" / "1Y"). */
  years: { pl: (n: number) => `${n}L`, en: (n: number) => `${n}Y` },
  oneYear: { pl: "1R", en: "1Y" },
  max: { pl: "Max", en: "Max" },
  aggregation: { pl: "Agregacja", en: "Aggregation" },
  monthly: { pl: "miesięcznie", en: "monthly" },
  quarterly: { pl: "kwartalnie", en: "quarterly" },
  yearly: { pl: "rocznie", en: "yearly" },
  title: { pl: (currency: string) => `Przepływy (${currency})`, en: (currency: string) => `Cash flow (${currency})` },
  income: { pl: "Przychód", en: "Income" },
  expenses: { pl: "Wydatki", en: "Expenses" },
  net: { pl: "Wynik", en: "Net" },
});
