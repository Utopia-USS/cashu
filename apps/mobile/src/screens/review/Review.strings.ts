// The weekly review deck (full-screen modal): the chrome, each card's eyebrow, title and labels, the
// decide card's choices and the summary. PL + EN. Choice words match the alert sheet's.
import { catalog, enCount, enForm, plCount, plForm } from "@cashu/i18n";

export const S = catalog({
  weeklyReview: { pl: "Przegląd tygodnia", en: "Weekly review" },
  close: { pl: "Zamknij bez zapisu", en: "Close without saving" },
  back: { pl: "Poprzednia karta", en: "Previous card" },
  stepOf: {
    pl: (step: number, total: number) => `${step} / ${total}`,
    en: (step: number, total: number) => `${step} / ${total}`,
  },
  flag: { pl: "Wróć do tego", en: "Come back to this" },
  keep: { pl: "Jasne, dalej", en: "Got it, next" },
  saveAndNext: { pl: "Zapisz i dalej", en: "Save and next" },
  couldNotSave: {
    pl: "Nie udało się zapisać. Spróbuj jeszcze raz.",
    en: "Could not save. Try again.",
  },
  unavailable: { pl: "Przegląd jest teraz niedostępny", en: "The review is not available now" },
  unavailableBody: {
    pl: "Telefon potrzebuje strategii z Maca i notowań. Spróbuj, gdy pobiorą się ceny.",
    en: "The phone needs the strategy from your Mac and prices. Try again once prices are in.",
  },

  // world
  eyebrowWorld: { pl: "Świat w tym tygodniu", en: "The world this week" },
  worldUp: { pl: "Portfel w górę", en: "Your portfolio rose" },
  worldDown: { pl: "Portfel w dół", en: "Your portfolio fell" },
  worldCalmUp: { pl: "Spokojny tydzień na plusie", en: "A calm week, up" },
  worldCalmDown: { pl: "Spokojny tydzień na minusie", en: "A calm week, down" },
  worldStrongUp: { pl: "Mocny wzrost", en: "A strong rise" },
  worldStrongDown: { pl: "Mocny spadek", en: "A strong fall" },
  worldRareUp: { pl: "Rzadko spotykany wzrost", en: "A rare rise" },
  worldRareDown: { pl: "Rzadko spotykany spadek", en: "A rare fall" },
  vsInline: { pl: "tak jak rynek", en: "in line with the market" },
  vsWorse: { pl: "słabiej niż rynek", en: "behind the market" },
  vsBetter: { pl: "lepiej niż rynek", en: "ahead of the market" },
  worldTitle: {
    pl: (base: string, vs: string | null) => (vs === null ? base : `${base}, ${vs}`),
    en: (base: string, vs: string | null) => (vs === null ? base : `${base}, ${vs}`),
  },
  yourPortfolio: { pl: "Twój portfel", en: "Your portfolio" },
  theMarket: { pl: "Rynek", en: "The market" },
  fromHigh: { pl: "Od szczytu z 12 mies.", en: "From the 12-month high" },
  typicalWeek: { pl: "Typowy tydzień (±)", en: "A typical week (±)" },
  inMoney: { pl: "Zmiana wartości", en: "Change in value" },
  maxDrawdown: {
    pl: "Największe obsunięcie w roku",
    en: "Largest drawdown this year",
  },

  // sectors
  eyebrowSectors: { pl: "Sektory", en: "Sectors" },
  sectorsEmpty: { pl: "Sektory bez większych ruchów", en: "No sector moved much" },
  sectorsAllPlus: { pl: "Wszystkie sektory na plusie", en: "Every sector rose" },
  sectorsAllMinus: { pl: "Wszystkie sektory na minusie", en: "Every sector fell" },
  sectorsShare: {
    pl: (names: string) => `Tydzień zrobił głównie: ${names}`,
    en: (names: string) => `${names} carried the week`,
  },
  sectorsSpread: { pl: "Sektory rozjechały się", en: "The sectors went different ways" },
  currencyRow: { pl: "Kursy walut", en: "Exchange rates" },
  contributionHint: {
    pl: "ile punktów procentowych wyniku portfela dał sektor",
    en: "percentage points of the portfolio's result per sector",
  },
  weight: { pl: "waga", en: "weight" },

  // positions
  eyebrowPositions: { pl: "Twoje pozycje", en: "Your positions" },
  positionsTitle: {
    pl: (moved: number, total: number) =>
      `${moved} z ${total} pozycji ${plForm(moved, "ruszyła", "ruszyły", "ruszyło")} się o ponad 3%`,
    en: (moved: number, total: number) =>
      `${moved} of ${enCount(total, "position", "positions")} moved more than 3%`,
  },
  down: { pl: "W dół", en: "Down" },
  up: { pl: "W górę", en: "Up" },

  // events
  eyebrowEvents: { pl: "Wiadomości o Twoich pozycjach", en: "News that touches you" },
  eventsWeakened: {
    pl: (subject: string) => `${subject}: obraz się pogorszył`,
    en: (subject: string) => `${subject}: the picture weakened`,
  },
  eventsTitle: {
    pl: (n: number) => `${plCount(n, "wiadomość", "wiadomości", "wiadomości")} w tym tygodniu`,
    en: (n: number) => `${enCount(n, "news item", "news items")} this week`,
  },
  relInvalidates: { pl: "podważa tezę", en: "invalidates the thesis" },
  relWeakens: { pl: "osłabia tezę", en: "weakens the thesis" },
  relSupports: { pl: "wzmacnia tezę", en: "supports the thesis" },
  relFulfills: { pl: "teza się spełnia", en: "fulfills the thesis" },
  riskBrief: { pl: "Ryzyko na rynkach", en: "Market risk" },
  fullNoteOnMac: {
    pl: "Pełne notatki są na Macu",
    en: "The full notes are on your Mac",
  },

  // ideas
  eyebrowIdeas: {
    pl: (n: number): string => (n === 1 ? "Pomysł spoza portfela" : "Pomysły spoza portfela"),
    en: (n: number): string =>
      n === 1 ? "An idea outside the portfolio" : "Ideas outside the portfolio",
  },
  ideasTitle: {
    pl: (n: number) => plCount(n, "pomysł", "pomysły", "pomysłów"),
    en: (n: number) => enCount(n, "idea", "ideas"),
  },
  watch: { pl: "Obserwuj", en: "Watch" },
  notInterested: { pl: "Nie interesuje mnie", en: "Not interested" },
  watchOnMac: { pl: "Obserwowanie ustawisz na Macu", en: "Watch it on your Mac" },
  watching: { pl: "Obserwujesz", en: "Watching" },
  dismissed: { pl: "Odrzucony", en: "Dismissed" },
  ideasSource: {
    pl: "Z kandydatów researchu · to nie jest rekomendacja",
    en: "From the research candidates · not a recommendation",
  },

  // calendar
  eyebrowCalendar: { pl: "Najbliższe dni", en: "Coming up" },
  calendarTitle: {
    pl: (n: number) =>
      `${plCount(n, "data dotyczy", "daty dotyczą", "dat dotyczy")} Twojego portfela`,
    en: (n: number) => `${enCount(n, "date touches", "dates touch")} your portfolio`,
  },

  // decide
  eyebrowDecide: {
    pl: (n: number): string => (n === 1 ? "Czeka na decyzję" : "Czekają na decyzję"),
    en: (n: number): string => (n === 1 ? "A decision waiting" : "Decisions waiting"),
  },
  decideOne: {
    pl: (title: string) => `${title}: co robisz?`,
    en: (title: string) => `${title}: what do you do?`,
  },
  decideMany: {
    pl: (n: number) =>
      `${plCount(n, "sprawa czeka", "sprawy czekają", "spraw czeka")} na Twoją decyzję`,
    en: (n: number) => `${n} ${enForm(n, "item waits", "items wait")} for your decision`,
  },
  choiceHeld: { pl: "Nic", en: "Nothing" },
  choiceBought: { pl: "Dokupię", en: "Buy more" },
  choiceSold: { pl: "Sprzedam", en: "Sell" },
  yourDecision: { pl: "Twoja decyzja", en: "Your decision" },
  reason: { pl: "Dlaczego? (opcjonalnie)", en: "Why? (optional)" },
  waitsOnMac: { pl: "Czeka na Ciebie na Macu", en: "Waits on your Mac" },
  saved: { pl: "Zapisane", en: "Saved" },
  decisionIsANote: {
    pl: "Decyzja to notatka w Twoim dzienniku. cashU nigdy nie składa zleceń.",
    en: "A decision is a note in your journal. cashU never places a trade.",
  },

  // summary
  eyebrowSummary: { pl: "Podsumowanie", en: "Summary" },
  reviewDone: { pl: "Przegląd zrobiony", en: "Review done" },
  savedTitle: { pl: "Zapisano", en: "Saved" },
  cardsClear: {
    pl: (n: number) => `${plCount(n, "karta", "karty", "kart")} bez uwag`,
    en: (n: number) => `${enCount(n, "card", "cards")} clear`,
  },
  cardsWaitOnMac: {
    pl: (n: number) =>
      `${plCount(n, "karta czeka", "karty czekają", "kart czeka")} na Ciebie na Macu`,
    en: (n: number) => `${enCount(n, "card waits", "cards wait")} for you on your Mac`,
  },
  decisionLine: {
    pl: (title: string, choice: string) => `${title}: ${choice}`,
    en: (title: string, choice: string) => `${title}: ${choice}`,
  },
  noDecisionYet: { pl: "bez decyzji", en: "no decision yet" },
  skipped: {
    pl: (list: string) => `Pominięte w tym tygodniu: ${list}`,
    en: (list: string) => `Skipped this week: ${list}`,
  },
  markDone: { pl: "Oznacz przegląd jako zrobiony", en: "Mark review done" },
  done: { pl: "Gotowe", en: "Done" },

  // card names (the skipped line)
  cardWorld: { pl: "świat", en: "the world" },
  cardSectors: { pl: "sektory", en: "sectors" },
  cardPositions: { pl: "pozycje", en: "positions" },
  cardEvents: { pl: "wiadomości", en: "news" },
  cardIdeas: { pl: "pomysły", en: "ideas" },
  cardCalendar: { pl: "kalendarz", en: "calendar" },
  cardDecide: { pl: "decyzje", en: "decisions" },
});
