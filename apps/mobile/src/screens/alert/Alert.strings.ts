// The alert sheet: what fired, the position it is about, the thesis and the strategy line next to it, and
// the owner's decision (a journal note, never a trade). The decision labels are shared with the position
// page. PL + EN.
import { catalog, enForm } from "@cashu/i18n";

export const S = catalog({
  close: { pl: "Zamknij", en: "Close" },
  tellPhone: {
    pl: "Powiadamiaj na tym telefonie, gdy zadziała",
    en: "Tell this phone when it fires",
  },
  stopTelling: { pl: "Nie powiadamiaj na tym telefonie", en: "Stop telling this phone" },
  missing: { pl: "Tego alertu już nie ma", en: "This alert is gone" },
  tagRisk: { pl: "Twój alert · ryzyko", en: "Your alert · risk" },
  tagOpportunity: { pl: "Twój alert · szansa", en: "Your alert · opportunity" },
  tagAlert: { pl: "Twój alert", en: "Your alert" },
  tagRule: { pl: "Twoja reguła", en: "Your rule" },
  fell: {
    pl: (name: string, pct: string, days: number) =>
      `${name}: spadek o ${pct} w ciągu ${days} sesji`,
    en: (name: string, pct: string, days: number) =>
      `${name} fell ${pct} in ${days} ${enForm(days, "session", "sessions")}`,
  },
  rose: {
    pl: (name: string, pct: string, days: number) =>
      `${name}: wzrost o ${pct} w ciągu ${days} sesji`,
    en: (name: string, pct: string, days: number) =>
      `${name} rose ${pct} in ${days} ${enForm(days, "session", "sessions")}`,
  },
  below: {
    pl: (name: string, level: string) => `${name}: cena poniżej ${level}`,
    en: (name: string, level: string) => `${name} fell below ${level}`,
  },
  above: {
    pl: (name: string, level: string) => `${name}: cena powyżej ${level}`,
    en: (name: string, level: string) => `${name} rose above ${level}`,
  },
  firedToday: {
    pl: (rule: string, time: string) => `„${rule}” · zadziałał dziś o ${time}`,
    en: (rule: string, time: string) => `“${rule}” · fired today ${time}`,
  },
  firedOn: {
    pl: (rule: string, day: string, time: string) => `„${rule}” · zadziałał ${day} o ${time}`,
    en: (rule: string, day: string, time: string) => `“${rule}” · fired ${day} ${time}`,
  },
  price: { pl: "Cena", en: "Price" },
  priceFrom: { pl: (time: string) => `notowanie z ${time}`, en: (time: string) => `as of ${time}` },
  closeOn: { pl: (day: string) => `zamknięcie ${day}`, en: (day: string) => `close ${day}` },
  yourPosition: { pl: "Twoja pozycja", en: "Your position" },
  ofPortfolio: {
    pl: (pct: string) => `${pct} portfela`,
    en: (pct: string) => `${pct} of the portfolio`,
  },
  result: { pl: "Wynik", en: "Result" },
  averageCost: {
    pl: (cost: string) => `średni koszt ${cost}`,
    en: (cost: string) => `average cost ${cost}`,
  },
  sizePlan: { pl: "Plan wielkości pozycji", en: "Your size plan" },
  yourThesis: { pl: "Twoja teza", en: "Your thesis" },
  wrongIf: { pl: "Błędna, jeśli", en: "Wrong if" },
  researchOn: {
    pl: (day: string) => `Research z ${day}:`,
    en: (day: string) => `Research of ${day}:`,
  },
  strategySays: { pl: "Twoja strategia mówi", en: "Your strategy says" },
  yourDecision: { pl: "Twoja decyzja", en: "Your decision" },
  choiceHeld: { pl: "Nic", en: "Nothing" },
  choiceBought: { pl: "Dokupię", en: "Buy more" },
  choiceSold: { pl: "Sprzedam", en: "Sell" },
  reason: { pl: "Dlaczego? (opcjonalnie)", en: "Why? (optional)" },
  decisionIsANote: {
    pl: "Decyzja to notatka w Twoim dzienniku. cashU nigdy nie składa zleceń.",
    en: "A decision is a note in your journal. cashU never places a trade.",
  },
  later: { pl: "Zdecyduję później", en: "Decide later" },
  save: { pl: "Zapisz decyzję", en: "Save decision" },
  couldNotSave: {
    pl: "Nie udało się zapisać. Spróbuj jeszcze raz.",
    en: "Could not save. Try again.",
  },
  noted: {
    pl: (decision: string, day: string) => `Zapisane: ${decision} · ${day}`,
    en: (decision: string, day: string) => `Noted: ${decision} · ${day}`,
  },
  laterNoted: {
    pl: "Zdecydujesz później - wróci w przeglądzie",
    en: "Decide later - back in your review",
  },
});

/** A journal entry's action as the owner reads it (the alert sheet, the position page). */
export const ACTION = catalog({
  held: { pl: "Na razie nic", en: "Nothing for now" },
  bought: { pl: "Dokupione", en: "Bought more" },
  sold: { pl: "Sprzedane", en: "Sold" },
  ignored: { pl: "Pominięte", en: "Ignored" },
  other: { pl: "Inna decyzja", en: "Other decision" },
});

/**
 * A research note's verdict on the thesis (the alert sheet, the position page, the note reader): the
 * verbs of the desktop's `RELATION_LABEL` (@cashu/ui-logic), without "the thesis" the line already names.
 */
export const RELATION = catalog({
  supports: { pl: "wzmacnia", en: "supports" },
  weakens: { pl: "osłabia", en: "weakens" },
  invalidates: { pl: "podważa", en: "invalidates" },
  fulfills: { pl: "potwierdza", en: "fulfills" },
});
