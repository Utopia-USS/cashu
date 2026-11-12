// The profile sheet: the device's profiles, this phone's settings, what waits on the Mac. PL + EN.
import { catalog, enCount, plCount } from "@cashu/i18n";

export const S = catalog({
  title: { pl: "Profile i ten telefon", en: "Profiles and this phone" },
  close: { pl: "Zamknij", en: "Close" },
  profiles: { pl: "Profile", en: "Profiles" },
  current: {
    pl: (name: string) => `${name}, wybrany profil`,
    en: (name: string) => `${name}, current profile`,
  },
  pickProfile: {
    pl: (name: string) => `Przełącz na profil ${name}`,
    en: (name: string) => `Switch to profile ${name}`,
  },
  couldNotSwitch: {
    pl: "Nie udało się przełączyć profilu. Spróbuj jeszcze raz.",
    en: "Could not switch the profile. Try again.",
  },
  moduleBudget: { pl: "Budżet", en: "Budget" },
  moduleAssets: { pl: "Majątek", en: "Assets" },
  moduleLoans: { pl: "Kredyty", en: "Loans" },
  moduleInvestments: { pl: "Inwestycje", en: "Investments" },
  thisPhone: { pl: "Ten telefon", en: "This phone" },
  hideAmounts: { pl: "Ukryj kwoty", en: "Hide amounts" },
  hideAmountsSub: {
    pl: "Kwoty zamieniają się w banany; nazwy i procenty zostają",
    en: "Money becomes bananas; names and percentages stay",
  },
  waitingOnMac: { pl: "Czeka na ciebie na Macu", en: "Waiting for you on the Mac" },
  nothingWaiting: { pl: "Nic nie czeka", en: "Nothing waiting" },
  proposals: {
    pl: (n: number) => `${plCount(n, "propozycja", "propozycje", "propozycji")} do zatwierdzenia`,
    en: (n: number) => `${enCount(n, "suggestion", "suggestions")} to approve`,
  },
  macOnly: {
    pl: "Wszystko, co tworzy lub zmienia konfigurację - importy, zatwierdzenia, reguły, strategia - zostaje na Macu.",
    en: "Everything that builds or changes the setup - imports, approvals, rules, strategy - stays on the Mac.",
  },
  version: {
    pl: (version: string) => `cashU ${version}`,
    en: (version: string) => `cashU ${version}`,
  },
  diagnostics: { pl: "Diagnostyka", en: "Diagnostics" },
  bench: { pl: "Pomiar listy", en: "Bench" },
});
