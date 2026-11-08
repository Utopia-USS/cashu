// Texts of the home rail (frontend/src/modules/investments/v2/HomeRail.tsx). See docs/agents/localization.md.
import { catalog, enCount, plCount, plForm } from "../../index.js";

export const S = catalog({
  /** The one rail card's name (its sections are regions named Sygnały, Alerty, Kandydaci: no section word here). */
  rail: { pl: "Panel boczny", en: "Side panel" },
  signals: { pl: "Sygnały", en: "Signals" },
  alerts: { pl: "Alerty", en: "Alerts" },
  nothingNew: { pl: "Nic nowego od przeglądu.", en: "Nothing new since the review." },
  // Sygnały: rows
  snoozedTo: {
    pl: (day: string) => `odłożone do ${day}`,
    en: (day: string) => `put off until ${day}`,
  },
  undecided: { pl: "bez decyzji", en: "no decision" },
  // Sygnały: the groups say what they hold: new since the review, or put off in it (the review counts everything).
  newRisk: { pl: "Nowe ryzyka", en: "New risks" },
  newChance: { pl: "Nowe szanse", en: "New opportunities" },
  newMixed: { pl: "Nowe do przejrzenia", en: "New to review" },
  newPlan: { pl: "Nowe w toku", en: "New in progress" },
  putOff: { pl: "Odłożone w przeglądzie", en: "Put off in the review" },
  // The review's breakdown (the hero button's popover, reviewSlotModel.ts)
  reviewItems: {
    pl: (n: number) => plCount(n, "sprawa do decyzji", "sprawy do decyzji", "spraw do decyzji"),
    en: (n: number) => `${enCount(n, "item", "items")} to decide`,
  },
  pillRisk: {
    pl: (n: number) => plCount(n, "ryzyko", "ryzyka", "ryzyk"),
    en: (n: number) => enCount(n, "risk", "risks"),
  },
  pillChance: {
    pl: (n: number) => plCount(n, "szansa", "szanse", "szans"),
    en: (n: number) => enCount(n, "opportunity", "opportunities"),
  },
  pillMixed: { pl: (n: number) => `${n} do przejrzenia`, en: (n: number) => `${n} to review` },
  pillFix: { pl: (n: number) => `${n} do poprawy`, en: (n: number) => `${n} to fix` },
  planNotCounted: {
    pl: (n: number) => `${n} w toku, poza liczbą`,
    en: (n: number) => `${n} in progress, not counted`,
  },
  pillProposal: {
    pl: (n: number) => plCount(n, "propozycja", "propozycje", "propozycji"),
    en: (n: number) => enCount(n, "proposal", "proposals"),
  },
  all: { pl: (n: number) => `Wszystkie (${n})`, en: (n: number) => `All (${n})` },
  // Alerty
  noneClose: {
    pl: (n: number) =>
      `Nic blisko progu. ${n ? `Pilnujesz ${plCount(n, "alertu", "alertów", "alertów")}.` : "Brak alertów."}`,
    en: (n: number) =>
      `Nothing close to its level. ${n ? `Watching ${enCount(n, "alert", "alerts")}.` : "No alerts."}`,
  },
  close: { pl: "blisko", en: "close" },
  fired: { pl: "zadziałał", en: "fired" },
  closeN: { pl: (n: number) => `${n} blisko`, en: (n: number) => `${n} close` },
  firedN: {
    pl: (n: number) => `${n} ${plForm(n, "zadziałał", "zadziałały", "zadziałało")}`,
    en: (n: number) => `${n} fired`,
  },
  stateAria: {
    pl: (tag: string, state: string) => `${tag}, ${state}`,
    en: (tag: string, state: string) => `${tag}, ${state}`,
  },
});
