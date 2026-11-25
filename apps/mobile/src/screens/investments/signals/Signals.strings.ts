// The Investments tab's Signals view: what fired since the last review, the price levels close by, the
// strategy's rules, research and the recent decisions. PL + EN (glossary: Sygnał = Signal, Alert = Alert,
// Reguła = Rule, Teza = Thesis, Decyzja = Decision).
import { catalog, enCount, plCount } from "@cashu/i18n";

export const S = catalog({
  sinceReview: {
    pl: (date: string) => `Nowe od przeglądu z ${date}`,
    en: (date: string) => `New since your review on ${date}`,
  },
  sinceLastWeek: { pl: "Nowe w ostatnim tygodniu", en: "New in the last week" },
  fired: { pl: "Zadziałały", en: "Fired" },
  yourAlerts: { pl: "Twoje alerty", en: "your alerts" },
  fell: {
    pl: (name: string, pct: string, days: number) =>
      `${name}: spadek o ${pct} w ciągu ${days} sesji`,
    en: (name: string, pct: string, days: number) =>
      `${name} fell ${pct} in ${enCount(days, "session", "sessions")}`,
  },
  rose: {
    pl: (name: string, pct: string, days: number) =>
      `${name}: wzrost o ${pct} w ciągu ${days} sesji`,
    en: (name: string, pct: string, days: number) =>
      `${name} rose ${pct} in ${enCount(days, "session", "sessions")}`,
  },
  risk: { pl: "ryzyko", en: "risk" },
  opportunity: { pl: "szansa", en: "opportunity" },
  signal: { pl: "sygnał", en: "signal" },
  waitingForDecision: { pl: "czeka na decyzję", en: "waiting for a decision" },
  noted: {
    pl: (name: string) => `${name}: zanotowane`,
    en: (name: string) => `${name} - noted`,
  },
  decideLater: {
    pl: "Zdecydujesz później - wróci w przeglądzie",
    en: "Decide later - back in your review",
  },
  /** A fired alert's row; `marked`: its bell tells this phone when it fires. */
  openAlert: {
    pl: (title: string, marked: boolean) =>
      `${title}${marked ? ", powiadomienia włączone" : ""}, zdecyduj`,
    en: (title: string, marked: boolean) => `${title}${marked ? ", notifications on" : ""}, decide`,
  },
  near: { pl: "Blisko Twoich poziomów", en: "Close to your levels" },
  prices: { pl: "notowania", en: "prices" },
  alertBelow: {
    pl: (level: string) => `alert poniżej ${level}`,
    en: (level: string) => `alert below ${level}`,
  },
  alertAbove: {
    pl: (level: string) => `alert powyżej ${level}`,
    en: (level: string) => `alert above ${level}`,
  },
  away: {
    pl: (pct: string) => `${pct} od poziomu`,
    en: (pct: string) => `${pct} away`,
  },
  fromRules: { pl: "Z Twoich reguł", en: "From your rules" },
  fromResearch: { pl: "Z researchu", en: "From research" },
  weakens: { pl: "osłabia Twoją tezę", en: "weakens your thesis" },
  invalidates: { pl: "podważa Twoją tezę", en: "invalidates your thesis" },
  supports: { pl: "wzmacnia", en: "supports" },
  background: { pl: "tło", en: "background" },
  nSources: {
    pl: (n: number) => plCount(n, "źródło", "źródła", "źródeł"),
    en: (n: number) => enCount(n, "source", "sources"),
  },
  openNote: {
    pl: (title: string) => `${title}, otwórz notatkę`,
    en: (title: string) => `${title}, open the note`,
  },
  decisions: { pl: "Twoje ostatnie decyzje", en: "Your recent decisions" },
  quoted: {
    pl: (text: string) => `„${text}”`,
    en: (text: string) => `“${text}”`,
  },
  action_bought: { pl: "dokupione", en: "bought more" },
  action_sold: { pl: "sprzedane", en: "sold" },
  action_held: { pl: "bez zmian", en: "nothing" },
  action_ignored: { pl: "pominięte", en: "ignored" },
  action_other: { pl: "inna decyzja", en: "other" },
  portfolio: { pl: "Portfel", en: "Portfolio" },
  nothingNew: { pl: "Nic nowego", en: "Nothing new" },
  alertsRunOnMac: {
    pl: "Alerty i reguły ustawiasz na Macu i tam sprawdzają się raz dziennie.",
    en: "Alerts and rules are set up on the Mac, and they run there once a day.",
  },
  unavailable: {
    pl: "Sygnałów nie da się teraz odczytać na tym telefonie.",
    en: "Signals cannot be read on this phone right now.",
  },
});
