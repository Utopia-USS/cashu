import { catalog } from "@cashu/i18n";

export const T = catalog({
  title: { pl: "Urządzenia", en: "Devices" },
  unavailable: {
    pl: "Zarządzanie urządzeniami jest niedostępne.",
    en: "Device management is unavailable.",
  },
  evidencePending: {
    pl: "Historia urządzeń wymaga dalszej weryfikacji. Usunięcie jest teraz wstrzymane.",
    en: "Device history still needs verification. Removal is paused for now.",
  },
  evidenceOverflow: {
    pl: "Osiągnięto limit dowodów urządzeń. Usunięcie jest niedostępne do czasu naprawy historii sejfu.",
    en: "The device evidence limit was reached. Removal is unavailable until the vault history is repaired.",
  },
  writerPaused: {
    pl: "Zapisy są wstrzymane do czasu potwierdzenia lokalnej historii sejfu.",
    en: "Writes are paused until this vault's local history is verified.",
  },
  choose: { pl: "Wybierz urządzenie do usunięcia", en: "Choose a device to remove" },
  preview: { pl: "Sprawdź usunięcie", en: "Review removal" },
  cancel: { pl: "Anuluj", en: "Cancel" },
  warning: {
    pl: "Usunięcie urządzenia może pominąć jego niewidoczne jeszcze zmiany. Rotacja klucza może nie dotrzeć do urządzenia, jeśli synchronizacja jest wstrzymana. Sprawdź stan pozostałych urządzeń.",
    en: "Removing a device may exclude changes this device has not seen. Key rotation may not reach a device while synchronization is withheld. Check the other devices' status.",
  },
  warningAck: {
    pl: "Rozumiem ryzyko utraty niewidocznych zmian",
    en: "I understand the risk of losing unseen changes",
  },
  localStart: {
    pl: "To urządzenie nie pobrało jeszcze zmian z wybranego urządzenia. Potwierdzam tę lokalną obserwację.",
    en: "This device has not fetched changes from the selected device. I confirm this local observation.",
  },
  recovery: { pl: "24 słowa odzyskiwania", en: "24 recovery words" },
  recoveryHelp: {
    pl: "Wpisz słowa tylko na zaufanym urządzeniu.",
    en: "Enter the words only on a trusted device.",
  },
  remove: { pl: "Usuń urządzenie i zmień klucz", en: "Remove device and rotate key" },
  unknown: {
    pl: "Wynik jest nieznany. Sprawdź stan tej operacji przed dalszymi zmianami.",
    en: "The outcome is unknown. Check this operation before making more changes.",
  },
  completed: { pl: "Urządzenie usunięto.", en: "Device removed." },
  failed: {
    pl: "Nie udało się wykonać operacji. Sprawdź stan i spróbuj ponownie.",
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
});
