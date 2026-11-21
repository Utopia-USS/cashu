// The Investments tab's Portfolio view: the value tile, allocation against the strategy's targets and
// the positions. PL + EN (glossary: Koszyk = Bucket, Pozycja = Position, Notowania = Prices).
import { catalog, enCount, plCount } from "@cashu/i18n";

export const S = catalog({
  convertedTo: {
    pl: (currency: string) => `Wartość, przeliczona na ${currency}`,
    en: (currency: string) => `Value, converted to ${currency}`,
  },
  inBananas: { pl: "Wartość, w bananach", en: "Value, in bananas" },
  allAccounts: { pl: "Wszystkie konta", en: "All accounts" },
  account: { pl: "Konto", en: "Account" },
  today: { pl: "dziś", en: "today" },
  thisWeek: { pl: "w tym tygodniu", en: "this week" },
  incl: { pl: "w tym", en: "incl." },
  nbpRate: {
    pl: (date: string) => `po średnim kursie NBP z ${date}`,
    en: (date: string) => `at the NBP mid rate of ${date}`,
  },
  chart: { pl: "Wartość portfela przez 12 miesięcy", en: "Portfolio value over 12 months" },
  value: { pl: "Wartość", en: "Value" },
  noHistory: { pl: "Brak historii", en: "No history yet" },
  chartSummary: {
    pl: (from: string, fromValue: string, to: string, toValue: string) =>
      `Od ${from} ${fromValue} do ${to} ${toValue}`,
    en: (from: string, fromValue: string, to: string, toValue: string) =>
      `From ${from} ${fromValue} to ${to} ${toValue}`,
  },
  thisYear: { pl: "Ten rok", en: "This year" },
  fromHigh: { pl: "Od szczytu z 12 miesięcy", en: "From the 12-month high" },
  unrealized: { pl: "Zysk do tej pory", en: "Gain so far" },
  added: {
    pl: (year: string) => `Wpłacone w ${year}`,
    en: (year: string) => `Added in ${year}`,
  },
  planToDate: { pl: "plan do dziś", en: "plan to date" },
  allocation: { pl: "Alokacja a Twoje cele", en: "Allocation vs your targets" },
  unbucketed: { pl: "Poza koszykami", en: "Not in a bucket" },
  below: {
    pl: (bucket: string, pp: string) => `${bucket}: ${pp} poniżej celu`,
    en: (bucket: string, pp: string) => `${bucket} ${pp} below target`,
  },
  above: {
    pl: (bucket: string, pp: string) => `${bucket}: ${pp} powyżej celu`,
    en: (bucket: string, pp: string) => `${bucket} ${pp} above target`,
  },
  onTarget: { pl: "Zgodnie z celami", en: "On target" },
  noTarget: { pl: "bez celu", en: "no target" },
  positions: { pl: "Pozycje", en: "Positions" },
  byValue: { pl: "według wartości", en: "by value" },
  week: { pl: "tydzień", en: "week" },
  openPosition: {
    pl: (name: string) => `${name}, otwórz pozycję`,
    en: (name: string) => `${name}, open the position`,
  },
  risk: { pl: "czeka na decyzję", en: "waiting for a decision" },
  stalePrices: {
    pl: (n: number) => `${plCount(n, "pozycja ma", "pozycje mają", "pozycji ma")} stare notowania`,
    en: (n: number) => `${enCount(n, "position has", "positions have")} an old price`,
  },
  noPositions: { pl: "Jeszcze nic tu nie ma", en: "Nothing here yet" },
  noPositionsNote: {
    pl: "Transakcje dodajesz na Macu; pojawią się tu po synchronizacji.",
    en: "Trades are added on your Mac; they show up here after a sync.",
  },
  unavailable: {
    pl: "Portfela nie da się teraz wycenić na tym telefonie.",
    en: "The portfolio cannot be valued on this phone right now.",
  },
});
