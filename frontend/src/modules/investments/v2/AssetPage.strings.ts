// Texts of the asset detail (AssetPage.tsx). See src/i18n.ts.
import { catalog, enCount, plCount } from "../../../i18n.ts";

/** The rule kind of a chart threshold as one word ("transza -15 % od szczytu"). */
export const THRESHOLD_WORD = catalog({
  drawdown_from_high: { pl: "transza", en: "tranche" },
  loss_from_cost: { pl: "strata", en: "loss" },
  gain_from_cost: { pl: "zysk", en: "gain" },
});

export const S = catalog({
  year1: { pl: "1R", en: "1Y" },
  year2: { pl: "2R", en: "2Y" },
  instrument: { pl: (id: number) => `instrument ${id}`, en: (id: number) => `instrument ${id}` },

  // chart levels
  agentAlert: { pl: "alert agenta", en: "agent alert" },
  alert: { pl: "alert", en: "alert" },
  below: { pl: "poniżej", en: "below" },
  above: { pl: "powyżej", en: "above" },
  rule: { pl: "reguła", en: "rule" },
  threshold: {
    pl: (word: string, sign: string, n: number, cost: boolean, value: string) => `${word} ${sign}${n} % od ${cost ? "kosztu" : "szczytu"} · ${value}`,
    en: (word: string, sign: string, n: number, cost: boolean, value: string) => `${word} ${sign}${n}% from ${cost ? "cost" : "high"} · ${value}`,
  },
  high52: { pl: "szczyt 52 tyg.", en: "52-wk high" },
  avgCost: { pl: "śr. koszt", en: "avg. cost" },

  // header
  addFailed: { pl: (err: string) => `Nie dodano: ${err}`, en: (err: string) => `Not added: ${err}` },
  accounts: { pl: (n: number) => plCount(n, "rachunek", "rachunki", "rachunków"), en: (n: number) => enCount(n, "account", "accounts") },
  watched: { pl: "obserwowany", en: "watched" },
  since: { pl: (date: string) => `od ${date}`, en: (date: string) => `since ${date}` },
  week: { pl: "tydz.", en: "wk" },
  fromHigh: { pl: "od szczytu", en: "from high" },
  value: { pl: "Wartość", en: "Value" },
  ofPortfolio: { pl: "portfela", en: "of portfolio" },
  result: { pl: "Wynik", en: "Return" },
  avgCostFact: { pl: "Śr. koszt", en: "Avg. cost" },
  quantity: { pl: "Ilość", en: "Quantity" },
  unwatch: { pl: "Przestań obserwować", en: "Stop watching" },
  watching: { pl: "Obserwujesz", en: "Watching" },
  watch: { pl: "Obserwuj", en: "Watch" },
  addAlert: { pl: "+ Alert", en: "+ Alert" },
  addTxn: { pl: "+ Transakcja", en: "+ Transaction" },
  noOpenSignal: { pl: "Brak otwartego sygnału", en: "No open signal" },
  recordDecision: { pl: "Zanotuj decyzję", en: "Record a decision" },
  lotDate: { pl: "data", en: "date" },
  lotQty: { pl: "ilość", en: "quantity" },
  lotPrice: { pl: "cena", en: "price" },
  lotResult: { pl: "wynik", en: "return" },
  lotResultPct: { pl: "wynik %", en: "return %" },

  // price chart
  chartTitle: { pl: "Cena z poziomami", en: "Price with levels" },
  range: { pl: "Zakres", en: "Range" },
  low: { pl: "dołek", en: "low" },
  vol30: { pl: "zmienność 30 dni", en: "30-day volatility" },
  toAlert: { pl: (price: string) => `do alertu ${price}:`, en: (price: string) => `to the ${price} alert:` },
  legendPrice: { pl: "cena", en: "price" },
  legendAlerts: { pl: "alerty", en: "alerts" },
  legendRules: { pl: "progi reguł", en: "rule thresholds" },
  legendBuys: { pl: "zakupy", en: "buys" },
  legendSells: { pl: "sprzedaże", en: "sells" },
  costValued: { pl: "Wycena po koszcie: bez notowań.", en: "Valued at cost: no quotes." },
  manualValued: { pl: "Wycena ręczna: bez notowań.", en: "Manual valuation: no quotes." },
  tooFewQuotes: { pl: "Za mało notowań.", en: "Not enough quotes." },
  chartLabel: { pl: (name: string) => `${name}: cena z poziomami alertów i reguł`, en: (name: string) => `${name}: price with alert and rule levels` },

  // thesis, recommendation, alerts, timeline
  thesis: { pl: "Teza", en: "Thesis" },
  entry: { pl: "Wejście", en: "Entry" },
  invalidation: { pl: "Unieważnienie", en: "Invalidation" },
  exitPlan: { pl: "Plan wyjścia", en: "Exit plan" },
  sizePlan: { pl: "Wielkość i dokupienia", en: "Size and add-ons" },
  noThesis: { pl: "Brak tezy.", en: "No thesis." },
  recommendation: { pl: "Rekomendacja", en: "Recommendation" },
  recTitle: { pl: "Rekomendacja modelu. Decyzję zapisujesz osobno.", en: "The model's recommendation. You record your decision separately." },
  freshTitle: { pl: "Według danych zapisanych po rekomendacji", en: "Based on data stored after the recommendation" },
  recAria: { pl: (label: string) => `Rekomendacja modelu: ${label}`, en: (label: string) => `Model recommendation: ${label}` },
  reasons: { pl: "Powody", en: "Reasons" },
  alerts: { pl: "Alerty", en: "Alerts" },
  all: { pl: "wszystkie", en: "all" },
  newAlert: { pl: "+ Nowy", en: "+ New" },
  noAlerts: { pl: "Brak alertów.", en: "No alerts." },
  signalsDecisions: { pl: "Sygnały i decyzje", en: "Signals and decisions" },
  journal: { pl: "dziennik", en: "journal" },
  noSignalsDecisions: { pl: "Brak sygnałów i decyzji.", en: "No signals or decisions." },

  // watch note
  saveFailed: { pl: (err: string) => `Nie udało się zapisać: ${err}`, en: (err: string) => `Could not save: ${err}` },
  whyWatch: { pl: "Dlaczego obserwuję", en: "Why I watch it" },
  saving: { pl: "Zapisuję…", en: "Saving…" },
  noNote: { pl: "Brak notatki.", en: "No note." },

  // open signals
  note: { pl: "notatka", en: "note" },
  ack: { pl: "potwierdź", en: "acknowledge" },
  ackAll: { pl: "Potwierdź", en: "Acknowledge" },
  ackTitle: {
    pl: (n: number) => `Potwierdza ${plCount(n, "sygnał", "sygnały", "sygnałów")}`,
    en: (n: number) => `Acknowledges ${enCount(n, "signal", "signals")}`,
  },
});
