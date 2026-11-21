// The app shell: tab labels, the tab header (profile pill, eye button, freshness line) and the
// app-switcher cover. PL + EN.
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
  // The phone's own fetch of market prices (never "live": the time is when this phone fetched them).
  pricesFrom: {
    pl: (when: string) => `Notowania z ${when} · pobrane przez ten telefon`,
    en: (when: string) => `Prices from ${when} · fetched by this phone`,
  },
  pricesNotYet: { pl: "Notowań jeszcze nie pobrano", en: "Prices not fetched yet" },
});
