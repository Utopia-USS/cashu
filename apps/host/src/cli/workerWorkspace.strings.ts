export const M = {
  usageWorker: {
    pl: "Użycie: cashu worker run|install|uninstall|status [--json]",
    en: "Usage: cashu worker run|install|uninstall|status [--json]",
  },
  usageWorkspace: {
    pl: "Użycie: cashu workspace init|update|path --profile SLUG",
    en: "Usage: cashu workspace init|update|path --profile SLUG",
  },
  unavailable: {
    pl: "Ta funkcja nie jest dostępna w bieżącym hoście.",
    en: "This capability is unavailable in the current host.",
  },
  serviceUi: {
    pl: "Zmień codzienne uruchamianie w Ustawieniach > Uruchamianie po zamknięciu aplikacji.",
    en: "Change daily start in Settings > Start after closing the app.",
  },
  notifierUnavailable: {
    pl: "Wybrany sposób powiadamiania nie jest dostępny w tym hoście.",
    en: "The selected notification transport is unavailable in this host.",
  },
  profile: { pl: "Podaj jeden istniejący profil.", en: "Select one existing profile." },
  failed: { pl: "Operacja nie powiodła się.", en: "The operation failed." },
  busy: { pl: "Pracownik jest zajęty.", en: "The worker is busy." },
  done: { pl: "Gotowe.", en: "Done." },
} as const;
