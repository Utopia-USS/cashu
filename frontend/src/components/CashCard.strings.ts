// Texts of the cash card (src/components/CashCard.tsx). See src/i18n.ts.
import { catalog } from "../i18n.ts";

export const S = catalog({
  needAmountTitle: { pl: "Podaj kwotę i tytuł wydatku.", en: "Enter the amount and title of the expense." },
  cashHint: {
    pl: "Wpłata do puli = kategoria „Wypłata gotówki” w Wydatkach. Nie wpływa na wartość netto.",
    en: "Money into the pool = the \"Cash withdrawal\" category in Expenses. It does not change net worth.",
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
