// Texts of the Settings page (frontend/src/core/Settings.tsx). See docs/agents/localization.md.
import { catalog } from "../index.js";

type Tone = "pos" | "neg" | "warn" | undefined;

export const S = catalog({
  language: { pl: "Język", en: "Language" },
  languageSystem: { pl: "Systemowy", en: "System" },
  languageHint: { pl: "zmiana przeładuje aplikację", en: "changing it reloads the app" },

  sectionsNav: { pl: "Sekcje ustawień", en: "Settings sections" },

  // Profil
  name: { pl: "Nazwa", en: "Name" },
  baseCurrency: { pl: "Waluta bazowa", en: "Base currency" },
  baseCurrencyHint: {
    pl: "inne waluty osobno, bez przeliczania",
    en: "other currencies shown separately, not converted",
  },
  slug: { pl: "Identyfikator", en: "Identifier" },
  slugHint: { pl: "w poleceniach CLI i MCP", en: "in CLI and MCP commands" },

  // Moduły
  moduleSwitch: { pl: (name: string) => `Moduł ${name}`, en: (name: string) => `${name} module` },
  soonTitle: { pl: "Wkrótce", en: "Coming soon" },
  soon: { pl: "wkrótce", en: "coming soon" },
  offDataKept: {
    pl: (short: string) => `${short} · wyłączony, dane zachowane`,
    en: (short: string) => `${short} · off, data kept`,
  },
  configure: { pl: "Konfiguracja →", en: "Set up →" },

  // Agent AI
  workspaceTitle: {
    pl: "CLAUDE.md, .mcp.json, uprawnienia i skille modułów. Dane tylko przez MCP.",
    en: "CLAUDE.md, .mcp.json, permissions and module skills. Data only through MCP.",
  },
  workspace: { pl: "Workspace agenta", en: "Agent workspace" },
  mcpStaleTitle: {
    pl: "Serwer MCP w .mcp.json wskazuje poprzednią lokalizację aplikacji. Przycisk „Aktualizuj” zapisze nową.",
    en: "The MCP server in .mcp.json points to the app's previous location. Update writes the new one.",
  },
  mcpStale: { pl: "MCP: stara ścieżka", en: "MCP: old path" },
  updateTitle: {
    pl: "Odświeża CLAUDE.md, .mcp.json, uprawnienia i skille; Twoje pliki zostają.",
    en: "Refreshes CLAUDE.md, .mcp.json, permissions and skills; your own files stay.",
  },
  updating: { pl: "Aktualizuję…", en: "Updating…" },
  update: { pl: "Aktualizuj", en: "Update" },
  creating: { pl: "Tworzę…", en: "Creating…" },
  create: { pl: "Utwórz", en: "Create" },
  checking: { pl: "Sprawdzam…", en: "Checking…" },
  folder: { pl: "Folder", en: "Folder" },
  customFolder: { pl: "własny", en: "custom" },
  changeFolder: { pl: "Zmień folder", en: "Change folder" },
  newFolder: { pl: "Nowy folder", en: "New folder" },
  move: { pl: "Przenieś", en: "Move" },
  openInClaude: { pl: "Otwórz w Claude Code", en: "Open in Claude Code" },
  managed: { pl: "Zarządzane", en: "Managed" },
  skills: { pl: "skille", en: "skills" },
  none: { pl: "brak", en: "none" },
  folderConflict: {
    pl: "Ten folder jest workspace innego profilu. Wybierz inny folder.",
    en: "This folder is another profile's workspace. Choose a different folder.",
  },
  forceTitle: {
    pl: "Twoja wersja trafi do .claude/cashu-backup/.",
    en: "Your version goes to .claude/cashu-backup/.",
  },
  force: { pl: "Zastąp zmienione", en: "Replace changed files" },
  outdated: { pl: "Do aktualizacji:", en: "To update:" },
  createWorkspaceFirst: { pl: "Najpierw utwórz workspace", en: "Create the workspace first" },
  routineTitle: {
    pl: "Rutyny w chmurze nie widzą serwera MCP na tym komputerze.",
    en: "Cloud routines cannot reach the MCP server on this computer.",
  },
  routine: { pl: "Rutyna (lokalna)", en: "Routine (local)" },
  routineHint: {
    pl: "Claude › Code › Routines › Local · sobota 07:00 · ten folder",
    en: "Claude › Code › Routines › Local · Saturday 07:00 · this folder",
  },
  fromTerminal: { pl: "Z terminala", en: "From the terminal" },

  // Dziennik wywołań
  callLog: { pl: "Dziennik wywołań", en: "Call log" },
  last7Days: {
    pl: (n: number) => `ostatnie 7 dni · ${n}`,
    en: (n: number) => `last 7 days · ${n}`,
  },
  colTime: { pl: "Czas", en: "Time" },
  colTool: { pl: "Narzędzie", en: "Tool" },
  colArgs: { pl: "Argumenty", en: "Arguments" },
  colLevel: { pl: "Poziom", en: "Level" },
  colResult: { pl: "Wynik", en: "Result" },
  noCalls: { pl: "Brak wywołań.", en: "No calls." },
  argNamesOnly: { pl: "Nazwy argumentów, nigdy wartości.", en: "Argument names, never values." },

  // Dane
  dataDir: { pl: "Katalog danych", en: "Data folder" },
  copy: { pl: "Kopiuj", en: "Copy" },
  backups: { pl: "Kopie zapasowe", en: "Backups" },
  backupsHintBefore: { pl: "podkatalog ", en: "the " },
  backupsHintAfter: { pl: " w katalogu danych", en: " subfolder of the data folder" },

  // Praca w tle
  daily: { pl: "codziennie", en: "daily" },
  dailyAt: { pl: (t: string) => `codziennie ${t}`, en: (t: string) => `daily at ${t}` },
  everyDayAt: { pl: (t: string) => `Codziennie o ${t}`, en: (t: string) => `Every day at ${t}` },
  nextRun: {
    pl: (when: string) => ` · następne uruchomienie ${when}`,
    en: (when: string) => ` · next run ${when}`,
  },
  lastRun: { pl: (when: string) => ` · ostatni ${when}`, en: (when: string) => ` · last ${when}` },
  neverRun: { pl: " · jeszcze nie uruchomiono", en: " · not run yet" },
  colJob: { pl: "Zadanie", en: "Job" },
  colModule: { pl: "Moduł", en: "Module" },
  colSchedule: { pl: "Harmonogram", en: "Schedule" },
  colLast: { pl: "Ostatnio", en: "Last" },
  colStatus: { pl: "Status", en: "Status" },
  digestDay: { pl: "dzień podsumowania ze strategii", en: "digest day from the strategy" },
  bankLimit: {
    pl: (schedule: string) => `${schedule} (limit banku)`,
    en: (schedule: string) => `${schedule} (bank limit)`,
  },
  workerFoot: {
    pl: "Od razu tylko sygnały „do działania”, reszta w podsumowaniu tygodnia.",
    en: 'Only "act now" signals right away, the rest in the weekly digest.',
  },

  // Sekrety
  unknownStateTitle: {
    pl: "Serwer nie podaje tego stanu",
    en: "The server does not report this state",
  },
  unknownState: { pl: "stan nieznany", en: "state unknown" },
  ebKey: { pl: "Enable Banking · klucz prywatny", en: "Enable Banking · private key" },
  ebKeyHint: {
    pl: "plik .pem w katalogu danych · sesje każdego banku w bazie",
    en: ".pem file in the data folder · per-bank sessions in the database",
  },
  apiToken: { pl: "Token API aplikacji", en: "App API token" },
  apiTokenHint: {
    pl: "losowy przy starcie · tylko 127.0.0.1",
    en: "random at startup · 127.0.0.1 only",
  },
  secretsFoot: {
    pl: "Sekrety nie trafiają do logów, eksportów ani do agenta AI.",
    en: "Secrets never reach logs, exports or the AI agent.",
  },

  // Aplikacja
  theme: { pl: "Motyw", en: "Theme" },
  themeSystem: { pl: "Systemowy", en: "System" },
  themeLight: { pl: "Jasny", en: "Light" },
  themeDark: { pl: "Ciemny", en: "Dark" },
  themeHint: { pl: "zapisany w tej przeglądarce", en: "saved in this browser" },
  version: { pl: "Wersja", en: "Version" },
  updates: { pl: "Aktualizacje", en: "Updates" },
  updatesDaily: { pl: "Sprawdzaj codziennie", en: "Check daily" },
  updatesDailyTitle: {
    pl: "Po uruchomieniu i raz dziennie sprawdza, czy jest nowa wersja, i tylko o niej informuje; pobiera ją i instaluje dopiero po „Aktualizuj”",
    en: 'Checks for a new version after start and once a day and only tells you about it; downloads and installs it only after "Update"',
  },
  updatesDailyHint: {
    pl: (on: boolean): string => (on ? "codziennie" : "tylko na żądanie"),
    en: (on: boolean): string => (on ? "daily" : "on demand only"),
  },
  updatesCheck: { pl: "Sprawdź", en: "Check" },
});

