// Texts of the signals rail, dialog, rows and decision form (Signals.tsx). See src/i18n.ts.
import { catalog, enCount, plCount } from "../../../i18n.ts";

export const S = catalog({
  unconfirmedSince: { pl: (d: string) => `niepotwierdzony od ${d}`, en: (d: string) => `unconfirmed since ${d}` },
  today: { pl: "dziś", en: "today" },
  originResearch: { pl: "research: ", en: "research: " },
  originAgentAlert: { pl: "alert agenta: ", en: "agent alert: " },
  originAlert: { pl: "alert: ", en: "alert: " },
  account: { pl: (id: number) => `rachunek ${id}`, en: (id: number) => `account ${id}` },

  // rail
  none: { pl: "Brak", en: "None" },
  signals: { pl: "Sygnały", en: "Signals" },
  decisionsLabel: { pl: "decyzje:", en: "decisions:" },
  xOfY: { pl: (a: number, b: number) => `${a} z ${b}`, en: (a: number, b: number) => `${a} of ${b}` },
  thisWeek: { pl: "w tym tygodniu", en: "this week" },
  allCount: { pl: (n: number) => `Wszystkie (${n})`, en: (n: number) => `All (${n})` },
  noOpen: { pl: "Brak otwartych sygnałów.", en: "No open signals." },
  portfolio: { pl: "Portfel", en: "Portfolio" },
  watched: { pl: "Obserwowane", en: "Watchlist" },

  // writes and toasts
  decisionSaved: { pl: (tag: string) => `Zapisano decyzję · ${tag}`, en: (tag: string) => `Decision saved · ${tag}` },
  whatDecision: { pl: "decyzja", en: "decision" },
  decisionFailed: { pl: "Nie zapisano decyzji", en: "Decision not saved" },
  decisionFailedErr: { pl: (err: string) => `Nie zapisano decyzji: ${err}`, en: (err: string) => `Decision not saved: ${err}` },
  ackDone: { pl: "Potwierdzone bez zmian", en: "Acknowledged, no change" },
  whatAck: { pl: "potwierdzenie", en: "acknowledgement" },
  notSaved: { pl: "Nie zapisano", en: "Not saved" },
  notSavedErr: { pl: (err: string) => `Nie zapisano: ${err}`, en: (err: string) => `Not saved: ${err}` },
  whatSnooze: { pl: "odłożenie", en: "snooze" },
  snoozedTo: { pl: (d: string) => `Odłożone do ${d}`, en: (d: string) => `Postponed to ${d}` },
  snoozedReason: { pl: (d: string) => `odłożone do ${d}`, en: (d: string) => `postponed to ${d}` },
  snoozeFailed: { pl: (err: string) => `Nie odłożono: ${err}`, en: (err: string) => `Not postponed: ${err}` },
  needsSignal: { pl: "Nie zapisano: starszy serwer wymaga otwartego sygnału", en: "Not saved: an older server needs an open signal" },

  // rail row menu
  actions: { pl: "Akcje", en: "Actions" },
  actionsAria: { pl: (name: string) => `Akcje: ${name}`, en: (name: string) => `Actions: ${name}` },
  note: { pl: "Zanotuj", en: "Record" },
  ack: { pl: "Potwierdź", en: "Acknowledge" },
  snooze: { pl: "Odłóż", en: "Snooze" },
  toDate: { pl: (d: string) => `do ${d}`, en: (d: string) => `to ${d}` },
  all: { pl: "Wszystkie", en: "All" },
  plusAcked: {
    pl: (n: number) => plCount(n, "sygnał potwierdzony", "sygnały potwierdzone", "sygnałów potwierdzonych"),
    en: (n: number) => `${enCount(n, "signal", "signals")} acknowledged`,
  },

  // dialog
  signalsCount: { pl: (n: number) => plCount(n, "sygnał", "sygnały", "sygnałów"), en: (n: number) => enCount(n, "signal", "signals") },
  decided: {
    pl: (n: number) => plCount(n, "rozstrzygnięty", "rozstrzygnięte", "rozstrzygniętych"),
    en: (n: number) => `${n} decided`,
  },
  filter: { pl: "Filtr sygnałów", en: "Signal filter" },
  chancesN: { pl: (n: number) => `Szanse ${n}`, en: (n: number) => `Opportunities ${n}` },
  risksN: { pl: (n: number) => `Ryzyka ${n}`, en: (n: number) => `Risks ${n}` },
  keysHint: { pl: "j / k: następny · Enter: decyzja", en: "j / k: next · Enter: decision" },
  closeEsc: { pl: "Zamknij (Esc)", en: "Close (Esc)" },
  undecided: { pl: "bez decyzji:", en: "undecided:" },
  expired: {
    pl: (n: number) => plCount(n, "sygnał wygasł", "sygnały wygasły", "sygnałów wygasło"),
    en: (n: number) => `${enCount(n, "signal", "signals")} expired`,
  },
  journal: { pl: "dziennik", en: "journal" },

  // group actions, rows
  oneDecisionFor: {
    pl: (n: number) => `Jedna decyzja dla ${plCount(n, "sygnału", "sygnałów", "sygnałów")}`,
    en: (n: number) => `One decision for ${enCount(n, "signal", "signals")}`,
  },
  acksN: {
    pl: (n: number) => `Potwierdza ${plCount(n, "sygnał", "sygnały", "sygnałów")}`,
    en: (n: number) => `Acknowledges ${enCount(n, "signal", "signals")}`,
  },
  recordDecision: { pl: "Zanotuj decyzję", en: "Record a decision" },
  thesis: { pl: "Teza", en: "Thesis" },
  exit: { pl: (plan: string) => `wyjście ${plan}`, en: (plan: string) => `exit ${plan}` },
  backInSummary: { pl: " · wraca w podsumowaniu", en: " · comes back in the summary" },
  undo: { pl: "cofnij", en: "undo" },
  snoozedTag: { pl: "odłożono", en: "postponed" },
  snoozeTo: { pl: (d: string) => `Odłóż do ${d}`, en: (d: string) => `Postpone to ${d}` },
  noteLink: { pl: "notatka", en: "note" },

  // decision form
  decision: { pl: "Decyzja", en: "Decision" },
  actNone: { pl: "Nic", en: "Nothing" },
  actBuy: { pl: "Dokupuję", en: "Buying" },
  actSell: { pl: "Sprzedaję", en: "Selling" },
  actLater: { pl: "Odkładam", en: "Postponing" },
  quantity: { pl: "Ilość", en: "Quantity" },
  price: { pl: "Cena", en: "Price" },
  accountLabel: { pl: "Rachunek", en: "Account" },
  youHave: { pl: (q: string) => `Masz ${q} szt.`, en: (q: string) => `You have ${q} units.` },
  why: { pl: "Dlaczego?", en: "Why?" },
  reasonAria: { pl: "Powód decyzji", en: "Reason for the decision" },
  saveDecision: { pl: "Zapisz decyzję", en: "Save the decision" },
  collapse: { pl: "Zwiń", en: "Collapse" },
  noOrders: { pl: "Aplikacja nie składa zleceń: transakcję zapiszesz po wykonaniu.", en: "The app places no orders: record the transaction once it is done." },
});
