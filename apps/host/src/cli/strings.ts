// Texts the host's CLI runner prints itself (PL + EN, docs/agents/localization.md), resolved with the
// command's own Translator (its CASHU_LANG / locale, settings.json, the OS).
import type { TranslationVariants } from "@cashu/i18n";

export const S = {
  rootHelp: {
    pl: (commands: string) =>
      `Użycie: cashu [--profile PROFIL] POLECENIE [ARGUMENTY]\n\nPolecenia: ${commands}\n\nAplikacja: cashu app\nSerwer MCP: cashu mcp --profile PROFIL\nUsługa: cashu host status|stop|run\nPomoc: cashu --help`,
    en: (commands: string) =>
      `Usage: cashu [--profile PROFILE] COMMAND [ARGS]\n\nCommands: ${commands}\n\nDesktop app: cashu app\nMCP server: cashu mcp --profile PROFILE\nBackground service: cashu host status|stop|run\nHelp: cashu --help`,
  },
  missingCommand: {
    pl: "Podaj polecenie. Użyj `cashu --help`, aby zobaczyć dostępne polecenia.",
    en: "Provide a command. Run `cashu --help` to see available commands.",
  },
  mcpUsage: {
    pl: "Użycie: cashu mcp --profile PROFIL. Serwer MCP wymaga jednego profilu.",
    en: "Usage: cashu mcp --profile PROFILE. The MCP server requires one profile.",
  },
  investmentAccountGid: {
    pl: "Podaj pełny identyfikator GID konta z `cashu invest accounts list` przez `--account GID`.",
    en: "Use the full account GID from `cashu invest accounts list` with `--account GID`.",
  },
  investmentAccountUnknown: {
    pl: "Konto o tym GID nie należy do wybranego profilu inwestycyjnego.",
    en: "No brokerage account with that GID belongs to the selected investment profile.",
  },
  investmentSearchUnavailable: {
    pl: "Wyszukiwanie online jest niedostępne; pokazuję instrumenty z tego profilu.",
    en: "Online search is unavailable; showing this profile's instruments.",
  },
  retiredInitDb: {
    pl: "`cashu init-db` zostało wycofane. Uruchom `cashu app`; natywny sejf jest tworzony podczas konfiguracji profilu.",
    en: "`cashu init-db` was retired. Run `cashu app`; the native vault is created during profile setup.",
  },
  retiredMigrateData: {
    pl: "`cashu migrate-data` zostało wycofane. Dane starej aplikacji importuje `cashu migrate --recovery-file <nowy plik>` (w tym samym folderze danych), a sprawdza `cashu migrate verify`.",
    en: "`cashu migrate-data` was retired. `cashu migrate --recovery-file <new file>` imports the old app's data (in the same data folder), and `cashu migrate verify` checks it.",
  },
  retiredServe: {
    pl: "`cashu serve` zostało wycofane. Uruchom `cashu app`, aby otworzyć lokalną aplikację.",
    en: "`cashu serve` was retired. Run `cashu app` to open the local app.",
  },
  retiredOutbox: {
    pl: "Polecenia outbox zostały wycofane. Sprawdź synchronizację w Ustawieniach aplikacji `cashu app`.",
    en: "Outbox commands were retired. Check sync in Settings in `cashu app`.",
  },
  retiredSecrets: {
    pl: "`cashu secrets` zostało wycofane. Zarządzaj sekretami konektorów w Ustawieniach aplikacji `cashu app`.",
    en: "`cashu secrets` was retired. Manage connector secrets in Settings in `cashu app`.",
  },
  retiredSync: {
    pl: "`cashu sync` zostało wycofane. Zarządzaj synchronizacją w Ustawieniach aplikacji `cashu app`.",
    en: "`cashu sync` was retired. Manage sync in Settings in `cashu app`.",
  },
  unsupported: {
    pl: "Nieznane lub nieobsługiwane polecenie albo argumenty. Sprawdź składnię i spróbuj ponownie.",
    en: "Unknown or unsupported command or arguments. Check the syntax and try again.",
  } satisfies TranslationVariants<string>,
  busy: {
    pl: "Ta sesja wykonuje już polecenie.",
    en: "This session is already running a command.",
  } satisfies TranslationVariants<string>,
} as const;
