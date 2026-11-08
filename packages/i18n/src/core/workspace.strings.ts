// Texts of the agent workspace helpers (frontend/src/core/workspace.ts), shared by the wizard, Settings and the
// setup page. See docs/agents/localization.md.
import { catalog } from "../index.js";

const translocated = {
  pl: "Aplikacja działa z tymczasowej lokalizacji macOS: przenieś cashU.app do folderu Programy i otwórz ją ponownie.",
  en: "The app runs from a temporary macOS location: move cashU.app to the Applications folder and open it again.",
};

export const WS = catalog({
  /** Copy of the opt-in routine permissions switch (wizard and Settings). */
  routinePermissionsLabel: {
    pl: "Rutyna bez pytań o zgodę",
    en: "Routine without permission prompts",
  },
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
  mcpJson: {
    pl: (reason: string) => `.mcp.json (serwer MCP): ${reason}`,
    en: (reason: string) => `.mcp.json (MCP server): ${reason}`,
  },
  settingsJson: {
    pl: (reason: string) => `uprawnienia (.claude/settings.json): ${reason}`,
    en: (reason: string) => `permissions (.claude/settings.json): ${reason}`,
  },
  folder: {
    pl: (name: string, reason: string) => `folder ${name}/: ${reason}`,
    en: (name: string, reason: string) => `folder ${name}/: ${reason}`,
  },
  codexLink: {
    pl: (name: string, reason: string) => `${name} (dla Codex): ${reason}`,
    en: (name: string, reason: string) => `${name} (for Codex): ${reason}`,
  },
  ownFileConflict: { pl: "Twój plik o tej nazwie", en: "your own file with this name" },

  // workspaceSummary
  unknown: { pl: "nieznany", en: "unknown" },
  otherProfile: { pl: "folder innego profilu", en: "another profile's folder" },
  notCreated: { pl: "nie utworzono", en: "not created" },
  upToDate: { pl: "aktualny", en: "up to date" },
  localChanges: { pl: "zmiany lokalne", en: "local changes" },
  toUpdate: { pl: (n: number) => `do aktualizacji · ${n}`, en: (n: number) => `to update · ${n}` },
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