/** Settings sections (nav + card titles). */
export const SECTION = catalog({
  profile: { pl: "Profil", en: "Profile" },
  modules: { pl: "Moduły", en: "Modules" },
  agent: { pl: "Agent AI (MCP)", en: "AI agent (MCP)" },
  connectors: { pl: "Konektory", en: "Connectors" },
  data: { pl: "Dane", en: "Data" },
  worker: { pl: "Praca w tle", en: "Background work" },
  secrets: { pl: "Sekrety", en: "Secrets" },
  app: { pl: "Aplikacja", en: "App" },
});

/** MCP call outcome -> [label, tone]. */
export const OUTCOME = catalog({
  ok: { pl: ["ok", "pos"] as [string, Tone], en: ["ok", "pos"] },
  error: { pl: ["błąd", "neg"] as [string, Tone], en: ["error", "neg"] },
  refused: { pl: ["odmowa", "warn"] as [string, Tone], en: ["refused", "warn"] },
});

/** Privacy level, short (the call log). */
export const PRIVACY_SHORT = catalog({
  strict: { pl: "ścisły", en: "strict" },
  amounts: { pl: "z kwotami", en: "with amounts" },
});

/** Worker job -> [label, module]. */
export const JOB_LABEL = catalog({
  "investments.daily": {
    pl: ["Sprawdzenie reguł", "Inwestycje"] as [string, string],
    en: ["Rule check", "Investments"],
  },
  "budget.sync": {
    pl: ["Synchronizacja banków", "Budżet"] as [string, string],
    en: ["Bank sync", "Budget"],
  },
  notifications: {
    pl: ["Powiadomienia", "wszystkie"] as [string, string],
    en: ["Notifications", "all"],
  },
  digest: {
    pl: ["Podsumowanie tygodnia", "wszystkie"] as [string, string],
    en: ["Weekly digest", "all"],
  },
});

/** Worker run status -> [label, tone]. */
export const JOB_STATUS = catalog({
  ok: { pl: ["ok", "pos"] as [string, Tone], en: ["ok", "pos"] },
  partial: { pl: ["częściowy", "warn"] as [string, Tone], en: ["partial", "warn"] },
  failed: { pl: ["błąd", "neg"] as [string, Tone], en: ["error", "neg"] },
  skipped: { pl: ["pominięty", undefined] as [string, Tone], en: ["skipped", undefined] },
});
