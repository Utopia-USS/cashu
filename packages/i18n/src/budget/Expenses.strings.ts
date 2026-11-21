// Texts of the expenses tab (Expenses.tsx). See docs/agents/localization.md.
import { catalog, enCount, plCount } from "../index.js";

export const S = catalog({
  wholePeriod: { pl: "Cały okres", en: "All time" },
  changed: {
    pl: (category: string) => `Zmieniono: ${category}`,
    en: (category: string) => `Changed: ${category}`,
  },
  allFrom: {
    pl: (merchant: string) => `Wszystkie od ${merchant}`,
    en: (merchant: string) => `All from ${merchant}`,
  },
  nTransactions: {
    pl: (n: number) => plCount(n, "transakcja", "transakcje", "transakcji"),
    en: (n: number) => enCount(n, "transaction", "transactions"),
  },
  /** The cash withdrawal pseudo-category of the drill-down select. */
  cashWithdrawal: { pl: "Wypłata gotówki", en: "Cash withdrawal" },
  month: { pl: "Miesiąc", en: "Month" },
  quarter: { pl: "Kwartał", en: "Quarter" },
  year: { pl: "Rok", en: "Year" },
  all: { pl: "Wszystko", en: "All" },
  sorting: { pl: "Sortowanie", en: "Sort by" },
  category: { pl: "Kategoria", en: "Category" },
  noTransactions: { pl: "Brak transakcji w tym okresie.", en: "No transactions in this period." },
});
