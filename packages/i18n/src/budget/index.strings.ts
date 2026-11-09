// Texts of the budget module definition (index.tsx). See docs/agents/localization.md.
import { catalog } from "../index.js";

export const S = catalog({
  name: { pl: "Budżet domowy", en: "Home budget" },
  short: {
    pl: "Konta bankowe, wydatki po kategoriach, przepływy i subskrypcje",
    en: "Bank accounts, expenses by category, cash flow and subscriptions",
  },
  /** The budget's one tab (expenses, cash flow and subscriptions on one screen). */
  tab: { pl: "Budżet", en: "Budget" },
});
