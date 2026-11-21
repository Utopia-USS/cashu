// Settings > Devices: the device list, the security details and the two dialogs (remove a device,
// change which Mac fetches the bank data). Designer spec devices-v1 (2026-11-21) verbatim where it
// gives the copy; entries marked "proposed" are this screen's wording and wait for the designer's pass.
import { catalog, enForm, plForm } from "@cashu/i18n";
import { type DayWord, dateText } from "./deviceRows.js";

const dayPl = (day: DayWord) =>
  day.kind === "today" ? "dziś" : day.kind === "yesterday" ? "wczoraj" : dateText(day, "pl");
const dayEn = (day: DayWord) =>
  day.kind === "today" ? "today" : day.kind === "yesterday" ? "yesterday" : dateText(day, "en");
/** "on 15 Nov" in English; "today" / "yesterday" without "on". */
const onDayEn = (day: DayWord) => (day.kind === "date" ? `on ${dateText(day, "en")}` : dayEn(day));
/** The neuter "urządzenie": "usunęło swoją kopię 15 lis", "dziś usunęło swoją kopię". */
const removedPl = (day: DayWord) =>
  day.kind === "date"
    ? `usunęło swoją kopię ${dateText(day, "pl")}`
    : `${dayPl(day)} usunęło swoją kopię`;
/** "od 1 dnia", "od 7 dni". */
const daysPl = (n: number) => `${n} ${plForm(n, "dnia", "dni", "dni")}`;
const daysEn = (n: number) => `${n} ${enForm(n, "day", "days")}`;

