// Texts of the home rail (src/modules/investments/v2/HomeRail.tsx). See src/i18n.ts.
import { catalog, enCount, plCount, plForm } from "../../../i18n.ts";

// The adjective follows the noun's form (2-4, 22-24: "nowe sprawy"; 5-21, 25-31: "nowych spraw").
const plNew = (n: number) => (n === 1 ? "jedna nowa sprawa" : `${n} ${plForm(n, "nowa sprawa", "nowe sprawy", "nowych spraw")}`);

export const S = catalog({
  signals: { pl: "Sygnały", en: "Signals" },
  alerts: { pl: "Alerty", en: "Alerts" },
  // Sygnały: the lead sentence
  leadNewDue: {
    pl: (n: number) => `Od przeglądu ${plNew(n)}.`,
    en: (n: number) => `${n === 1 ? "One new item" : `${n} new items`} since the review.`,
  },
  decisionsWait: { pl: " Decyzje czekają w przeglądzie.", en: " Decisions wait in the review." },
  leadLeft: {
    pl: (n: number) => `${n === 1 ? "Jedna sprawa odłożona" : `${n} ${plForm(n, "sprawa odłożona", "sprawy odłożone", "spraw odłożonych")}`} w przeglądzie.`,
    en: (n: number) => `${n === 1 ? "One item" : `${n} items`} put off in the review.`,
  },
  andNew: { pl: (n: number) => ` Do tego ${plNew(n)}.`, en: (n: number) => ` Plus ${n === 1 ? "one new item" : `${n} new items`}.` },
  nothingNew: { pl: "Nic nowego od przeglądu.", en: "Nothing new since the review." },
  reviewWaits: { pl: " Przegląd czeka.", en: " The review is due." },
  nextReview: { pl: (day: string) => ` Następny ${day}.`, en: (day: string) => ` Next on ${day}.` },
  // Sygnały: rows
  snoozedTo: { pl: (day: string) => `odłożone do ${day}`, en: (day: string) => `put off until ${day}` },
  undecided: { pl: "bez decyzji", en: "no decision" },
  // Sygnały: the review box
  reviewItems: { pl: (n: number) => plCount(n, "sprawa do decyzji", "sprawy do decyzji", "spraw do decyzji"), en: (n: number) => `${enCount(n, "item", "items")} to decide` },
  openReview: { pl: "Otwórz przegląd", en: "Open the review" },
  pillRisk: { pl: (n: number) => plCount(n, "ryzyko", "ryzyka", "ryzyk"), en: (n: number) => enCount(n, "risk", "risks") },
  pillChance: { pl: (n: number) => plCount(n, "szansa", "szanse", "szans"), en: (n: number) => enCount(n, "opportunity", "opportunities") },
  pillMixed: { pl: (n: number) => `${n} do przejrzenia`, en: (n: number) => `${n} to review` },
  pillPlan: { pl: (n: number) => `${n} w toku`, en: (n: number) => `${n} in progress` },
  pillFix: { pl: (n: number) => `${n} do poprawy`, en: (n: number) => `${n} to fix` },
  pillProposal: { pl: (n: number) => plCount(n, "propozycja", "propozycje", "propozycji"), en: (n: number) => enCount(n, "proposal", "proposals") },
  // Sygnały: footer
  unchanged: { pl: (n: number) => `${n} bez zmian`, en: (n: number) => `${n} unchanged` },
  all: { pl: (n: number) => `Wszystkie (${n})`, en: (n: number) => `All (${n})` },
  // Alerty
  addNew: { pl: "+ Nowy", en: "+ New" },
  noneClose: {
    pl: (n: number) => `Nic blisko progu. ${n ? `Pilnujesz ${plCount(n, "alertu", "alertów", "alertów")}.` : "Brak alertów."}`,
    en: (n: number) => `Nothing close to its level. ${n ? `Watching ${enCount(n, "alert", "alerts")}.` : "No alerts."}`,
  },
  close: { pl: "blisko", en: "close" },
  fired: { pl: "zadziałał", en: "fired" },
  stateAria: { pl: (tag: string, state: string) => `${tag}, ${state}`, en: (tag: string, state: string) => `${tag}, ${state}` },
});
