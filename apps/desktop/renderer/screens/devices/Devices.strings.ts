import { catalog } from "@cashu/i18n";

export const T = catalog({
  unavailable: {
    pl: "Zarządzanie urządzeniami jest niedostępne.",
    en: "Device management is unavailable.",
  },
  evidencePending: {
    pl: "Historia urządzeń nie jest jeszcze sprawdzona. Na razie nie można usunąć urządzenia.",
    en: "Device history still needs verification. Removal is paused for now.",
  },
  evidenceOverflow: {
    pl: "Osiągnięto limit zapisów o urządzeniach. Nie można usuwać urządzeń, dopóki historia sejfu nie zostanie naprawiona.",
    en: "The device evidence limit was reached. Removal is unavailable until the vault history is repaired.",
  },
  writerPaused: {
    pl: "Zapisywanie zmian jest wstrzymane, dopóki lokalna historia sejfu nie zostanie sprawdzona.",
    en: "Writes are paused until this vault's local history is verified.",
  },
  choose: { pl: "Wybierz urządzenie do usunięcia", en: "Choose a device to remove" },
  preview: { pl: "Sprawdź usunięcie", en: "Review removal" },
  cancel: { pl: "Anuluj", en: "Cancel" },
  warning: {
    pl: "Usunięcie urządzenia może pominąć zmiany, których to urządzenie jeszcze nie widziało. Nowy klucz może nie dotrzeć do urządzenia, jeśli synchronizacja jest wstrzymana. Sprawdź stan pozostałych urządzeń.",
    en: "Removing a device may exclude changes this device has not seen. Key rotation may not reach a device while synchronization is withheld. Check the other devices' status.",
  },
  warningAck: {
    pl: "Rozumiem ryzyko utraty niewidocznych zmian",
    en: "I understand the risk of losing unseen changes",
  },
  localStart: {
    pl: "To urządzenie nie pobrało jeszcze zmian z wybranego urządzenia. Potwierdzam, że tak to wygląda na tym urządzeniu.",
    en: "This device has not fetched changes from the selected device. I confirm this local observation.",
  },
  recovery: { pl: "24 słowa odzyskiwania", en: "24 recovery words" },
  recoveryHelp: {
    pl: "Wpisz słowa tylko na zaufanym urządzeniu.",
    en: "Enter the words only on a trusted device.",
  },
  remove: { pl: "Usuń urządzenie i zmień klucz", en: "Remove device and rotate key" },
  unknown: {
    pl: "Nie wiadomo, czy operacja się udała. Sprawdź to, zanim wprowadzisz kolejne zmiany.",
    en: "The outcome is unknown. Check this operation before making more changes.",
  },
  completed: { pl: "Urządzenie usunięto.", en: "Device removed." },
  failed: {
    pl: "Nie udało się dokończyć operacji. Sprawdź stan i spróbuj ponownie.",
    en: "The operation could not finish. Check its status and try again.",
  },
  capacity: {
    pl: "Nie można ponownie poświadczyć wszystkich wybranych urządzeń. Zmień wybór i sprawdź ponownie.",
    en: "Not every selected device can be recertified. Change the selection and review again.",
  },
  inspect: { pl: "Sprawdź wynik", en: "Check outcome" },
  headTrusted: { pl: "Potwierdzony punkt odcięcia", en: "Trusted cut head" },
  headLocalStart: { pl: "Nie pobrano tu zmian", en: "Changes not fetched here" },
  orphanTitle: { pl: "Urządzenia, które utracą zaufanie", en: "Devices that will lose trust" },
  orphanChoice: { pl: "Zachowaj dostęp dla", en: "Keep access for" },
  refreshSelection: { pl: "Sprawdź wybrane urządzenia", en: "Review selected devices" },
  behind: { pl: "Czeka na zmiany z tego urządzenia", en: "Changes from this device are pending" },
  forked: {
    pl: "Wykryto sprzeczne podpisane historie urządzenia. Wstrzymaj zmiany i sprawdź jego stan.",
    en: "Conflicting signed device histories were detected. Pause changes and review this device.",
  },
  issuerTitle: { pl: "Pochodzenie urządzeń", en: "Device origins" },
  issuerRecovery: { pl: "słowa odzyskiwania", en: "recovery words" },
  issuerAt: {
    pl: (segment: number, offset: number) => `segment ${segment}, pozycja ${offset}`,
    en: (segment: number, offset: number) => `segment ${segment}, position ${offset}`,
  },
  issuerBy: { pl: "Dodane przez", en: "Added by" },
  leaderTitle: { pl: "Urządzenie pobierające", en: "Fetch leader" },
  leaderAuto: { pl: "Automatyczny wybór", en: "Automatic selection" },
  leaderNone: { pl: "Brak zaufanego urządzenia pobierającego", en: "No trusted fetch leader" },
  leaderPending: {
    pl: "Czeka na przekazanie przez poprzednie urządzenie",
    en: "Waiting for the previous device to hand over",
  },
  leaderSilent: {
    pl: "Brak potwierdzenia pobrania od ponad 36 godzin",
    en: "No fetch report for over 36 hours",
  },
  leaderOk: { pl: "Urządzenie pobierające jest aktywne", en: "Fetch leader is current" },
  provenanceTitle: { pl: "Pochodzenie bieżącego klucza", en: "Current key origin" },
  provenanceOwn: { pl: "Utworzony na tym urządzeniu", en: "Created on this device" },
  provenanceWrap: { pl: "Przekazany przez zaufane urządzenie", en: "Wrapped by a trusted device" },
  provenancePairing: { pl: "Otrzymany podczas parowania", en: "Received during pairing" },
  provenanceUnknown: { pl: "Brak potwierdzonego pochodzenia", en: "Origin is unavailable" },
  forkAgreed: { pl: "Ostatni zgodny punkt", en: "Last agreed position" },
  repinTitle: { pl: "Zmień urządzenie pobierające", en: "Change fetch leader" },
  repinHelp: {
    pl: "Po ponad 36 godzinach bez potwierdzonego pobrania możesz wskazać urządzenie, które ma pobierać dane.",
    en: "After more than 36 hours without a confirmed fetch, you can choose the device that fetches data.",
  },
  repinTarget: { pl: "Nowe urządzenie pobierające", en: "New fetch leader" },
  repinForce: {
    pl: "Wymuś bez potwierdzenia poprzedniego urządzenia",
    en: "Force without acknowledgement from the previous device",
  },
  repinOverlap: {
    pl: "Wymuszenie może dopuścić jednoczesne pobieranie na dwóch urządzeniach. Użyj go tylko po sprawdzeniu poprzedniego urządzenia.",
    en: "Forcing may allow two devices to fetch at the same time. Check the previous device before proceeding.",
  },
  repinHandover: {
    pl: "Nowe urządzenie poczeka na potwierdzenie poprzedniego urządzenia i nadrobi zaległe zmiany.",
    en: "The new device will wait for the previous device to acknowledge the handover and catch up.",
  },
  repinMayStillRun: {
    pl: "Poprzednie urządzenie może nadal pobierać dane.",
    en: "The previous device may still be fetching data.",
  },
  repinReview: { pl: "Sprawdź zmianę", en: "Review change" },
  repinType: {
    pl: (text: string) => `Wpisz dokładnie ${text}, aby potwierdzić`,
    en: (text: string) => `Type ${text} exactly to confirm`,
  },
  repinCommit: { pl: "Potwierdź zmianę", en: "Confirm change" },
  repinCompleted: { pl: "Zmieniono urządzenie pobierające.", en: "Fetch leader changed." },
});