export const T = catalog({
  unavailable: {
    pl: "Zarządzanie urządzeniami jest niedostępne.",
    en: "Device management is unavailable.",
  },
  // §1 page.
  lead: {
    pl: (profile: string) =>
      `Urządzenia, które mogą otworzyć profil „${profile}”. Każde ma własną zaszyfrowaną kopię.`,
    en: (profile: string) =>
      `Devices that can open ${profile}'s profile. Each one keeps an encrypted copy.`,
  },
  // Proposed: the lead line while the profile's name is not known.
  leadUnnamed: {
    pl: "Urządzenia, które mogą otworzyć ten profil. Każde ma własną zaszyfrowaną kopię.",
    en: "Devices that can open this profile. Each one keeps an encrypted copy.",
  },
  section: { pl: "Urządzenia", en: "Devices" },
  // Designer (DV2 item 2): the list header counts the devices beside "Pair a phone".
  count: {
    pl: (n: number) => `${n} ${plForm(n, "urządzenie", "urządzenia", "urządzeń")}`,
    en: (n: number) => `${n} ${enForm(n, "device", "devices")}`,
  },
  // The row menu's item on this Mac (dialog F).
  fetchHere: { pl: "Pobieraj dane z banku na tym Macu", en: "Fetch bank data on this Mac" },
  // Designer (DV2 item 4): state P, this Mac fetches and its fetch is paused by the offline bound.
  fetchPausedTag: { pl: "Pobieranie wstrzymane", en: "Fetch paused" },
  fetchPausedBanner: {
    pl: (days: number) =>
      `Pobieranie z banku wstrzymane: ten Mac od ${daysPl(days)} nie ma kontaktu z Twoim drugim Makiem, więc nie ma pewności, że pobiera tylko jeden. Połącz ponownie synchronizację albo pobieraj dalej na tym Macu.`,
    en: (days: number) =>
      `Bank fetch paused: this Mac hasn't heard from your other Mac for ${daysEn(days)}, so it can't be sure only one Mac fetches. Reconnect sync, or keep fetching on this Mac.`,
  },
  keepFetching: { pl: "Pobieraj dalej na tym Macu", en: "Keep fetching on this Mac" },
  // §2 device row.
  thisMac: { pl: "Ten Mac", en: "This Mac" },
  fetches: { pl: "Pobiera dane z banku", en: "Fetches bank data" },
  added: {
    pl: (day: DayWord) => `Dodane ${dayPl(day)}`,
    en: (day: DayWord) => `Added ${dayEn(day)}`,
  },
  addedBy: {
    pl: (day: DayWord | null, by: string) =>
      day === null ? `Dodane przez ${by}` : `Dodane ${dayPl(day)} przez ${by}`,
    en: (day: DayWord | null, by: string) =>
      day === null ? `Added by ${by}` : `Added ${dayEn(day)} by ${by}`,
  },
  addedRecovery: {
    pl: (day: DayWord | null) =>
      day === null
        ? "Dodane za pomocą słów odzyskiwania"
        : `Dodane ${dayPl(day)} za pomocą słów odzyskiwania`,
    en: (day: DayWord | null) =>
      day === null
        ? "Added with the recovery words"
        : `Added ${dayEn(day)} with the recovery words`,
  },
  removedCopyOn: {
    pl: (day: DayWord) => removedPl(day),
    en: (day: DayWord) => `removed its copy ${onDayEn(day)}`,
  },
  // Designer copy (dev-feedback, real run 2), the day now in words.
  removedCopy: {
    pl: (device: string, day: DayWord) =>
      `Urządzenie ${device} ${removedPl(day)}. Usunąć je z tego profilu?`,
    en: (device: string, day: DayWord) =>
      `${device} removed its copy ${onDayEn(day)}. Remove it from this profile?`,
  },
  removeLeft: { pl: "Usuń z profilu", en: "Remove from profile" },
  // Proposed: the accessible name of a row's menu button.
  rowMenu: {
    pl: (device: string) => `Opcje urządzenia ${device}`,
    en: (device: string) => `Options for ${device}`,
  },
  menuFetchLater: {
    pl: "Dostępne po 36 godzinach bez pobrania z banku",
    en: "Available after 36 hours without a bank fetch",
  },
  menuRemove: { pl: "Usuń z profilu…", en: "Remove from profile…" },
  // Proposed: the spec's count-free variant, named by the device (the list knows no count or kind).
  behind: {
    pl: (device: string) =>
      `Część zmian z urządzenia ${device} nie dotarła jeszcze do tego Maca. Otwórz cashU na urządzeniu ${device}, żeby je wysłać.`,
    en: (device: string) =>
      `Some changes from ${device} haven't reached this Mac yet. Open cashU on ${device} to send them.`,
  },
  forked: {
    pl: "Historia tego urządzenia nie zgadza się z historią tego Maca. Zmiany są wstrzymane, dopóki tego nie sprawdzisz.",
    en: "This device's history doesn't match this Mac's. Changes are paused until you check it.",
  },
  // §3 security details.
  security: { pl: "Szczegóły bezpieczeństwa", en: "Security details" },
  profileKey: { pl: "Klucz profilu", en: "Profile key" },
  keyOwn: { pl: "Utworzony na tym Macu", en: "Created on this Mac" },
  keyWrap: {
    pl: (device: string) => `Przekazany przez ${device}`,
    en: (device: string) => `Passed on by ${device}`,
  },
  // Proposed: the sender is not a device the list names.
  keyWrapUnnamed: { pl: "Przekazany przez inne urządzenie", en: "Passed on by another device" },
  keyPairing: {
    pl: "Otrzymany przy parowaniu tego Maca",
    en: "Received when this Mac was paired",
  },
  keyUnknown: { pl: "Pochodzenie niepotwierdzone", en: "Origin not confirmed" },
  removing: { pl: "Usuwanie urządzenia", en: "Removing a device" },
  removingFact: {
    pl: "Wymaga 24 słów odzyskiwania. Nie trzymaj ich na tym komputerze.",
    en: "Needs your 24 recovery words. Keep them off this computer.",
  },
  // §4 dialog R.
  removeTitle: {
    pl: (device: string, profile: string) => `Usunąć ${device} z profilu „${profile}”?`,
    en: (device: string, profile: string) => `Remove ${device} from ${profile}'s profile?`,
  },
  // Proposed: the same while the profile's name is not known.
  removeTitleUnnamed: {
    pl: (device: string) => `Usunąć ${device} z tego profilu?`,
    en: (device: string) => `Remove ${device} from this profile?`,
  },
  // The list cannot tell a phone from a Mac: the English body says "the device" like the Polish one.
  removeBody: {
    pl: "Nie dostanie już nic nowego. cashU zmieni klucz profilu, więc to urządzenie nie odczyta nowych danych, nawet jeśli wciąż działa. To, co już na nim jest, zostaje, dopóki go nie wyczyścisz.",
    en: "It won't receive anything new. cashU changes the profile's key, so the device can't read new data even if it is still out there. What is already on it stays there until it is wiped.",
  },
  // Proposed: the count-free variant of the pending-changes checkbox.
  ackBehind: {
    pl: (device: string) =>
      `Część zmian z urządzenia ${device} nie dotarła do tego Maca i przepadnie. Usuń mimo to.`,
    en: (device: string) =>
      `Some changes from ${device} haven't reached this Mac and will be lost. Remove it anyway.`,
  },
  ackLocalStart: {
    pl: (device: string) =>
      `Ten Mac nie ma jeszcze nic z ${device}. To, co jest tylko na ${device}, przepadnie. Usuń mimo to.`,
    en: (device: string) =>
      `This Mac has nothing from ${device} yet. Anything only on ${device} will be lost. Remove it anyway.`,
  },
  // Proposed: the host always warns that unseen changes may be lost; the plain case.
  ackPlain: {
    pl: (device: string) =>
      `Zmiany z urządzenia ${device}, które nie dotarły do tego Maca, przepadną. Usuń mimo to.`,
    en: (device: string) =>
      `Changes from ${device} that haven't reached this Mac will be lost. Remove it anyway.`,
  },
  // Designer (DV2 item 12): no gendered verb in Polish.
  keepTitle: {
    pl: (device: string) => `Urządzenia dodane przez ${device}. Zostaw je w profilu:`,
    en: (device: string) => `Devices added by ${device}. Keep them in the profile:`,
  },
  refreshSelection: { pl: "Sprawdź wybrane urządzenia", en: "Review selected devices" },
  recovery: { pl: "Twoje 24 słowa odzyskiwania", en: "Your 24 recovery words" },
  recoveryHelp: {
    pl: "Wpisuj je tylko na zaufanym urządzeniu. cashU ich nie zapisuje.",
    en: "Type them only on a device you trust. cashU never stores them.",
  },
  remove: { pl: "Usuń i zmień klucz", en: "Remove and change the key" },
  cancel: { pl: "Anuluj", en: "Cancel" },
  // Dialogs R and F in an error or pause state: the note replaces the button row (DV2 item 9).
  close: { pl: "Zamknij", en: "Close" },
  tryAgain: { pl: "Spróbuj ponownie", en: "Try again" },
  evidencePending: {
    pl: "cashU wciąż sprawdza historię urządzeń tego profilu. Spróbuj usunąć za kilka minut.",
    en: "cashU is still checking this profile's device history. Try removing again in a few minutes.",
  },
  // Proposed: there is no repair command to name yet.
  evidenceOverflow: {
    pl: "Historia urządzeń tego profilu wymaga naprawy, zanim będzie można usunąć urządzenie.",
    en: "This profile's device history needs a repair before a device can be removed.",
  },
  // Proposed.
  writerPaused: {
    pl: "Zmiany na tym Macu są wstrzymane, dopóki jego historia nie zostanie sprawdzona. Spróbuj później.",
    en: "Changes on this Mac are paused until its history is checked. Try again later.",
  },
  // Proposed.
  capacity: {
    pl: "cashU nie może zostawić wszystkich zaznaczonych urządzeń. Odznacz część i spróbuj ponownie.",
    en: "cashU can't keep every device you ticked. Untick some and try again.",
  },
  unknown: {
    pl: "Nie wiadomo jeszcze, czy usuwanie się zakończyło. Sprawdź to, zanim zmienisz coś innego.",
    en: "It isn't known yet whether the removal finished. Check before changing anything else.",
  },
  inspect: { pl: "Sprawdź wynik", en: "Check outcome" },
  working: { pl: "Trwa operacja…", en: "Working…" },
  // Designer (DV2 item 9), with "Try again" re-running the dialog's step.
  failed: {
    pl: "Nie udało się dokończyć. Spróbuj ponownie.",
    en: "That didn't finish. Try again.",
  },
  removed: {
    pl: (device: string) => `Usunięto ${device}. Klucz profilu został zmieniony.`,
    en: (device: string) => `${device} removed. The profile key was changed.`,
  },
  // Proposed: the same after "Check outcome" of a removal this window did not start.
  removedUnnamed: {
    pl: "Usunięto urządzenie. Klucz profilu został zmieniony.",
    en: "Device removed. The profile key was changed.",
  },
  // §5 dialog F.
  fetchTitleHere: { pl: "Pobierać dane z banku na tym Macu?", en: "Fetch bank data on this Mac?" },
  // Proposed: dialog F for a change whose outcome is open (no target known in this window).
  fetchTitleUnknown: {
    pl: "Zmiana urządzenia pobierającego dane z banku",
    en: "Changing which device fetches bank data",
  },
  handover: {
    pl: (current: string) =>
      `Dziś pobiera ${current}. Przekaże to przy najbliższej synchronizacji; do tego czasu żaden Mac nie pobiera, więc nic nie zostanie pobrane dwa razy.`,
    en: (current: string) =>
      `${current} fetches today. It hands over the next time it syncs; until then neither Mac fetches, so nothing is fetched twice.`,
  },
  // Proposed: no device fetches now, so there is nothing to hand over.
  noFetcher: {
    pl: "Żaden Mac nie pobiera teraz danych z banku.",
    en: "No Mac fetches bank data right now.",
  },
  // Designer (2026-11-21): the duration only from one whole day of silence.
  force: {
    pl: (current: string, days: number) =>
      days >= 1
        ? `${current} nie odzywa się od ${daysPl(days)}. Przełącz od razu, bez czekania. Jeśli wciąż działa, oba Maki mogą raz pobrać dane; zdublowane transakcje zostaną odfiltrowane.`
        : `Przełącz od razu, bez czekania na ${current}. Jeśli wciąż działa, oba Maki mogą raz pobrać dane; zdublowane transakcje zostaną odfiltrowane.`,
    en: (current: string, days: number) =>
      days >= 1
        ? `${current} hasn't reported for ${daysEn(days)}. Switch now without waiting for it. If it is still running, both Macs may fetch once; duplicate transactions are filtered out.`
        : `Switch now without waiting for ${current}. If it is still running, both Macs may fetch once; duplicate transactions are filtered out.`,
  },
  fetchConfirmHere: { pl: "Pobieraj na tym Macu", en: "Fetch on this Mac" },
  // Dialog F for the paused fetch (DV2 items 4 and 13): the title asks, the body does not repeat it.
  // Designer (DV4 item 2): the other Mac by its name alone, "Your other Mac" without one.
  keepFetchingTitle: { pl: "Pobierać dalej na tym Macu?", en: "Keep fetching on this Mac?" },
  keepFetchingBody: {
    pl: (name: string, days: number) =>
      `${name} nie odzywa się od ${daysPl(days)}. Jeśli wciąż działa, oba Maki mogą raz pobrać dane; zdublowane transakcje zostaną odfiltrowane.`,
    en: (name: string, days: number) =>
      `${name} hasn't reported for ${daysEn(days)}. If it is still running, both Macs may fetch once; duplicate transactions are filtered out.`,
  },
  keepFetchingBodyUnnamed: {
    pl: (days: number) =>
      `Twój drugi Mac nie odzywa się od ${daysPl(days)}. Jeśli wciąż działa, oba Maki mogą raz pobrać dane; zdublowane transakcje zostaną odfiltrowane.`,
    en: (days: number) =>
      `Your other Mac hasn't reported for ${daysEn(days)}. If it is still running, both Macs may fetch once; duplicate transactions are filtered out.`,
  },
  keepFetchingConfirm: { pl: "Pobieraj dalej", en: "Keep fetching" },
  fetchDone: {
    pl: (device: string) => `Teraz dane z banku pobiera ${device}.`,
    en: (device: string) => `${device} fetches bank data now.`,
  },
  // Proposed: a change of the fetching device cannot start while the device history is being checked.
  fetchBlocked: {
    pl: "cashU wciąż sprawdza urządzenia tego profilu. Spróbuj za kilka minut.",
    en: "cashU is still checking this profile's devices. Try again in a few minutes.",
  },
  // Proposed: the leader change's open outcome.
  fetchUnknown: {
    pl: "Nie wiadomo jeszcze, czy zmiana się zakończyła. Sprawdź to, zanim zmienisz coś innego.",
    en: "It isn't known yet whether the change finished. Check before changing anything else.",
  },
});
