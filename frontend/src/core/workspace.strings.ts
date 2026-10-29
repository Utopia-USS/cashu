// Texts of the agent workspace helpers (src/core/workspace.ts), shared by the wizard, Settings and the
// setup page. See src/i18n.ts.
import { catalog } from "../i18n.ts";

const translocated = {
  pl: "Aplikacja działa z tymczasowej lokalizacji macOS: przenieś cashU.app do folderu Programy i otwórz ją ponownie.",
  en: "The app runs from a temporary macOS location: move cashU.app to the Applications folder and open it again.",
};

export const WS = catalog({
  /** Copy of the opt-in routine permissions switch (wizard and Settings). */
  routinePermissionsLabel: { pl: "Rutyna bez pytań o zgodę", en: "Routine without permission prompts" },
  routinePermissionsHint: {
    pl: "Sobotni research przeszukuje sieć i zapisuje w research/ i notes/ bez pytania. Dane finansowe nadal tylko przez MCP.",
    en: "The Saturday research searches the web and writes to research/ and notes/ without asking. Financial data still only through MCP.",
  },
  /** The proposal-safety line (wizard and Settings share it). */
  proposalNote: {
    pl: "Zapis przez agenta to zawsze propozycja do zatwierdzenia w aplikacji.",
    en: "Anything the agent writes is always a proposal you approve in the app.",
  },
  /** macOS App Translocation (PK3). */
  translocated,

  // outdatedLabel
  claudeMdSection: {
    pl: (section: string, reason: string) => `CLAUDE.md, sekcja ${section}: ${reason}`,
    en: (section: string, reason: string) => `CLAUDE.md, ${section} section: ${reason}`,
  },
  mcpJson: { pl: (reason: string) => `.mcp.json (serwer MCP): ${reason}`, en: (reason: string) => `.mcp.json (MCP server): ${reason}` },
  settingsJson: {
    pl: (reason: string) => `uprawnienia (.claude/settings.json): ${reason}`,
    en: (reason: string) => `permissions (.claude/settings.json): ${reason}`,
  },
  folder: { pl: (name: string, reason: string) => `folder ${name}/: ${reason}`, en: (name: string, reason: string) => `folder ${name}/: ${reason}` },
  codexLink: { pl: (name: string, reason: string) => `${name} (dla Codex): ${reason}`, en: (name: string, reason: string) => `${name} (for Codex): ${reason}` },
  ownFileConflict: { pl: "Twój plik o tej nazwie", en: "your own file with this name" },

  // workspaceSummary
  unknown: { pl: "nieznany", en: "unknown" },
  otherProfile: { pl: "folder innego profilu", en: "another profile's folder" },
  notCreated: { pl: "nie utworzono", en: "not created" },
  upToDate: { pl: "aktualny", en: "up to date" },
  localChanges: { pl: "zmiany lokalne", en: "local changes" },
  toUpdate: { pl: (n: number) => `do aktualizacji · ${n}`, en: (n: number) => `to update · ${n}` },

  // changesToast
  created: { pl: "Utworzono workspace", en: "Workspace created" },
  updated: { pl: (n: number) => `Zaktualizowano workspace (${n})`, en: (n: number) => `Workspace updated (${n})` },
  alreadyUpToDate: { pl: "Workspace jest aktualny", en: "The workspace is up to date" },
});

/** Why a workspace item is outdated. */
export const REASON = catalog({
  missing: { pl: "brak", en: "missing" },
  outdated: { pl: "nieaktualne", en: "outdated" },
  extra: { pl: "do usunięcia (moduł wyłączony)", en: "to remove (module off)" },
  modified: { pl: "zmienione lokalnie", en: "changed locally" },
  conflict: { pl: "Twój folder o tej nazwie", en: "your own folder with this name" },
  invalid: { pl: "nieczytelny plik", en: "unreadable file" },
  unsupported: { pl: "system nie pozwala utworzyć linku", en: "the system cannot create the link" },
});

/** CLAUDE.md sections. */
export const SECTION = catalog({
  layout: { pl: "układ agenta", en: "agent layout" },
  profile: { pl: "profil", en: "profile" },
  privacy: { pl: "prywatność", en: "privacy" },
  tools: { pl: "narzędzia MCP", en: "MCP tools" },
  boundaries: { pl: "granice", en: "boundaries" },
  files: { pl: "foldery", en: "folders" },
  skills: { pl: "skille", en: "skills" },
  research: { pl: "research", en: "research" },
});

/** Workspace API error codes (`X-Cashu-Error-Code`). */
export const ERRORS = catalog({
  path_required: { pl: "Podaj folder.", en: "Enter a folder." },
  path_relative: { pl: "Podaj pełną ścieżkę folderu (od / albo od ~).", en: "Enter the folder's full path (from / or ~)." },
  path_is_file: { pl: "Pod tą ścieżką jest plik, nie folder.", en: "This path is a file, not a folder." },
  path_home: { pl: "Wybierz osobny folder, nie cały katalog domowy ani dysk.", en: "Choose a separate folder, not the whole home folder or disk." },
  path_hidden: { pl: "Folder nie może leżeć w ukrytym katalogu.", en: "The folder cannot be inside a hidden folder." },
  path_data_dir: {
    pl: "Workspace musi leżeć poza katalogiem danych cashU i nie może go zawierać.",
    en: "The workspace must be outside the cashU data folder and cannot contain it.",
  },
  path_checkout: { pl: "Workspace nie może leżeć w katalogu z kodem cashU.", en: "The workspace cannot be inside the cashU code folder." },
  workspace_taken: { pl: "Ten folder jest (albo zawiera) workspace innego profilu.", en: "This folder is (or contains) another profile's workspace." },
  translocated,
  busy: { pl: "Workspace jest właśnie aktualizowany. Spróbuj za chwilę.", en: "The workspace is being updated right now. Try again in a moment." },
  write_failed: {
    pl: "Nie udało się zapisać plików w tym folderze (uprawnienia albo dysk).",
    en: "Could not write files in this folder (permissions or disk).",
  },
});
