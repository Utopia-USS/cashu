// The Activity tab: the search field, the filter chips, the day list and the search answer. PL + EN.
import { catalog, enCount, plCount } from "@cashu/i18n";

export const S = catalog({
  title: { pl: "Aktywność", en: "Activity" },
  searchPlaceholder: { pl: "Odbiorcy, tytuły, kwoty", en: "Payees, titles, amounts" },
  clearSearch: { pl: "Wyczyść wyszukiwanie", en: "Clear search" },
  filters: { pl: "Filtry", en: "Filters" },
  all: { pl: "Wszystkie", en: "All" },
  toCategorize: { pl: "Bez kategorii", en: "To categorize" },
  income: { pl: "Wpływy", en: "Income" },
  cash: { pl: "Gotówka", en: "Cash" },
  clearCategory: {
    pl: (category: string) => `Usuń filtr kategorii ${category}`,
    en: (category: string) => `Remove the ${category} filter`,
  },
  toCategorizeTag: { pl: "Bez kategorii", en: "To categorize" },
  betweenAccounts: {
    pl: "Między Twoimi kontami · nie liczy się do wydatków",
    en: "Between your accounts · not counted",
  },
  cashTag: { pl: "gotówka", en: "cash" },
  spent: { pl: "wydano", en: "spent" },
  useSearch: {
    pl: "Starsze płatności znajdziesz przez wyszukiwanie",
    en: "Search to find older payments",
  },
  paymentsSince: {
    pl: (count: number, year: number) =>
      `${plCount(count, "płatność", "płatności", "płatności")} od ${year} r.`,
    en: (count: number, year: number) => `${enCount(count, "payment", "payments")} since ${year}`,
  },
  vsYearBefore: {
    pl: (pct: string) => `${pct} rok do roku`,
    en: (pct: string) => `${pct} vs the year before`,
  },
  nPayments: {
    pl: (count: number) => plCount(count, "płatność", "płatności", "płatności"),
    en: (count: number) => enCount(count, "payment", "payments"),
  },
  allHistoryOnPhone: {
    pl: "cała historia · szukane na tym telefonie",
    en: "all history · searched on this phone",
  },
  noMatch: {
    pl: (q: string) => `Żadna płatność nie pasuje do „${q}”.`,
    en: (q: string) => `No payments match "${q}".`,
  },
  nothingHere: { pl: "Nic tu nie ma.", en: "Nothing here." },
});
