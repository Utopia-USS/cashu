// Texts of the portfolio widgets (Portfolio.tsx): Aktywa, Alokacja, Rachunki. See docs/agents/localization.md.
import { catalog, enCount, intlLocale, plCount } from "../../index.js";

const inactiveRules = {
  pl: (n: number) => plCount(n, "reguła nieaktywna", "reguły nieaktywne", "reguł nieaktywnych"),
  en: (n: number) => enCount(n, "inactive rule", "inactive rules"),
};

export const S = catalog({
  newNotes: {
    pl: (n: number) => plCount(n, "nowa notatka", "nowe notatki", "nowych notatek"),
    en: (n: number) => enCount(n, "new note", "new notes"),
  },

  // Aktywa
  account: { pl: (id: number) => `rachunek ${id}`, en: (id: number) => `account ${id}` },
  scope: { pl: "Zakres", en: "Scope" },
  tabPortfolio: { pl: (n: number) => `Portfel ${n}`, en: (n: number) => `Portfolio ${n}` },
  tabWatch: { pl: (n: number) => `Obserwowane ${n}`, en: (n: number) => `Watchlist ${n}` },
  assets: { pl: "Aktywa", en: "Assets" },
  split: { pl: "Podział", en: "Split" },
  total: { pl: "Razem", en: "Total" },
  perAccount: { pl: "Według rachunków", en: "Per account" },
  sortResult: { pl: "wynik %", en: "return %" },
  sortValue: { pl: "wartość", en: "value" },
  sortWeek: { pl: "tydzień", en: "week" },
  add: { pl: "+ Dodaj", en: "+ Add" },
  addTxn: { pl: "+ transakcja", en: "+ transaction" },
  alertsWord: {
    pl: (n: number) => plCount(n, "alert", "alerty", "alertów").replace(/^\d+ /, ""),
    en: (n: number) => enCount(n, "alert", "alerts").replace(/^\d+ /, ""),
  },
  col30d: { pl: "30 dni", en: "30 days" },
  colWeight: { pl: "Waga", en: "Weight" },
  colResultTitle: {
    pl: "Od kosztu (FIFO), ceny zamknięcia",
    en: "Against cost (FIFO), closing prices",
  },
  // The quiet asset table (design V5): two-line cells and sortable heads, the tile legend in the footer.
  hPriceWeek: { pl: "Cena · tydzień", en: "Price · week" },
  hValueReturn: { pl: "Wartość · wynik", en: "Value · return" },
  sortBy: { pl: (what: string) => `Sortuj: ${what}`, en: (what: string) => `Sort by ${what}` },
  legendThesis: { pl: "Teza", en: "Thesis" },
  spark30d: {
    pl: (label: string) => `${label}: 30 dni`,
    en: (label: string) => `${label}: 30 days`,
  },
  noPositions: { pl: "Brak otwartych pozycji.", en: "No open positions." },
  cash: { pl: "Gotówka", en: "Cash" },

  // allocation
  thousands: {
    pl: (n: number) => `${n.toLocaleString(intlLocale())} tys.`,
    en: (n: number) => `${n.toLocaleString(intlLocale())}k`,
  },
  loss: { pl: "strata", en: "loss" },
  gain: { pl: "zysk", en: "gain" },
  cost: { pl: "koszt", en: "cost" },
  priceFrom: {
    pl: (label: string, date: string) => `${label}: cena z ${date}`,
    en: (label: string, date: string) => `${label}: price from ${date}`,
  },
  inactiveRules,
  strategyError: { pl: "błąd w strategii", en: "error in the strategy" },
  warnings: { pl: (n: number) => `ostrzeżenia (${n})`, en: (n: number) => `warnings (${n})` },
  dataWarnings: { pl: "Ostrzeżenia danych", en: "Data warnings" },
  fixInSettings: { pl: "napraw w Ustawieniach", en: "fix in Settings" },
  settings: { pl: "Ustawienia", en: "Settings" },
  noAccounts: { pl: "Brak rachunków maklerskich.", en: "No brokerage accounts." },
  accountsDonut: {
    pl: (list: string) => `Rachunki: ${list}`,
    en: (list: string) => `Accounts: ${list}`,
  },
  band: { pl: (pp: number) => `pasmo ±${pp} pp`, en: (pp: number) => `band ±${pp} pp` },
  priorityGrow: {
    pl: (bucket: string, pp: string) =>
      `Najpierw zwiększaj wagę ${bucket}: ${pp} do celu. Rekomendacje „kup” dla pozycji to drugi krok.`,
    en: (bucket: string, pp: string) =>
      `First grow the weight of ${bucket}: ${pp} to target. Local "buy" calls come second.`,
  },
  priorityHold: {
    pl: (bucket: string, pp: string) =>
      `Nie zwiększaj wagi ${bucket}: ${pp} ponad cel. Rekomendacje „kup” dla pozycji to drugi krok.`,
    en: (bucket: string, pp: string) =>
      `Do not grow the weight of ${bucket}: ${pp} over target. Local "buy" calls come second.`,
  },
  priorityKeep: {
    pl: "Utrzymuj docelowe udziały. Rekomendacje dla pojedynczych pozycji nie powinny zaburzać równowagi portfela.",
    en: "Keep the target weights. Local recommendations should not upset the portfolio's balance.",
  },
  noBucket: { pl: "Bez koszyka", en: "No bucket" },
  cashLc: { pl: "gotówka", en: "cash" },
  viewBuckets: { pl: "Koszyki", en: "Buckets" },
  viewClasses: { pl: "Klasy", en: "Classes" },
  viewRegions: { pl: "Regiony", en: "Regions" },
  viewAccounts: { pl: "Rachunki", en: "Accounts" },
  allocation: { pl: "Alokacja", en: "Allocation" },
  outOfBand: {
    pl: (n: number) => (n === 1 ? "1 poza pasmem" : `${n} poza pasmem`),
    en: (n: number) => `${n} out of band`,
  },
  inBand: { pl: "w paśmie", en: "in band" },
  allocSplit: { pl: "Podział alokacji", en: "Allocation split" },
  addAccount: { pl: "+ Rachunek", en: "+ Account" },
  noPositionsShort: { pl: "Brak pozycji.", en: "No positions." },
  allocDonut: {
    pl: (list: string) => `Alokacja: ${list}`,
    en: (list: string) => `Allocation: ${list}`,
  },
  positions: {
    pl: (n: number) => plCount(n, "pozycja", "pozycje", "pozycji"),
    en: (n: number) => enCount(n, "position", "positions"),
  },
  targetWholeTitle: {
    pl: "cel dotyczy całego portfela",
    en: "the target applies to the whole portfolio",
  },
  priority: { pl: "Priorytet portfela", en: "Portfolio priority" },
  // Column headers in sentence case (the quiet allocation card, design V5).
  hBucket: { pl: "Koszyk", en: "Bucket" },
  hClass: { pl: "Klasa", en: "Class" },
  hRegion: { pl: "Region", en: "Region" },
  hAccount: { pl: "Rachunek", en: "Account" },
  hNow: { pl: "Teraz", en: "Now" },
  hNowTarget: { pl: "Teraz / cel", en: "Now / target" },
  hDrift: { pl: "Dryf", en: "Drift" },
  hValue: { pl: "Wartość", en: "Value" },
  hToTarget: { pl: "Do celu", en: "To target" },
  hSnapshot: { pl: "Snapshot", en: "Snapshot" },
  outOfBandNamed: {
    pl: (name: string) => `${name} poza pasmem`,
    en: (name: string) => `${name} out of band`,
  },
});
