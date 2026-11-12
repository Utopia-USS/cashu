// The app shell: tab labels, the tab header (profile pill, eye button, freshness line), the
// app-switcher cover and the placeholder of the Investments tab until its screens arrive. PL + EN.
import { catalog, enForm, plForm } from "@cashu/i18n";

export const S = catalog({
  appName: { pl: "cashU", en: "cashU" },
  tabToday: { pl: "Dziś", en: "Today" },
  tabActivity: { pl: "Aktywność", en: "Activity" },
  tabInvestments: { pl: "Inwestycje", en: "Investments" },
  // "Wartość netto" per the glossary (Majątek is the Assets module); flagged for the designer's copy pass.
  tabNetWorth: { pl: "Wartość netto", en: "Net worth" },
  openProfile: {
    pl: (name: string) => `Profil ${name}, zmień profil`,
    en: (name: string) => `Profile ${name}, switch profile`,
  },
  hideAmounts: { pl: "Ukryj kwoty", en: "Hide amounts" },
  showAmounts: { pl: "Pokaż kwoty", en: "Show amounts" },
  bankDataFrom: {
    pl: (when: string) => `Dane z banku z ${when}`,
    en: (when: string) => `Bank data from ${when}`,
  },
  bankDataOld: {
    pl: (when: string, hours: number) => {
      const days = Math.floor(hours / 24);
      return `Dane z banku z ${when} · sprzed ${days} ${plForm(days, "dnia", "dni", "dni")}`;
    },
    en: (when: string, hours: number) => {
      const days = Math.floor(hours / 24);
      return `Bank data from ${when} · ${days} ${enForm(days, "day", "days")} old`;
    },
  },
  noBankData: { pl: "Brak danych z banku", en: "No bank data yet" },
  pricesLater: { pl: "Brak notowań", en: "Prices not fetched yet" },
  // TRANSITIONAL(S42b): the Investments tab's placeholder until its screens arrive.
  investmentsSoon: { pl: "Inwestycje już wkrótce", en: "Investments are coming soon" },
});
