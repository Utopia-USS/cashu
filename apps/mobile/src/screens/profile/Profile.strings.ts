// The profile sheet: the device's profiles, this phone's settings, what waits on the Mac. PL + EN.
import { catalog, enCount, plCount } from "@cashu/i18n";
import type { LockCapability } from "../../shell/auth";

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
  notifications: { pl: "Powiadomienia", en: "Notifications" },
  notificationsOff: { pl: "Wyłączone w Ustawieniach iOS", en: "Off in iOS Settings" },
  hideAmounts: { pl: "Ukryj kwoty", en: "Hide amounts" },
  hideAmountsSub: {
    pl: "Kwoty zamieniają się w banany; nazwy i procenty zostają",
    en: "Money becomes bananas; names and percentages stay",
  },
  // The app lock's switch, named by what the phone checks with (Face ID until that is known).
  lockLabel: {
    pl: (capability: LockCapability | null): string => {
      if (capability === "fingerprint") return "Touch ID przy otwarciu";
      if (capability === "passcode") return "Kod przy otwarciu";
      return "Face ID przy otwarciu";
    },
    en: (capability: LockCapability | null): string => {
      if (capability === "fingerprint") return "Touch ID to open";
      if (capability === "passcode") return "Passcode to open";
      return "Face ID to open";
    },
  },
  lockNoneSub: {
    pl: "Najpierw ustaw Face ID lub kod w Ustawieniach iOS",
    en: "Set up Face ID or a passcode in iOS Settings first",
  },
  waitingOnMac: { pl: "Czeka na Ciebie na Macu", en: "Waiting for you on the Mac" },
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
  thisIphone: { pl: "Ten iPhone", en: "This iPhone" },
  // Pairing rows (#23.4, #23.8).
  pairAnother: { pl: "Połącz kolejny profil", en: "Pair another profile" },
  pairAnotherSub: {
    pl: "Zeskanuj kod z Ustawień > Urządzenia na Macu",
    en: "Scan the code from Settings > Devices on your Mac",
  },
  pairFirst: { pl: "Połącz z Makiem", en: "Pair with your Mac" },
  roleTitle: { pl: "Czyj to telefon", en: "Whose phone" },
  roleMine: { pl: "Ten telefon jest mój", en: "This phone is mine" },
  rolePartner: { pl: "To telefon partnera lub partnerki", en: "This phone is my partner's" },
  paired: {
    pl: (day: string, by: string | null) =>
      by === null ? `dodany ${day}` : `dodany ${day} · z urządzenia „${by}”`,
    en: (day: string, by: string | null) =>
      by === null ? `added ${day}` : `added ${day} by ${by}`,
  },
  unavailableTitle: { pl: "Nie otwiera się", en: "Doesn't open" },
  demoData: { pl: "dane demo", en: "demo data" },
  removePhone: { pl: "Usuń ten telefon", en: "Remove this phone" },
  removePhoneSub: { pl: "Usuwa kopię z tego telefonu", en: "Deletes the copy on this phone" },
  removeTitle: { pl: "Usunąć ten telefon?", en: "Remove this phone?" },
  removeBody: {
    pl: "Kopia Twoich profili na tym telefonie zostanie usunięta. Na Macu wszystko zostanie.",
    en: "The copy of your profiles on this phone is deleted. Your Mac keeps everything.",
  },
  cancel: { pl: "Anuluj", en: "Cancel" },
  remove: { pl: "Usuń", en: "Remove" },
  removeFailed: {
    pl: "Nie udało się usunąć wszystkiego z tego telefonu. Spróbuj jeszcze raz.",
    en: "Could not delete everything on this phone. Try again.",
  },
  diagnostics: { pl: "Diagnostyka", en: "Diagnostics" },
  bench: { pl: "Pomiar listy", en: "Bench" },
});
