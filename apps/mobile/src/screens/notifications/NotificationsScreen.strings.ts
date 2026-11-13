// The notifications settings screen (prototype `notifs`): what this phone may tell the user and when,
// per profile. PL + EN. The text of the notifications themselves is `src/notifications/Notifications.strings.ts`.
import { catalog, enCount, plCount, plForm } from "@cashu/i18n";

export const S = catalog({
  title: { pl: "Powiadomienia", en: "Notifications" },
  allow: { pl: "Włącz powiadomienia", en: "Allow notifications" },
  denied: {
    pl: "Powiadomienia cashU są wyłączone w Ustawieniach iOS.",
    en: "Notifications are off for cashU in iOS Settings.",
  },
  openSettings: { pl: "Otwórz Ustawienia", en: "Open Settings" },
  whenSynced: { pl: "Przy najbliższej synchronizacji", en: "When the phone next syncs" },
  markedAlerts: {
    pl: "Alerty oznaczone dzwonkiem",
    en: "Alerts you mark “tell my phone”",
  },
  noMarkedAlerts: {
    pl: "Oznacz alert dzwonkiem na jego karcie",
    en: "Mark an alert in its sheet",
  },
  deviceChanges: { pl: "Urządzenie dołącza lub się odłącza", en: "A device joins or leaves" },
  deviceChangesSub: {
    pl: "Dla bezpieczeństwa - zawsze włączone",
    en: "For safety - always on",
  },
  digests: { pl: "Podsumowania", en: "Digests" },
  weekly: {
    pl: (time: string) => `W niedzielę o ${time}`,
    en: (time: string) => `Sunday, ${time}`,
  },
  weeklySub: {
    pl: (review: boolean) =>
      `Tydzień w jednym zdaniu, rachunki na przyszły tydzień${review ? ", termin przeglądu" : ""}.`,
    en: (review: boolean) =>
      `The week in one line, next week's bills${review ? ", review due" : ""}.`,
  },
  monthClosed: { pl: "Zamknięcie miesiąca", en: "Month closed" },
  monthClosedSub: {
    pl: (plan: boolean) => `Ile Ci zostało${plan ? " i co na to Twój plan" : ""}.`,
    en: (plan: boolean) => `What you kept${plan ? " and what your plan says" : ""}.`,
  },
  evening: {
    pl: (time: string) => `Wieczorem o ${time}`,
    en: (time: string) => `Evening, ${time}`,
  },
  eveningSub: {
    pl: "Rachunki na jutro i płatności bez kategorii. Nie przychodzi, gdy nie ma nic do zrobienia.",
    en: "Bills due tomorrow, payments to categorize. Skipped when empty.",
  },
  warnings: { pl: "Jednorazowe ostrzeżenia", en: "Warnings, once" },
  staleData: { pl: "Dane z banku się starzeją", en: "Bank data is getting old" },
  staleDataSub: {
    pl: (hours: number) =>
      `Po ${hours} ${plForm(hours, "godzinie", "godzinach", "godzinach")} bez nowych danych; ponownie tylko, gdy będzie gorzej.`,
    en: (hours: number) =>
      `After ${enCount(hours, "hour", "hours")} without a fetch; again only if it gets worse.`,
  },
  consentEnding: { pl: "Zgoda banku wkrótce wygasa", en: "A bank permission ends soon" },
  consentEndingSub: {
    pl: (first: number, last: number) =>
      `${plCount(first, "dzień", "dni", "dni")} i ${plCount(last, "dzień", "dni", "dni")} wcześniej.`,
    en: (first: number, last: number) =>
      `${enCount(first, "day", "days")} and ${enCount(last, "day", "days")} before.`,
  },
  countsOnly: {
    pl: "Powiadomienia tylko liczą - nigdy nie podają kwot, odbiorców ani nazwisk. Powstają na tym telefonie; przez usługę push nie przechodzi nic, co da się przeczytać.",
    en: "Notifications only count things - never amounts, payees or names. They are written on this phone; nothing readable passes through a push service.",
  },
  neverSent: {
    pl: (agent: boolean) =>
      `Nigdy nie przychodzą: pojedyncze płatności, dzienne zmiany portfela, wiadomości z rynku, ${agent ? "propozycje agenta, " : ""}serie.`,
    en: (agent: boolean) =>
      `Never sent: single payments, daily portfolio moves, market news, ${agent ? "agent suggestions, " : ""}streaks.`,
  },
  preview: { pl: "Podgląd dzisiejszych podsumowań", en: "Preview tonight's digests" },
  previewSub: {
    pl: "Przyjdą za 5 s; zablokuj ekran, żeby je zobaczyć",
    en: "They arrive in 5 s; lock the screen to see them",
  },
});
