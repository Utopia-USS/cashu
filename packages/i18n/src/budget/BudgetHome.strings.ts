// Texts of the merged budget screen (desktop screens/budget/home, design/desktop/budget/one-screen.html). Keys
// that mean the same as in the older budget catalogs are imported from those, not repeated here.
// See docs/agents/localization.md.
import { catalog, enCount, plCount } from "../index.js";

export const S = catalog({
  /** Accessible name of the Month / Quarter / Year / All switch. */
  period: { pl: "Okres", en: "Period" },
  prevPeriod: { pl: "Poprzedni okres", en: "Previous period" },
  nextPeriod: { pl: "Następny okres", en: "Next period" },
  /** The hero label when the period's surplus is negative. */
  shortfall: { pl: "Niedobór", en: "Shortfall" },
  /** "+1 099 zł vs średnia z 12 mies.": the surplus against the average of the complete months before it. */
  vsAverage: {
    pl: (months: number) => `vs średnia z ${months} mies.`,
    en: (months: number) => `vs your ${months}-month average`,
  },
  soFar: { pl: "do tej pory", en: "so far" },
  /** Quarter / year / all: "5 miesięcy · średnio 6 000 zł / mies.". */
  monthsAverage: {
    pl: (months: number, amount: string) =>
      `${plCount(months, "miesiąc", "miesiące", "miesięcy")} · średnio ${amount} / mies.`,
    en: (months: number, amount: string) =>
      `${enCount(months, "month", "months")} · ${amount} a month on average`,
  },
  /** The third meter: the share of the income that stays (savings rate). */
  kept: { pl: "Zostaje", en: "Kept" },
  spent: { pl: "Wydatki", en: "Spent" },
  chart: { pl: "Przychody i wydatki", en: "Income and spending" },
  /** "Też w EUR:" before the other currency's surplus; the button switches the screen to it. */
  alsoIn: {
    pl: (currency: string) => `Też w ${currency}:`,
    en: (currency: string) => `Also in ${currency}:`,
  },
  showCurrency: {
    pl: (currency: string) => `Pokaż budżet w ${currency}`,
    en: (currency: string) => `Show the budget in ${currency}`,
  },
  spending: { pl: "Wydatki", en: "Spending" },
  /** Share of the period's spending ("23% wydatków"). */
  ofSpending: {
    pl: (share: string) => `${share} wydatków`,
    en: (share: string) => `${share} of spending`,
  },
  newest: { pl: "Najnowsze", en: "Newest" },
  largest: { pl: "Największe", en: "Largest" },
  showAll: { pl: (n: number) => `Pokaż wszystkie ${n}`, en: (n: number) => `Show all ${n}` },
  showFewer: { pl: "Pokaż mniej", en: "Show fewer" },
  /** The drill's sub line: "6 transakcji · paź 2026". */
  drillMeta: {
    pl: (n: number, period: string) =>
      `${plCount(n, "transakcja", "transakcje", "transakcji")} · ${period}`,
    en: (n: number, period: string) => `${enCount(n, "transaction", "transactions")} · ${period}`,
  },
  activeCount: {
    pl: (n: number) => plCount(n, "aktywna", "aktywne", "aktywnych"),
    en: (n: number) => `${n} active`,
  },
  perMonth: { pl: "/ mies.", en: "/ month" },
  perYear: {
    pl: (amount: string) => `${amount} rocznie`,
    en: (amount: string) => `${amount} a year`,
  },
  nextCharges: { pl: "Najbliższe płatności", en: "Next charges" },
  monthly: { pl: "co miesiąc", en: "monthly" },
  daily: { pl: "codziennie", en: "daily" },
  everyDays: { pl: (n: number) => `co ${n} dni`, en: (n: number) => `every ${n} days` },
  today: { pl: "dziś", en: "today" },
  tomorrow: { pl: "jutro", en: "tomorrow" },
  inDays: { pl: (n: number) => `za ${n} dni`, en: (n: number) => `in ${n} days` },
  overdue: { pl: "po terminie", en: "overdue" },
  ended: { pl: "Zakończone", en: "Ended" },
  lastOn: { pl: (date: string) => `ostatnio ${date}`, en: (date: string) => `last ${date}` },
  showAllSubs: {
    pl: (n: number, ended: number) =>
      `Pokaż wszystkie ${n}${ended ? ` i ${plCount(ended, "zakończoną", "zakończone", "zakończonych")}` : ""}`,
    en: (n: number, ended: number) => `Show all ${n}${ended ? ` and ${ended} ended` : ""}`,
  },
  afterMonth: { pl: "Po zamknięciu miesiąca", en: "After the month" },
  toInvest: { pl: "do zainwestowania", en: "free to invest" },
  /** The contribution plan is covered: what stays after it ("pokryty, zostaje 2 038 zł"). */
  covered: {
    pl: (left: string) => `pokryty, zostaje ${left}`,
    en: (left: string) => `covered, ${left} left over`,
  },
  coveredExactly: { pl: "pokryty", en: "covered" },
  needsCategory: { pl: "Bez kategorii", en: "Needs a category" },
  /** "12 sprzedawców · łącznie 1 284,30 zł liczone jako Inne": every uncategorized expense of the currency, not
   * only the period's; the list holds at most 30 merchants, so a full list reads "30+". */
  uncategorized: {
    pl: (n: number, capped: boolean, amount: string, other: string) =>
      `${capped ? `${n}+ sprzedawców` : plCount(n, "sprzedawca", "sprzedawcy", "sprzedawców")} · łącznie ${amount} liczone jako ${other}`,
    en: (n: number, capped: boolean, amount: string, other: string) =>
      `${capped ? `${n}+ merchants` : enCount(n, "merchant", "merchants")} · ${amount} in total counted as ${other}`,
  },
  /** The contribution plan row when the plan cannot be read here (no strategy source in this app). */
  planUnavailable: { pl: "porównanie niedostępne", en: "comparison unavailable" },
  review: { pl: "Przejrzyj", en: "Review" },
});
