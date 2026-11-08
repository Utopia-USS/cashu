// Texts of the app chrome (src/core): App, Shell, ProfileMenu, IncognitoToggle, UpdateNotice, AgentWidget,
// StartPage, RunError and the token message of token.ts. See docs/agents/localization.md.
import { catalog } from "../index.js";

export const S = catalog({
  // ProfileMenu
  settings: { pl: "Ustawienia", en: "Settings" },

  // UpdateNotice
  newVersion: { pl: (v: string) => `Nowa wersja ${v}`, en: (v: string) => `New version ${v}` },
  current: { pl: (v: string) => `Masz ${v}`, en: (v: string) => `You have ${v}` },
  seeChanges: { pl: "Zobacz zmiany", en: "See what's new" },
  // UpdateNotice: cashU.app's own updater (desktop/updater.py)
  install: { pl: "Aktualizuj", en: "Update" },
  skip: { pl: "Pomiń", en: "Skip" },
  skipTitle: {
    pl: "Ta wersja nie będzie już proponowana",
    en: "This version will not be offered again",
  },
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

  // AgentWidget
  agent: { pl: "Agent AI", en: "AI agent" },

  // StartPage
  firstSteps: { pl: "Pierwsze kroki", en: "First steps" },
  cliGuide: { pl: "Instrukcja Claude Code i CLI", en: "Claude Code and CLI guide" },
});
