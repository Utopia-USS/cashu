// Texts of the budget module definition (index.tsx). See src/i18n.ts.
import { catalog } from "../../i18n.ts";

export const S = catalog({
  name: { pl: "Budżet domowy", en: "Home budget" },
  desc: { pl: "Konta, wydatki, przepływy, subskrypcje · CSV lub Open Banking", en: "Accounts, expenses, cash flow, subscriptions · CSV or Open Banking" },
  short: { pl: "Konta bankowe, wydatki po kategoriach, przepływy i subskrypcje", en: "Bank accounts, expenses by category, cash flow and subscriptions" },
  tabExpenses: { pl: "Wydatki", en: "Expenses" },
  tabFlows: { pl: "Przepływy", en: "Cash flow" },
  tabSubs: { pl: "Subskrypcje", en: "Subscriptions" },
  kpiResult: { pl: (month: string) => `Wynik ${month}`, en: (month: string) => `Result ${month}` },
  factExpenses: { pl: (month: string) => `Wydatki ${month}`, en: (month: string) => `Expenses ${month}` },
  factSubs: { pl: "Subskrypcje", en: "Subscriptions" },
  perMonth: { pl: " / mies", en: " / mo" },
  none: { pl: "brak", en: "none" },
  factLastData: { pl: "Ostatnie dane", en: "Latest data" },
});
