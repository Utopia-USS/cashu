// Settings > Devices > Sync: the row's switch, details line and status lines, the purge disclosure, the
// paused bank fetch and its override. Designer copy verbatim from dev-feedback #23.7, #25.1-3 and the
// 2026-11-14 addenda (all accepted as written); entries marked "proposed" are this screen's wording and
// wait for the designer's pass. The user never sees "relay". PL + EN.
import { catalog, enForm, plForm } from "@cashu/i18n";
import { formatClockTime } from "@cashu/i18n/values";
import { dayMonthShort } from "@cashu/ui-logic/core/time";

const clockPl = (at: number) => formatClockTime(new Date(at), "pl-PL");
const clockEn = (at: number) => formatClockTime(new Date(at), "en-GB");

export const S = catalog({
  // #23.7.
  title: { pl: "Synchronizacja", en: "Sync" },
  details: {
    pl: "Przez Google Firebase, szyfrowane end-to-end: Google widzi tylko zaszyfrowane dane",
    en: "Through Google Firebase, end-to-end encrypted: Google sees only scrambled data",
  },
  // Clock time, no relative ages (2026-11-14): today with the device count, yesterday and older without.
  syncedToday: {
    pl: (at: number, devices: number) =>
      `Zsynchronizowano o ${clockPl(at)} · ${devices} ${plForm(devices, "urządzenie", "urządzenia", "urządzeń")}`,
    en: (at: number, devices: number) =>
      `Synced at ${clockEn(at)} · ${devices} ${enForm(devices, "device", "devices")}`,
  },
  syncedYesterday: {
    pl: (at: number) => `Zsynchronizowano wczoraj o ${clockPl(at)}`,
    en: (at: number) => `Synced yesterday at ${clockEn(at)}`,
  },
  syncedOn: {
    pl: (at: number) => `Zsynchronizowano ${dayMonthShort(new Date(at), "pl-PL")} o ${clockPl(at)}`,
    en: (at: number) => `Synced ${dayMonthShort(new Date(at), "en-GB")} at ${clockEn(at)}`,
  },
  // Sync on, no pass reached it yet.
  firstSync: {
    pl: (devices: number) =>
      `Czeka na pierwszą synchronizację · ${devices} ${plForm(devices, "urządzenie", "urządzenia", "urządzeń")}`,
    en: (devices: number) =>
      `Waiting for the first sync · ${devices} ${enForm(devices, "device", "devices")}`,
  },
  // #25.2.
  paused: {
    pl: (at: number) => `Synchronizacja wstrzymana od ${clockPl(at)} · cashU działa normalnie`,
    en: (at: number) => `Sync paused since ${clockEn(at)} · cashU works as usual`,
  },
  quota: {
    pl: "Dzisiejszy limit synchronizacji wyczerpany, kolejna próba po północy",
    en: "Today's sync limit is used up, tries again after midnight",
  },
  // #25.3, a writer the device list names.
  stuckWaiting: {
    pl: (device: string) =>
      `Części zmian z urządzenia „${device}” nie da się jeszcze odczytać. Synchronizacja próbuje dalej.`,
    en: (device: string) => `Some changes from ${device} can't be read yet. Sync keeps trying.`,
  },
  stuckFailed: {
    pl: (device: string) =>
      `Nie da się odczytać zmian z urządzenia „${device}”. Sprawdź listę urządzeń poniżej.`,
    en: (device: string) => `Changes from ${device} can't be read. Check the device list below.`,
  },
  // #25.3, a writer the device list cannot name (never an id, never a stand-in inside the quotes).
  stuckWaitingUnnamed: {
    pl: "Części zmian z innego urządzenia nie da się jeszcze odczytać. Synchronizacja próbuje dalej.",
    en: "Some changes from another device can't be read yet. Sync keeps trying.",
  },
  stuckFailedUnnamed: {
    pl: "Nie da się odczytać zmian z innego urządzenia. Sprawdź listę urządzeń poniżej.",
    en: "Changes from another device can't be read. Check the device list below.",
  },
  // Designer addendum (2026-11-14): a removed device whose access sync has not withdrawn yet.
  removalFailing: {
    pl: (device: string) =>
      `Urządzenie „${device}” jest usunięte na tym Macu, ale synchronizacja jeszcze tego nie potwierdziła, więc wciąż może dostawać nowe dane. cashU próbuje dalej.`,
    en: (device: string) =>
      `“${device}” is removed on this Mac, but sync hasn't confirmed it yet, so it can still receive new data. cashU keeps trying.`,
  },
  removalFailingUnnamed: {
    pl: "Usunięte urządzenie jest usunięte na tym Macu, ale synchronizacja jeszcze tego nie potwierdziła, więc wciąż może dostawać nowe dane. cashU próbuje dalej.",
    en: "A removed device is removed on this Mac, but sync hasn't confirmed it yet, so it can still receive new data. cashU keeps trying.",
  },
  tryNow: { pl: "Spróbuj teraz", en: "Try now" },
  // #25.1.
  reconnect: { pl: "Połącz ponownie synchronizację", en: "Reconnect sync" },
  // Identity lost, no recovery secret on this Mac: reconnect cannot help.
  reconnectUnavailable: {
    pl: "Synchronizacja nie może połączyć się ponownie sama. Wyłącz ją i włącz jeszcze raz.",
    en: "Sync can't reconnect on its own. Turn it off and on again.",
  },
  // The purge disclosure and its outcomes.
  purgeDisclosure: {
    pl: "Usuń dane tego profilu z synchronizacji",
    en: "Remove this profile's data from sync",
  },
  purgeHelp: {
    pl: "Synchronizacja tego profilu zostanie wyłączona, a jego zaszyfrowane dane usunięte z Google Firebase. Dane na tym Macu zostają.",
    en: "Sync for this profile is turned off and its encrypted data is removed from Google Firebase. The data on this Mac stays.",
  },
  purge: { pl: "Usuń z synchronizacji", en: "Remove from sync" },
  purgeConfirmTitle: {
    pl: "Usunąć dane tego profilu z synchronizacji?",
    en: "Remove this profile's data from sync?",
  },
  purgeConfirm: { pl: "Tak, usuń", en: "Yes, remove" },
  purgeKeep: { pl: "Zostaw", en: "Keep it" },
  purgeDone: {
    pl: "Dane tego profilu usunięto z synchronizacji.",
    en: "This profile's data was removed from sync.",
  },
  purgeRetry: {
    pl: "Usuwanie danych z synchronizacji nie zostało dokończone. Uruchom je ponownie.",
    en: "Removing the data from sync did not finish. Run it again.",
  },
  purgeAgain: { pl: "Spróbuj ponownie", en: "Try again" },
  // An owner action that did not go through.
  actionFailed: {
    pl: "Nie udało się. Spróbuj ponownie za chwilę.",
    en: "That didn't work. Try again in a moment.",
  },
  working: { pl: "Trwa operacja…", en: "Working…" },
  // Designer addendum (2026-11-14): the 7-day bound never refuses silently.
  fetchPaused: {
    pl: "Pobieranie z banku wstrzymane: ten Mac od 7 dni nie ma kontaktu z Twoim drugim Makiem. Połącz ponownie synchronizację albo ustaw ten Mac jako pobierający.",
    en: "Bank fetch paused: this Mac hasn't heard from your other Mac for 7 days. Reconnect sync, or make this Mac the one that fetches.",
  },
  // Lead's wording, addendum 3a: two Macs with sync off.
  fetchPausedSyncOff: {
    pl: "Pobieranie z banku wstrzymane: synchronizacja jest wyłączona, więc ten Mac nie wie, czy pobiera Twój drugi Mac. Włącz synchronizację albo ustaw ten Mac jako pobierający.",
    en: "Bank fetch paused: sync is off, so this Mac can't tell whether your other Mac fetches. Turn sync on, or make this Mac the one that fetches.",
  },
  // The links under the paused state.
  goToSync: { pl: "Przejdź do synchronizacji", en: "Go to sync" },
  goToRepin: { pl: "Ustaw ten Mac jako pobierający", en: "Make this Mac the one that fetches" },
  // W3-7 item 1: the paused line on the Banking screen links to Devices, which keeps the detail.
  openDevices: { pl: "Otwórz Urządzenia", en: "Open Devices" },
  // W3-7 item 2 (spec copy verbatim): the owner's override while this Mac is the one that fetches.
  keepFetching: { pl: "Pobieraj dalej na tym Macu", en: "Keep fetching on this Mac" },
  keepFetchingConfirm: {
    pl: (name: string) =>
      `Pobierać dalej na tym Macu? Upewnij się, że Twój drugi Mac „${name}” nie pobiera danych. cashU zapyta ponownie za 7 dni.`,
    en: (name: string) =>
      `Keep fetching on this Mac? Make sure your other Mac “${name}” doesn't fetch too. cashU asks again in 7 days.`,
  },
  // Proposed: the same question when the device list cannot name the other Mac.
  keepFetchingConfirmUnnamed: {
    pl: "Pobierać dalej na tym Macu? Upewnij się, że Twój drugi Mac nie pobiera danych. cashU zapyta ponownie za 7 dni.",
    en: "Keep fetching on this Mac? Make sure your other Mac doesn't fetch too. cashU asks again in 7 days.",
  },
  keepFetchingYes: { pl: "Pobieraj dalej", en: "Keep fetching" },
  keepFetchingCancel: { pl: "Anuluj", en: "Cancel" },
});
