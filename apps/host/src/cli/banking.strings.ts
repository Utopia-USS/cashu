export const M = {
  usage: {
    pl: "Użycie: cashu --profile PROFIL eb status|sessions|check|banks|resync|sync|forget|attempt-status [opcje]",
    en: "Usage: cashu --profile PROFILE eb status|sessions|check|banks|resync|sync|forget|attempt-status [options]",
  },
  profile: { pl: "Wybierz jeden otwarty profil natywny.", en: "Select one open native profile." },
  uiOnly: {
    pl: "Konfigurację i zgodę bankową wykonaj w Ustawieniach aplikacji.",
    en: "Use app Settings for bank setup and consent.",
  },
  unavailable: {
    pl: "Operacja bankowa jest niedostępna.",
    en: "The banking operation is unavailable.",
  },
  unknown: {
    pl: "Wynik operacji jest nieznany. Sprawdź próbę przed ponowieniem.",
    en: "The outcome is unknown. Check the attempt before retrying.",
  },
  done: { pl: "Gotowe.", en: "Done." },
} as const;
