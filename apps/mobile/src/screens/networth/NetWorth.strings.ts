import { catalog, enCount, plCount } from "@cashu/i18n";

export const S = catalog({
  title: { pl: "Wartość netto", en: "Net worth" },
  netWorth: { pl: "Wartość netto", en: "Net worth" },
  convertedTo: {
    pl: (currency: string) => `Wartość netto w przeliczeniu na ${currency}`,
    en: (currency: string) => `Net worth, converted to ${currency}`,
  },
  inBananas: { pl: "Wartość netto w bananach", en: "Net worth, in bananas" },
  twelveMonths: { pl: "12 miesięcy", en: "12 months" },
  history: { pl: "Wartość netto w ostatnich 12 miesiącach", en: "Net worth over 12 months" },
  value: { pl: "Wartość", en: "Value" },
  from: { pl: "Od", en: "From" },
  to: { pl: "do", en: "to" },
  noHistory: { pl: "Brak historii", en: "No history yet" },
  /** "since October": the month the change is measured from (pl: its genitive form). */
  since: {
    pl: (month: string) => `od końca ${month}`,
    en: (month: string) => `since ${month}`,
  },
  incl: { pl: "w tym", en: "incl." },
  nbpRate: {
    pl: (date: string) => `przeliczone po średnim kursie NBP z ${date}`,
    en: (date: string) => `converted at the NBP mid rate of ${date}`,
  },
  otherCurrencies: { pl: "Poza tym", en: "Also" },
  noRateYet: {
    pl: (currencies: string) => `${currencies}: brak kursu NBP na tym telefonie, nie wliczono`,
    en: (currencies: string) => `${currencies}: no NBP rate on this phone yet, not counted`,
  },
  owned: { pl: "Posiadane", en: "Owned" },
  owed: { pl: "Długi", en: "Owed" },
  noLoans: { pl: "bez kredytów", en: "no loans" },
  homeEquity: { pl: "Nieruchomość minus kredyt", en: "Home equity" },
  cashAtHand: { pl: "Wolne środki", en: "Cash at hand" },
  monthsOfSpending: {
    pl: (months: string) => `na ${months} mies. wydatków`,
    en: (months: string) => `${months} months of spending`,
  },
  currency: { pl: "Waluta", en: "Currency" },
  accounts: { pl: "Konta", en: "Accounts" },
  asOf: { pl: "stan z", en: "as of" },
  noBalance: { pl: "bez salda", en: "no balance" },
  showEmpty: {
    pl: (n: number) => `Pokaż puste (${plCount(n, "konto", "konta", "kont")})`,
    en: (n: number) => `Show empty (${enCount(n, "account", "accounts")})`,
  },
  hideEmpty: { pl: "Ukryj puste", en: "Hide empty" },
  loans: { pl: "Kredyty", en: "Loans" },
  loan: { pl: "Kredyt", en: "Loan" },
  perMonth: { pl: "miesięcznie", en: "a month" },
  until: { pl: "do", en: "until" },
  openLoan: {
    pl: (name: string) => `Otwórz kredyt ${name}`,
    en: (name: string) => `Open loan ${name}`,
  },
  propertyAndCar: { pl: "Nieruchomość i samochód", en: "Property and car" },
  valued: { pl: "wycena z", en: "valued" },
  oldValuation: { pl: "dawno nieaktualizowana", en: "not updated for a while" },
  /** "loses PLN 580 a month" / "traci 580 zł miesięcznie": the words around the amount. */
  losesBefore: { pl: "traci", en: "loses" },
  losesAfter: { pl: "miesięcznie", en: "a month" },
  noteValues: {
    pl: "Wartości są aktualizowane na Macu, kilka razy w roku.",
    en: "Values are updated on the Mac, a few times a year.",
  },
  noteValuesAndLoans: {
    pl: "Wartości i warunki kredytów są aktualizowane na Macu, kilka razy w roku.",
    en: "Values and loan terms are updated on the Mac, a few times a year.",
  },
});
