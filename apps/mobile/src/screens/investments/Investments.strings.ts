// The Investments tab's shell: the top tabs and the weekly review slot. PL + EN (glossary:
// docs/agents/localization.md: Przegląd = Review, Sygnał = Signal, Strategia = Strategy).
import { catalog, enCount, enForm, plCount, plForm } from "@cashu/i18n";

export const S = catalog({
  title: { pl: "Inwestycje", en: "Investments" },
  views: { pl: "Widok", en: "View" },
  portfolio: { pl: "Portfel", en: "Portfolio" },
  signals: { pl: "Sygnały", en: "Signals" },
  strategy: { pl: "Strategia", en: "Strategy" },
  startReview: { pl: "Zacznij przegląd", en: "Start the review" },
  reviewMeta: {
    pl: (range: string, cards: number, due: string) =>
      `${range} · ${plCount(cards, "karta", "karty", "kart")} · ${due}`,
    en: (range: string, cards: number, due: string) =>
      `${range} · ${enCount(cards, "card", "cards")} · ${due}`,
  },
  dueOn: {
    pl: (weekday: string) => `termin: ${weekday}`,
    en: (weekday: string) => `due ${weekday}`,
  },
  dueToday: { pl: "termin: dziś", en: "due today" },
  dueSince: {
    pl: (date: string) => `czeka od ${date}`,
    en: (date: string) => `due since ${date}`,
  },
  // The teaser's parts, joined into one sentence.
  weekDown: { pl: "Tydzień na minusie", en: "A down week" },
  weekUp: { pl: "Tydzień na plusie", en: "An up week" },
  weekFlat: { pl: "Spokojny tydzień", en: "A quiet week" },
  vsWorse: { pl: "gorzej niż rynek", en: "behind the market" },
  vsBetter: { pl: "lepiej niż rynek", en: "ahead of the market" },
  vsInline: { pl: "tak jak rynek", en: "in line with the market" },
  decisionsWaiting: {
    pl: (n: number) =>
      `${n === 1 ? "jedna decyzja czeka" : `${n} ${plForm(n, "decyzja", "decyzje", "decyzji")} ${plForm(n, "czeka", "czekają", "czeka")}`}`,
    en: (n: number) => `${n === 1 ? "one decision" : `${n} decisions`} waiting`,
  },
  ideasOutside: {
    pl: (n: number) =>
      `${n === 1 ? "jeden pomysł" : `${n} ${plForm(n, "pomysł", "pomysły", "pomysłów")}`} spoza portfela`,
    en: (n: number) =>
      `${n === 1 ? "one idea" : `${n} ${enForm(n, "idea", "ideas")}`} outside the portfolio`,
  },
  reviewDone: { pl: "Przegląd zakończony", en: "Review done" },
  nextOn: {
    pl: (date: string) => `Następny: ${date}`,
    en: (date: string) => `Next one on ${date}`,
  },
  cardsWaitOnMac: {
    pl: (n: number) =>
      `${plCount(n, "karta czeka", "karty czekają", "kart czeka")} na Ciebie na Macu`,
    en: (n: number) => `${enCount(n, "card waits", "cards wait")} on your Mac`,
  },
  undo: { pl: "Cofnij", en: "Undo" },
  undoReview: { pl: "Cofnij zapisany przegląd", en: "Undo the saved review" },
});
