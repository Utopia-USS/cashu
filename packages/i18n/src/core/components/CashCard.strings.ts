// Texts of the cash card (frontend/src/components/CashCard.tsx). See docs/agents/localization.md.
import { catalog } from "../../index.js";

export const S = catalog({
  cashHint: {
    pl: "Wpłata do puli = kategoria „Wypłata gotówki” w Wydatkach. Nie wpływa na wartość netto.",
    en: 'Money into the pool = the "Cash withdrawal" category in Expenses. It does not change net worth.',
  },
  cash: { pl: "Gotówka", en: "Cash" },
  withdrawnSpent: {
    pl: (withdrawn: string, spent: string) => `wypłacono ${withdrawn} · wydano ${spent}`,
    en: (withdrawn: string, spent: string) => `withdrawn ${withdrawn} · spent ${spent}`,
  },
  amount: { pl: "Kwota", en: "Amount" },
  title: { pl: "Tytuł", en: "Title" },
  date: { pl: "Data", en: "Date" },
  category: { pl: "Kategoria", en: "Category" },
  empty: { pl: "Brak wydatków gotówkowych.", en: "No cash expenses." },
});
