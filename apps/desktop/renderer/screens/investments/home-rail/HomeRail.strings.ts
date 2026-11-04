import { catalog } from "@cashu/i18n";

export const H = catalog({
  signals: { pl: "Sygnały", en: "Signals" },
  alerts: { pl: "Alerty", en: "Alerts" },
  hidden: { pl: "Ukryte w trybie prywatnym.", en: "Hidden in privacy mode." },
  unavailable: { pl: "Dane są teraz niedostępne.", en: "Data is currently unavailable." },
  fresh: {
    pl: (n: number) => `Nowe od przeglądu: ${n}`,
    en: (n: number) => `New since the review: ${n}`,
  },
  left: {
    pl: (n: number) => `Odłożone w przeglądzie: ${n}`,
    en: (n: number) => `Put off in the review: ${n}`,
  },
  nothingNew: { pl: "Nic nowego od przeglądu.", en: "Nothing new since the review." },
  reviewWaits: { pl: "Przegląd czeka.", en: "The review is due." },
  nextReview: {
    pl: (day: string) => `Następny przegląd: ${day}.`,
    en: (day: string) => `Next review: ${day}.`,
  },
  risk: { pl: "Ryzyka", en: "Risks" },
  chance: { pl: "Szanse", en: "Opportunities" },
  mixed: { pl: "Do przejrzenia", en: "To review" },
  plan: { pl: "W toku", en: "In progress" },
  fix: { pl: "Do poprawy", en: "To fix" },
  proposal: { pl: "Propozycje", en: "Proposals" },
  reviewItems: { pl: (n: number) => `${n} do decyzji`, en: (n: number) => `${n} to decide` },
  openReview: { pl: "Otwórz przegląd", en: "Open the review" },
  all: { pl: (n: number) => `Wszystkie (${n})`, en: (n: number) => `All (${n})` },
  unchanged: { pl: (n: number) => `${n} bez zmian`, en: (n: number) => `${n} unchanged` },
  snoozedTo: {
    pl: (day: string) => `odłożone do ${day}`,
    en: (day: string) => `put off until ${day}`,
  },
  undecided: { pl: "bez decyzji", en: "no decision" },
  addNew: { pl: "+ Nowy", en: "+ New" },
  noneClose: {
    pl: (n: number) => `Nic blisko progu. Aktywne alerty: ${n}.`,
    en: (n: number) => `Nothing close to its level. Active alerts: ${n}.`,
  },
  near: { pl: "blisko", en: "close" },
  met: { pl: "zadziałał", en: "fired" },
  firedOn: { pl: (day: string) => `od ${day}`, en: (day: string) => `since ${day}` },
  missing: { pl: (gap: string) => `brakuje ${gap}`, en: (gap: string) => `${gap} to go` },
  alertTag: {
    pl: (tag: string, state: string) => `${tag}, ${state}`,
    en: (tag: string, state: string) => `${tag}, ${state}`,
  },
});
