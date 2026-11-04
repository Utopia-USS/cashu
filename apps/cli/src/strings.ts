// Texts the `cashu` shim prints itself (PL + EN, docs/agents/localization.md). Everything else the user
// sees comes from the host (or, for commands not ported yet, from the Python CLI). The language is the
// backend one (`@cashu/i18n` createBackendI18n: CASHU_LANG, settings.json, the OS, English), read
// through a Translator; MCP texts carry both languages (the agent reads them, Python's MCP output is
// fixed, not localized per user).
import type { SyncStatus } from "@cashu/host-protocol";
import type { TranslationVariants } from "@cashu/i18n";

type Text = TranslationVariants<string>;
type Fn<A extends unknown[]> = TranslationVariants<(...args: A) => string>;

export const S = {
  desktopUnavailable: {
    pl: "Nie można uruchomić aplikacji okienkowej cashU. W wersji deweloperskiej najpierw zbuduj @cashu/desktop.",
    en: "Cannot launch the cashU desktop app. In a development checkout, build @cashu/desktop first.",
  } satisfies Text,
  hostUnavailable: {
    pl: (log: string) =>
      `cashU nie może uruchomić usługi w tle. Sprawdź \`cashu host status\` i log ${log}.`,
    en: (log: string) =>
      `cashU could not start its background service. Check \`cashu host status\` and the log ${log}.`,
  } satisfies Fn<[string]>,
  hostOutdated: {
    pl: "Usługa cashU w tle pochodzi z innej wersji cashU. Uruchom `cashu host stop` i powtórz polecenie.",
    en: "The cashU background service is from another cashU version. Run `cashu host stop` and repeat the command.",
  } satisfies Text,
  hostRefused: {
    pl: "Usługa cashU w tle odmówiła połączenia (inny katalog danych albo nieudane uwierzytelnienie).",
    en: "The cashU background service refused the connection (another data dir, or authentication failed).",
  } satisfies Text,
  hostLost: {
    pl: "Połączenie z usługą cashU w tle zostało przerwane w trakcie polecenia.",
    en: "The connection to the cashU background service was lost while the command ran.",
  } satisfies Text,
  dataDirUnresolved: {
    pl: (detail: string) => `Nie można ustalić katalogu danych cashU: ${detail}.`,
    en: (detail: string) => `Cannot work out the cashU data dir: ${detail}.`,
  } satisfies Fn<[string]>,
  delegateFailed: {
    pl: "Nie można uruchomić części cashU w Pythonie.",
    en: "Cannot start the Python part of cashU.",
  } satisfies Text,

  // `cashu host ...`
  hostUsage: {
    pl: "użycie: cashu host <status|stop|run>\n  status  stan usługi w tle (kod 0 działa, 3 nie działa)\n  stop    zatrzymaj usługę w tle\n  run     uruchom usługę w tle na pierwszym planie",
    en: "usage: cashu host <status|stop|run>\n  status  show the background service (exit 0 running, 3 not running)\n  stop    stop the background service\n  run     run the background service in the foreground",
  } satisfies Text,
  hostNotRunning: {
    pl: "Usługa cashU w tle nie działa.",
    en: "The cashU background service is not running.",
  } satisfies Text,
  hostStopped: {
    pl: "Usługa cashU w tle została zatrzymana.",
    en: "The cashU background service stopped.",
  } satisfies Text,
  hostRunning: {
    pl: (pid: number, build: string, protocol: string) =>
      `Usługa cashU w tle działa (pid ${pid}, wersja ${build}, protokół ${protocol}).`,
    en: (pid: number, build: string, protocol: string) =>
      `The cashU background service is running (pid ${pid}, build ${build}, protocol ${protocol}).`,
  } satisfies Fn<[number, string, string]>,
  hostStarted: {
    pl: (at: string) => `  uruchomiona  ${at}`,
    en: (at: string) => `  started     ${at}`,
  } satisfies Fn<[string]>,
  hostSessions: {
    pl: (list: string) => `  sesje        ${list}`,
    en: (list: string) => `  sessions    ${list}`,
  } satisfies Fn<[string]>,
  hostStores: {
    pl: (vaults: string, pending: string) =>
      `  sejfy        ${vaults}, zapisy w kolejce ${pending}`,
    en: (vaults: string, pending: string) => `  vaults      ${vaults}, pending writes ${pending}`,
  } satisfies Fn<[string, string]>,
  hostSafeMode: {
    pl: (on: boolean) =>
      `  tryb awaryjny ${on ? "tak (bez zadań i sieci po powtarzających się awariach)" : "nie"}`,
    en: (on: boolean) =>
      `  safe mode   ${on ? "yes (no jobs, no network after repeated crashes)" : "no"}`,
  } satisfies Fn<[boolean]>,
  hostStopping: { pl: "  zatrzymuje się", en: "  stopping" } satisfies Text,
  hostSyncState: {
    pl: (state: SyncStatus["state"]) =>
      ({
        off: "wyłączona",
        refused: "odmowa uruchomienia",
        "safe-mode": "tryb awaryjny",
        uninitialized: "nieskonfigurowana",
        idle: "bezczynna",
        running: "działa",
        blocked: "zablokowana",
        error: "błąd",
        stopped: "zatrzymana",
      })[state],
    en: (state: SyncStatus["state"]) =>
      ({
        off: "off",
        refused: "refused",
        "safe-mode": "safe mode",
        uninitialized: "uninitialized",
        idle: "idle",
        running: "running",
        blocked: "blocked",
        error: "error",
        stopped: "stopped",
      })[state],
  } satisfies Fn<[SyncStatus["state"]]>,
  hostSyncNever: { pl: "nigdy", en: "never" } satisfies Text,
  hostSync: {
    pl: (state: string, pending: string, lastRun: string) =>
      `  synchronizacja ${state}, oczekujące ${pending}, ostatni przebieg ${lastRun}`,
    en: (state: string, pending: string, lastRun: string) =>
      `  sync        ${state}, pending ${pending}, last run ${lastRun}`,
  } satisfies Fn<[string, string, string]>,
  hostSyncVault: {
    pl: (ordinal: number, leader: boolean, intentOpen: boolean, pipeSeq: number) =>
      `    sejf ${ordinal}: lider ${leader ? "tak" : "nie"}, zamiar zapisu ${intentOpen ? "otwarty" : "zamknięty"}, kursor odbioru ${pipeSeq}`,
    en: (ordinal: number, leader: boolean, intentOpen: boolean, pipeSeq: number) =>
      `    vault ${ordinal}: leader ${leader ? "yes" : "no"}, intent ${intentOpen ? "open" : "closed"}, pipe ${pipeSeq}`,
  } satisfies Fn<[number, boolean, boolean, number]>,

  // `cashu mcp`: tool errors and diagnostics the agent reads (both languages at once).
  mcpLost: {
    pl: "Połączenie z usługą cashU w tle zostało przerwane, więc nie wiadomo, czy to wywołanie się wykonało. Sprawdź stan i dopiero wtedy je powtórz.",
    en: "The connection to the cashU background service was lost, so this call may or may not have run. Check the state before repeating it.",
  } satisfies Text,
  mcpUnavailable: {
    pl: "cashU nie może uruchomić usługi w tle; nic nie zostało wykonane. Sprawdź `cashu host status`.",
    en: "cashU could not start its background service; nothing was run. Check `cashu host status`.",
  } satisfies Text,
} as const;

/** An MCP text in both languages (Polish first, as the app's MCP output). */
export const bilingual = (text: Text) => `${text.pl} / ${text.en}`;
