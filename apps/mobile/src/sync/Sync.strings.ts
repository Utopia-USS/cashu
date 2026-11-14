// What the phone says about sync outside the pairing flow: the quiet status line in Today's banner slot
// (paused, today's limit, changes that can't be read, the replay check), the removed and sync-off
// states with their "Remove this copy" offer, a profile that does not open, and the root's fatal state
// when no profile opens. Designer copy verbatim from dev-feedback #23.7 and #25.2-4 and the replay-line
// note; lines marked "proposed" wait for the designer's pass. The user never sees "relay". PL + EN.
import { catalog } from "@cashu/i18n";

const hhmm = (locale: string) =>
  new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" });
/** HH:MM of a moment (same-day statuses). */
const time = (locale: string, at: number) => hhmm(locale).format(new Date(at));

export const S = catalog({
  // #25.2 (and #23.7's quota variant).
  paused: {
    pl: (at: number) =>
      `Synchronizacja wstrzymana od ${time("pl-PL", at)} · cashU działa normalnie`,
    en: (at: number) => `Sync paused since ${time("en-GB", at)} · cashU works as usual`,
  },
  quota: {
    pl: "Dzisiejszy limit synchronizacji wyczerpany, kolejna próba po północy",
    en: "Today's sync limit is used up, tries again after midnight",
  },
  // #25.3.
  stuckWaiting: {
    pl: (device: string) =>
      `Części zmian z urządzenia „${device}” nie da się jeszcze odczytać. Synchronizacja próbuje dalej.`,
    en: (device: string) => `Some changes from ${device} can't be read yet. Sync keeps trying.`,
  },
  stuckFailed: {
    pl: (device: string) =>
      `Nie da się odczytać zmian z urządzenia „${device}”. Sprawdź Urządzenia na Macu.`,
    en: (device: string) => `Changes from ${device} can't be read. Check Devices on your Mac.`,
  },
  // #25.3, the designer's lines for a writer the registry cannot name yet (never an id).
  stuckWaitingUnnamed: {
    pl: "Części zmian z innego urządzenia nie da się jeszcze odczytać. Synchronizacja próbuje dalej.",
    en: "Some changes from another device can't be read yet. Sync keeps trying.",
  },
  stuckFailedUnnamed: {
    pl: "Nie da się odczytać zmian z innego urządzenia. Sprawdź Urządzenia na Macu.",
    en: "Changes from another device can't be read. Check Devices on your Mac.",
  },
  // The replay-line note (progress.md, wave 2).
  replay: {
    pl: (percent: number) => `Sprawdzanie kopii na tym telefonie · ${percent}%`,
    en: (percent: number) => `Checking this phone's copy · ${percent}%`,
  },
  // #23.7.
  removed: {
    pl: (profile: string) => `Ten telefon został usunięty z profilu ${profile} na Twoim Macu`,
    en: (profile: string) => `This phone was removed from ${profile} on your Mac`,
  },
  // Proposed.
  removedBody: {
    pl: "Kopia zostaje na tym telefonie, dopóki jej nie usuniesz.",
    en: "The copy stays on this phone until you remove it.",
  },
  // #25.4.
  syncOff: {
    pl: (profile: string) =>
      `Synchronizacja profilu ${profile} została wyłączona na Twoim Macu. Kopia na tym telefonie zostaje, dopóki jej nie usuniesz.`,
    en: (profile: string) =>
      `Sync for ${profile} was turned off on your Mac. The copy on this phone stays until you remove it.`,
  },
  removeCopy: { pl: "Usuń tę kopię", en: "Remove this copy" },
  keepForNow: { pl: "Na razie zostaw", en: "Keep for now" },
  // Proposed: a paired profile whose files or keys did not open this launch.
  needsRepair: {
    pl: (profile: string) =>
      `cashU nie może otworzyć profilu ${profile} na tym telefonie. Połącz go ponownie z Makiem albo usuń tę kopię.`,
    en: (profile: string) =>
      `cashU can't open ${profile} on this phone. Pair it again with your Mac, or remove this copy.`,
  },
  pairAgain: { pl: "Połącz ponownie", en: "Pair again" },
  // Proposed: the root's fatal state when no paired profile opens (`no_vault`, `paired_vaults_unlisted`).
  noProfileOpens: {
    pl: "cashU nie może otworzyć profili na tym telefonie. Zamknij cashU i otwórz ponownie. Jeśli to się powtórzy, połącz ten telefon ponownie w Ustawieniach > Urządzenia na Macu.",
    en: "cashU can't open the profiles on this phone. Close cashU and open it again. If this stays, pair this phone again in Settings > Devices on your Mac.",
  },
  couldNotRemove: {
    pl: "Nie udało się usunąć kopii. Spróbuj ponownie.",
    en: "Could not remove the copy. Try again.",
  },
});
