// The position page: one held (or watched) instrument with its chart, quantity and cost, the thesis
// and its signals, research notes and decisions. PL + EN.
import { catalog, enCount, plCount } from "@cashu/i18n";

export const S = catalog({
  position: { pl: "Pozycja", en: "Position" },
  missing: { pl: "Nie ma tu takiej pozycji", en: "There is no such position here" },
  unavailable: {
    pl: "Pozycja pojawi się, gdy Mac zapisze strategię",
    en: "The position shows once your Mac saved a strategy",
  },
  exchangeAccount: {
    pl: (exchange: string, account: string) => `${exchange} · ${account}`,
    en: (exchange: string, account: string) => `${exchange} · ${account}`,
  },
  accounts: {
    pl: (n: number) => plCount(n, "rachunek", "rachunki", "rachunków"),
    en: (n: number) => enCount(n, "account", "accounts"),
  },
  ofPortfolio: {
    pl: (pct: string) => `${pct} portfela`,
    en: (pct: string) => `${pct} of the portfolio`,
  },
  result: { pl: "wynik", en: "result" },
  thisWeek: { pl: "w tym tygodniu", en: "this week" },
  perShare: {
    pl: (price: string) => `${price} za akcję`,
    en: (price: string) => `${price} a share`,
  },
  perUnit: {
    pl: (price: string) => `${price} za jednostkę`,
    en: (price: string) => `${price} a unit`,
  },
  underHigh: {
    pl: (pct: string) => `${pct} poniżej szczytu z 52 tygodni`,
    en: (pct: string) => `${pct} under the 52-week high`,
  },
  atHigh: { pl: "na szczycie z 52 tygodni", en: "at the 52-week high" },
  chart: { pl: (name: string) => `Notowania: ${name}`, en: (name: string) => `Price of ${name}` },
  close: { pl: "Zamknięcie", en: "Close" },
  from: { pl: "od", en: "from" },
  to: { pl: "do", en: "to" },
  range: { pl: "Zakres wykresu", en: "Chart range" },
  range1m: { pl: "1M", en: "1M" },
  range3m: { pl: "3M", en: "3M" },
  range1y: { pl: "1R", en: "1Y" },
  rangeMax: { pl: "Maks.", en: "Max" },
  quantity: { pl: "Ilość", en: "Quantity" },
  shares: {
    pl: (n: string) => `${n} szt.`,
    en: (n: string) => `${n} units`,
  },
  averageCost: { pl: "Średni koszt", en: "Average cost" },
  yourThesis: { pl: "Twoja teza", en: "Your thesis" },
  why: { pl: "Dlaczego:", en: "Why:" },
  wrongIf: { pl: "Błędna, jeśli:", en: "Wrong if:" },
  sizePlan: { pl: "Plan wielkości:", en: "Size plan:" },
  exitPlan: { pl: "Plan wyjścia:", en: "Exit plan:" },
  editThesisOnMac: { pl: "Tezę edytujesz na Macu.", en: "Edit the thesis on your Mac." },
  signalsAndDecisions: { pl: "Sygnały i decyzje", en: "Signals and decisions" },
  open: { pl: "otwarty", en: "open" },
  noted: { pl: "zapisane", en: "noted" },
  yourAlert: {
    pl: (when: string) => `Twój alert · ${when}`,
    en: (when: string) => `Your alert · ${when}`,
  },
  yourRule: {
    pl: (when: string) => `Twoja reguła · ${when}`,
    en: (when: string) => `Your rule · ${when}`,
  },
  today: { pl: "dziś", en: "today" },
  researchNote: {
    pl: (day: string) => `Notatka z researchu · ${day}`,
    en: (day: string) => `Research note · ${day}`,
  },
  background: { pl: "tło", en: "background" },
  decision: { pl: "decyzja", en: "decision" },
  decisionWithReason: {
    pl: (action: string, reason: string) => `${action} - „${reason}”`,
    en: (action: string, reason: string) => `${action} - “${reason}”`,
  },
  nothingYet: {
    pl: "Bez sygnałów, notatek i decyzji",
    en: "No signals, notes or decisions yet",
  },
});

/** Exchange names by ISO 10383 MIC; any other MIC shows as its code. */
export const EXCHANGE = catalog({
  XWAR: { pl: "Warszawa", en: "Warsaw" },
  XNCO: { pl: "NewConnect", en: "NewConnect" },
  XETR: { pl: "Xetra", en: "Xetra" },
  XFRA: { pl: "Frankfurt", en: "Frankfurt" },
  XLON: { pl: "Londyn", en: "London" },
  XNYS: { pl: "NYSE", en: "NYSE" },
  XNAS: { pl: "Nasdaq", en: "Nasdaq" },
  ARCX: { pl: "NYSE Arca", en: "NYSE Arca" },
  XAMS: { pl: "Amsterdam", en: "Amsterdam" },
  XPAR: { pl: "Paryż", en: "Paris" },
});
