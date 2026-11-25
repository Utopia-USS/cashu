import { catalog } from "@cashu/i18n";

export const S = catalog({
  overview: { pl: "Przegląd", en: "Overview" },
  modules: { pl: "Moduły", en: "Modules" },
  investments: { pl: "Inwestycje", en: "Investments" },
  loans: { pl: "Kredyty", en: "Loans" },
  settings: { pl: "Ustawienia", en: "Settings" },
  profile: { pl: "Profil", en: "Profile" },
  privacy: { pl: "Ukryj kwoty", en: "Hide amounts" },
  waiting: { pl: "Otwieranie danych lokalnych…", en: "Opening local data…" },
  failed: { pl: "Nie udało się otworzyć danych lokalnych.", en: "Local data could not be opened." },
  retry: { pl: "Spróbuj ponownie", en: "Try again" },
  noProfile: { pl: "Brak otwartego profilu.", en: "No profile is open." },
  ambiguousProfile: {
    pl: "Ten adres pasuje do kilku otwartych profili. Wybierz profil z listy.",
    en: "This address matches several open profiles. Choose a profile from the list.",
  },
  vaultProfile: {
    pl: (name: string, identity: string) => `${name} (${identity})`,
    en: (name: string, identity: string) => `${name} (${identity})`,
  },
  setup: { pl: "Rozpocznij konfigurację", en: "Start setup" },
  changed: { pl: "Zmieniono profil.", en: "Profile changed." },
  refused: { pl: "Nie udało się zmienić profilu.", en: "Profile could not be changed." },
  dismiss: { pl: "Zamknij", en: "Dismiss" },
});
