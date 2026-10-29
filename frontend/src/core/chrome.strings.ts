// Texts of the app chrome (src/core): App, Shell, ProfileMenu, IncognitoToggle, UpdateNotice, AgentWidget,
// StartPage, RunError and the token message of token.ts. See src/i18n.ts.
import { catalog } from "../i18n.ts";

export const S = catalog({
  // App
  serverRestarted: { pl: "Serwer uruchomiony ponownie.", en: "The server was restarted." },
  reloadPage: { pl: " Odśwież stronę.", en: " Reload the page." },
  openNewUrlBefore: { pl: " Otwórz nowy adres z ", en: " Open the new address from " },
  openNewUrlAfter: { pl: ".", en: "." },
  error: { pl: (err: string) => `Błąd: ${err}`, en: (err: string) => `Error: ${err}` },

  // Shell
  modulesNav: { pl: "Moduły", en: "Modules" },
  overview: { pl: "Przegląd", en: "Overview" },
  notConfiguredTitle: { pl: "Nieskonfigurowany", en: "Not set up" },
  notConfigured: { pl: "nieskonfigurowany", en: "not set up" },
  wizardCancelled: { pl: "Przerwano tworzenie profilu", en: "Profile creation cancelled" },
  profileToast: { pl: (name: string) => `Profil: ${name}`, en: (name: string) => `Profile: ${name}` },
  continue: { pl: "Kontynuuj", en: "Continue" },
  hide: { pl: "ukryj", en: "hide" },

  // ProfileMenu
  profile: { pl: "Profil", en: "Profile" },
  profiles: { pl: "Profile", en: "Profiles" },
  active: { pl: "aktywny", en: "active" },
  newProfile: { pl: "Nowy profil…", en: "New profile…" },
  settings: { pl: "Ustawienia", en: "Settings" },

  // IncognitoToggle
  showAmounts: { pl: "Pokaż kwoty", en: "Show amounts" },
  hideAmounts: { pl: "Ukryj kwoty", en: "Hide amounts" },

  // UpdateNotice
  newVersion: { pl: (v: string) => `Nowa wersja ${v}`, en: (v: string) => `New version ${v}` },
  current: { pl: (v: string) => `Masz ${v}`, en: (v: string) => `You have ${v}` },
  seeChanges: { pl: "Zobacz zmiany", en: "See what's new" },
  // UpdateNotice: cashU.app's own updater (desktop/updater.py)
  install: { pl: "Aktualizuj", en: "Update" },
  skip: { pl: "Pomiń", en: "Skip" },
  skipTitle: { pl: "Ta wersja nie będzie już proponowana", en: "This version will not be offered again" },
  remindLater: { pl: "Przypomnij później", en: "Remind me later" },
  downloading: {
    pl: (v: string) => (v ? `Pobieram ${v}…` : "Pobieram aktualizację…"),
    en: (v: string) => (v ? `Downloading ${v}…` : "Downloading the update…"),
  },
  installing: {
    pl: (v: string) => (v ? `Instaluję ${v}…` : "Instaluję aktualizację…"),
    en: (v: string) => (v ? `Installing ${v}…` : "Installing the update…"),
  },
  relaunchSoon: { pl: "cashU uruchomi się ponownie", en: "cashU will restart" },
  checking: { pl: "Sprawdzam aktualizacje…", en: "Checking for updates…" },
  upToDate: { pl: "Masz najnowszą wersję", en: "You have the latest version" },
  updateFailed: { pl: "Nie udało się zaktualizować", en: "The update failed" },
  actionFailed: { pl: (err: string) => `Nie udało się: ${err}`, en: (err: string) => `It did not work: ${err}` },

  // AgentWidget
  agent: { pl: "Agent AI", en: "AI agent" },

  // StartPage
  firstSteps: { pl: "Pierwsze kroki", en: "First steps" },
  cliGuide: { pl: "Instrukcja Claude Code i CLI", en: "Claude Code and CLI guide" },

  // token.ts
  noToken: {
    pl: "Brak tokenu dostępu. Otwórz aplikację cashU albo adres z #token=..., który wypisuje `cashu serve`.",
    en: "No access token. Open the cashU app or the #token=... address that `cashu serve` prints.",
  },
});
