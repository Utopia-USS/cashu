// Texts of the uncategorized merchants drawer (CategoriesDrawer.tsx). See src/i18n.ts.
import { catalog, enCount, plCount } from "../../i18n.ts";

export const S = catalog({
  nTransactions: {
    pl: (n: number) => plCount(n, "transakcja", "transakcje", "transakcji"),
    en: (n: number) => enCount(n, "transaction", "transactions"),
  },
  notSaved: { pl: (reason: string) => `Nie zapisano: ${reason}`, en: (reason: string) => `Not saved: ${reason}` },
  title: { pl: "Kategorie", en: "Categories" },
  label: { pl: "Kategorie wydatków", en: "Expense categories" },
  uncategorized: {
    pl: (n: number) => plCount(n, "sprzedawca bez kategorii", "sprzedawców bez kategorii", "sprzedawców bez kategorii"),
    en: (n: number) => `${enCount(n, "merchant", "merchants")} without a category`,
  },
  ruleHint: { pl: "Reguła działa też dla przyszłych importów.", en: "The rule also applies to future imports." },
  allDone: { pl: "Wszyscy sprzedawcy mają kategorię.", en: "Every merchant has a category." },
  colMerchant: { pl: "Sprzedawca", en: "Merchant" },
  colCount: { pl: "liczba", en: "count" },
  colSum: { pl: "suma", en: "total" },
  colCategory: { pl: "kategoria", en: "category" },
  categoryOf: { pl: (merchant: string) => `Kategoria: ${merchant}`, en: (merchant: string) => `Category: ${merchant}` },
  choose: { pl: "wybierz…", en: "choose…" },
  income: { pl: "Przychody", en: "Income" },
  saved: { pl: "zapisano", en: "saved" },
});
