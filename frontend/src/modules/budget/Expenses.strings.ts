// Texts of the expenses tab (Expenses.tsx). See src/i18n.ts.
import { catalog, enCount } from "../../i18n.ts";

export const S = catalog({
  wholePeriod: { pl: "Cały okres", en: "All time" },
  changed: { pl: (category: string) => `Zmieniono: ${category}`, en: (category: string) => `Changed: ${category}` },
  allFrom: { pl: (merchant: string) => `Wszystkie od ${merchant}`, en: (merchant: string) => `All from ${merchant}` },
  nTransactions: { pl: (n: number) => `${n} transakcji`, en: (n: number) => enCount(n, "transaction", "transactions") },
  /** The cash withdrawal pseudo-category of the drill-down select. */
  cashWithdrawal: { pl: "Wypłata gotówki", en: "Cash withdrawal" },
  expenses: { pl: "Wydatki", en: "Expenses" },
  month: { pl: "Miesiąc", en: "Month" },
  quarter: { pl: "Kwartał", en: "Quarter" },
  year: { pl: "Rok", en: "Year" },
  all: { pl: "Wszystko", en: "All" },
  transactionsOf: { pl: (category: string) => `Transakcje · ${category}`, en: (category: string) => `Transactions · ${category}` },
  sorting: { pl: "Sortowanie", en: "Sort by" },
  date: { pl: "Data", en: "Date" },
  amount: { pl: "Kwota", en: "Amount" },
  order: { pl: "Kolejność", en: "Order" },
  desc: { pl: "malejąco", en: "descending" },
  asc: { pl: "rosnąco", en: "ascending" },
  merchant: { pl: "Sprzedawca", en: "Merchant" },
  account: { pl: "Konto", en: "Account" },
  category: { pl: "Kategoria", en: "Category" },
  noTransactions: { pl: "Brak transakcji w tym okresie.", en: "No transactions in this period." },
});
