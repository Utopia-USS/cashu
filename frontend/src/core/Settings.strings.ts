// Texts of the Settings page (src/core/Settings.tsx). See src/i18n.ts.
import { catalog } from "../i18n.ts";

type Tone = "pos" | "neg" | "warn" | undefined;

export const S = catalog({
  language: { pl: "Język", en: "Language" },
  languageSystem: { pl: "Systemowy", en: "System" },
  languageHint: { pl: "zmiana przeładuje aplikację", en: "changing it reloads the app" },

  sectionsNav: { pl: "Sekcje ustawień", en: "Settings sections" },

  // Profil
  nameRequired: { pl: "Podaj nazwę profilu.", en: "Enter a profile name." },
  nameTaken: { pl: "Profil o tej nazwie już istnieje.", en: "A profile with this name already exists." },
  name: { pl: "Nazwa", en: "Name" },
  baseCurrency: { pl: "Waluta bazowa", en: "Base currency" },
  baseCurrencyHint: { pl: "inne waluty osobno, bez przeliczania", en: "other currencies shown separately, not converted" },
  slug: { pl: "Identyfikator", en: "Identifier" },
  slugHint: { pl: "w poleceniach CLI i MCP", en: "in CLI and MCP commands" },

  // Moduły
  modulesSaveFailed: { pl: (err: string) => `Nie udało się zapisać modułów: ${err}`, en: (err: string) => `Could not save the modules: ${err}` },
  moduleSwitch: { pl: (name: string) => `Moduł ${name}`, en: (name: string) => `${name} module` },
  soonTitle: { pl: "Wkrótce", en: "Coming soon" },
  soon: { pl: "wkrótce", en: "coming soon" },
  offDataKept: { pl: (short: string) => `${short} · wyłączony, dane zachowane`, en: (short: string) => `${short} · off, data kept` },
  configure: { pl: "Konfiguracja →", en: "Set up →" },

  // Agent AI
  privacySaveFailed: { pl: (err: string) => `Nie udało się zapisać poziomu: ${err}`, en: (err: string) => `Could not save the level: ${err}` },
  workspaceTitle: {
    pl: "CLAUDE.md, .mcp.json, uprawnienia i skille modułów. Dane tylko przez MCP.",
    en: "CLAUDE.md, .mcp.json, permissions and module skills. Data only through MCP.",
  },
  workspace: { pl: "Workspace agenta", en: "Agent workspace" },
  mcpStaleTitle: {
    pl: "Serwer MCP w .mcp.json wskazuje poprzednią lokalizację aplikacji. Aktualizuj zapisze nową.",
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
  workspaceCheckFailed: { pl: (err: string) => `Nie udało się sprawdzić workspace: ${err}`, en: (err: string) => `Could not check the workspace: ${err}` },
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
  forceTitle: { pl: "Twoja wersja trafi do .claude/cashu-backup/.", en: "Your version goes to .claude/cashu-backup/." },
  force: { pl: "Zastąp zmienione", en: "Replace changed files" },
  outdated: { pl: "Do aktualizacji:", en: "To update:" },
  createWorkspaceFirst: { pl: "Najpierw utwórz workspace", en: "Create the workspace first" },
  routineTitle: { pl: "Rutyny w chmurze nie widzą serwera MCP na tym komputerze.", en: "Cloud routines cannot reach the MCP server on this computer." },
  routine: { pl: "Rutyna (lokalna)", en: "Routine (local)" },
  routineHint: { pl: "Claude › Code › Routines › Local · sobota 07:00 · ten folder", en: "Claude › Code › Routines › Local · Saturday 07:00 · this folder" },
  fromTerminal: { pl: "Z terminala", en: "From the terminal" },
  workspaceSaveFailed: { pl: (err: string) => `Nie udało się zapisać workspace. ${err}`, en: (err: string) => `Could not save the workspace. ${err}` },

  // Dziennik wywołań
  callLog: { pl: "Dziennik wywołań", en: "Call log" },
  last7Days: { pl: (n: number) => `ostatnie 7 dni · ${n}`, en: (n: number) => `last 7 days · ${n}` },
  callLogFailed: { pl: (err: string) => `Nie udało się pobrać dziennika: ${err}`, en: (err: string) => `Could not load the log: ${err}` },
  colTime: { pl: "Czas", en: "Time" },
  colTool: { pl: "Narzędzie", en: "Tool" },
  colArgs: { pl: "Argumenty", en: "Arguments" },
  colLevel: { pl: "Poziom", en: "Level" },
  colResult: { pl: "Wynik", en: "Result" },
  callLogUnavailable: { pl: "Dziennik niedostępny.", en: "Log unavailable." },
  noCalls: { pl: "Brak wywołań.", en: "No calls." },
  argNamesOnly: { pl: "Nazwy argumentów, nigdy wartości.", en: "Argument names, never values." },

  // Dane
  dataDir: { pl: "Katalog danych", en: "Data folder" },
  copied: { pl: "Skopiowano", en: "Copied" },
  copy: { pl: "Kopiuj", en: "Copy" },
  backups: { pl: "Kopie zapasowe", en: "Backups" },
  backupsHintBefore: { pl: "podkatalog ", en: "the " },
  backupsHintAfter: { pl: " w katalogu danych", en: " subfolder of the data folder" },
  legacyDb: { pl: "Stara baza: ", en: "Old database: " },
  legacyDbAfter: { pl: ". Zamknij aplikację i uruchom:", en: ". Quit the app and run:" },

  // Praca w tle
  runDone: { pl: (status: string) => `Przebieg zakończony · ${status}`, en: (status: string) => `Run finished · ${status}` },
  installed: { pl: "Praca w tle zainstalowana", en: "Background work installed" },
  uninstalled: { pl: "Praca w tle odinstalowana", en: "Background work uninstalled" },
  workerBusy: { pl: "Praca w tle właśnie działa - spróbuj za chwilę.", en: "Background work is running right now - try again in a moment." },
  noScheduler: { pl: "Ten system nie ma obsługiwanego harmonogramu zadań.", en: "This system has no supported task scheduler." },
  noSchedulerTitle: { pl: "Ten system nie ma obsługiwanego harmonogramu zadań", en: "This system has no supported task scheduler" },
  daily: { pl: "codziennie", en: "daily" },
  dailyAt: { pl: (t: string) => `codziennie ${t}`, en: (t: string) => `daily at ${t}` },
  notSaved: { pl: (err: string) => `Nie zapisano: ${err}`, en: (err: string) => `Not saved: ${err}` },
  installing: { pl: "Instaluję…", en: "Installing…" },
  reinstall: { pl: "Zainstaluj ponownie", en: "Reinstall" },
  mcpReaddedTitle: { pl: "Serwer MCP dodany ponownie w Claude Code / Claude Desktop", en: "MCP server added again in Claude Code / Claude Desktop" },
  saving: { pl: "Zapisuję…", en: "Saving…" },
  everyDayAt: { pl: (t: string) => `Codziennie o ${t}`, en: (t: string) => `Every day at ${t}` },
  noInstallTitle: { pl: "Serwer nie obsługuje jeszcze instalacji z aplikacji", en: "The server does not support installing from the app yet" },
  running: { pl: "działa", en: "running" },
  notInstalled: { pl: "nie zainstalowano", en: "not installed" },
  nextRun: { pl: (when: string) => ` · następny przebieg ${when}`, en: (when: string) => ` · next run ${when}` },
  lastRun: { pl: (when: string) => ` · ostatni ${when}`, en: (when: string) => ` · last ${when}` },
  neverRun: { pl: " · jeszcze nie uruchomiono", en: " · not run yet" },
  runNowTitle: {
    pl: "Jeden przebieg teraz: reguły inwestycji, synchronizacja banków (jeśli skonfigurowana), powiadomienia",
    en: "One run now: investment rules, bank sync (if set up), notifications",
  },
  starting: { pl: "Uruchamiam…", en: "Starting…" },
  runNow: { pl: "Uruchom teraz", en: "Run now" },
  hour: { pl: "Godzina", en: "Time" },
  timeTitle: {
    pl: "Czas lokalny. Uśpiony Mac nadrobi po wybudzeniu, wyłączony pominie dzień.",
    en: "Local time. A sleeping Mac catches up when it wakes; a Mac that is off skips the day.",
  },
  log: { pl: "Dziennik", en: "Log" },
  colJob: { pl: "Zadanie", en: "Job" },
  colModule: { pl: "Moduł", en: "Module" },
  colSchedule: { pl: "Harmonogram", en: "Schedule" },
  colLast: { pl: "Ostatnio", en: "Last" },
  colStatus: { pl: "Status", en: "Status" },
  digestDay: { pl: "dzień podsumowania ze strategii", en: "digest day from the strategy" },
  bankLimit: { pl: (schedule: string) => `${schedule} (limit banku)`, en: (schedule: string) => `${schedule} (bank limit)` },
  workerFoot: {
    pl: "Natychmiast tylko sygnały „do działania\", reszta w podsumowaniu tygodnia.",
    en: "Only \"act now\" signals right away, the rest in the weekly digest.",
  },

  // Sekrety
  unknownStateTitle: { pl: "Serwer nie podaje tego stanu", en: "The server does not report this state" },
  unknownState: { pl: "stan nieznany", en: "state unknown" },
  anthropicKey: { pl: "Klucz API Anthropic", en: "Anthropic API key" },
  inKeychain: { pl: "w pęku kluczy", en: "in the keychain" },
  anthropicKeyHint: { pl: "pęk kluczy · kategoryzacja (Budżet), backend anthropic", en: "keychain · categorization (Budget), anthropic backend" },
  ebKey: { pl: "Enable Banking · klucz prywatny", en: "Enable Banking · private key" },
  inDataDir: { pl: "w katalogu danych", en: "in the data folder" },
  ebKeyHint: { pl: "plik .pem w katalogu danych · sesje per bank w bazie", en: ".pem file in the data folder · per-bank sessions in the database" },
  apiToken: { pl: "Token API aplikacji", en: "App API token" },
  apiTokenHint: { pl: "losowy przy starcie · tylko 127.0.0.1", en: "random at startup · 127.0.0.1 only" },
  secretsFoot: { pl: "Sekrety nie trafiają do logów, eksportów ani do agenta AI.", en: "Secrets never reach logs, exports or the AI agent." },

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
    pl: "Raz dziennie sprawdza, czy jest nowa wersja; pobiera ją dopiero po „Aktualizuj”",
    en: "Checks once a day for a new version; downloads it only after \"Update\"",
  },
  updatesDailyHint: { pl: (on: boolean): string => (on ? "codziennie" : "tylko na żądanie"), en: (on: boolean): string => (on ? "daily" : "on demand only") },
  updatesCheck: { pl: "Sprawdź", en: "Check" },
  updatesToast: {
    pl: (on: boolean): string => (on ? "Codzienne sprawdzanie włączone" : "Codzienne sprawdzanie wyłączone"),
    en: (on: boolean): string => (on ? "Daily check on" : "Daily check off"),
  },
  updatesSaveFailed: { pl: (err: string) => `Nie udało się zapisać: ${err}`, en: (err: string) => `Could not save: ${err}` },
  updatesCheckFailed: { pl: (err: string) => `Nie udało się sprawdzić: ${err}`, en: (err: string) => `Could not check: ${err}` },
  migrationFailed: { pl: "Przeniesienie danych z poprzedniej wersji nie powiodło się.", en: "Moving the data from the previous version failed." },
  migrationFailedHint: { pl: " Zamknij inne okna aplikacji i uruchom ją ponownie.", en: " Close the app's other windows and start it again." },
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
  "investments.daily": { pl: ["Sprawdzenie reguł", "Inwestycje"] as [string, string], en: ["Rule check", "Investments"] },
  "budget.sync": { pl: ["Synchronizacja banków", "Budżet"] as [string, string], en: ["Bank sync", "Budget"] },
  notifications: { pl: ["Powiadomienia", "wszystkie"] as [string, string], en: ["Notifications", "all"] },
  digest: { pl: ["Podsumowanie tygodnia", "wszystkie"] as [string, string], en: ["Weekly digest", "all"] },
});

/** Worker run status -> [label, tone]. */
export const JOB_STATUS = catalog({
  ok: { pl: ["ok", "pos"] as [string, Tone], en: ["ok", "pos"] },
  partial: { pl: ["częściowy", "warn"] as [string, Tone], en: ["partial", "warn"] },
  failed: { pl: ["błąd", "neg"] as [string, Tone], en: ["error", "neg"] },
  skipped: { pl: ["pominięte", undefined] as [string, Tone], en: ["skipped", undefined] },
});

/** Steps of the data-dir rename migration. */
export const MIGRATION_STEP = catalog({
  data_dir: { pl: "katalog danych", en: "data folder" },
  db_file: { pl: "plik bazy", en: "database file" },
  keychain: { pl: "pęk kluczy", en: "keychain" },
  launchd: { pl: "praca w tle", en: "background work" },
});
