import { catalog } from "@cashu/i18n";

export const S = catalog({
  title: { pl: "Wydatki", en: "Spending" },
  byCategory: { pl: "Wydatki według kategorii", en: "Spending by category" },
  period: { pl: "Okres", en: "Period" },
  currency: { pl: "Waluta", en: "Currency" },
  month: { pl: "Miesiąc", en: "Month" },
  quarter: { pl: "Kwartał", en: "Quarter" },
  year: { pl: "Rok", en: "Year" },
  quarterValue: {
    pl: (quarter: number, year: number) => `${quarter}. kwartał ${year}`,
    en: (quarter: number, year: number) => `Q${quarter} ${year}`,
  },
  previous: { pl: "Poprzedni okres", en: "Previous period" },
  next: { pl: "Następny okres", en: "Next period" },
  spentSoFar: { pl: "Wydano do tej pory", en: "Spent so far" },
  spent: { pl: "Wydano", en: "Spent" },
  vsUsual: {
    pl: (pct: string) => `${pct} względem zwykłego`,
    en: (pct: string) => `${pct} vs usual`,
  },
  asUsual: { pl: "jak zwykle", en: "as usual" },
  ofSpending: { pl: "wydatków", en: "of spending" },
  monthClosed: {
    pl: (month: string) => `Zamknięcie miesiąca: ${month}`,
    en: (month: string) => `${month} closed`,
  },
  noData: { pl: "Brak wydatków", en: "No spending" },
  transfersNote: {
    pl: "Przelewy między Twoimi kontami nie są liczone.",
    en: "Transfers between your own accounts are not counted.",
  },
  showing: {
    pl: (currency: string) => `Kwoty w ${currency}; w innych walutach wydano`,
    en: (currency: string) => `Showing ${currency}; your other currencies spent`,
  },
});
