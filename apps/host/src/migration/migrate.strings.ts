// What `cashu migrate` and `cashu migrate verify` print in human mode (PL + EN). Values are counts,
// enum codes, an ISO time, the backup directory's name, `~`-relative paths and the public tickers of
// instruments the app cannot price; never personal data or words.
import type {
  MigrateStage,
  PythonAgentRetirement,
  StartupFailureCode,
} from "@cashu/host-protocol/startup-failure";
import type { TranslationVariants } from "@cashu/i18n";

type Text = TranslationVariants<string>;
type Fn<A extends unknown[]> = TranslationVariants<(...args: A) => string>;

export interface MigrateCounts {
  readonly profiles: number;
  readonly financialTables: number;
  readonly financialRows: number;
  readonly vaults: number;
}

type AgentState = PythonAgentRetirement["agents"][number]["state"];

// The same words as the app's import screen (apps/desktop/renderer/shell/Recovery.strings.ts).
const AGENT_STATE_PL: Record<AgentState, string> = {
  retired: "usunięto",
  absent: "nie znaleziono",
  failed: "nie udało się usunąć",
  skipped: "nie sprawdzono",
};
const AGENT_STATE_EN: Record<AgentState, string> = {
  retired: "removed",
  absent: "not found",
  failed: "could not be removed",
  skipped: "not checked",
};

const agentList = (r: PythonAgentRetirement, states: Record<AgentState, string>) =>
  r.agents.map((agent) => `${agent.label} (${states[agent.state]})`).join(", ");

/** An instrument the app cannot price after the import (`priceReach.ts`). */
export interface UnpricedLine {
  readonly label: string;
  readonly currency: string;
  readonly reason: "no_prices" | "no_fx";
}

export const M = {
  usage: {
    pl: [
      "użycie: cashu migrate [--recovery-file <ścieżka>] [--json]",
      "        cashu migrate verify [--json]",
      "  migrate         importuje dane starej aplikacji (Python) do tego folderu danych, wszystko albo nic;",
      "                  oryginalne pliki trafiają nienaruszone do python-backup-<czas>/ w tym folderze",
      "  --recovery-file nowy plik (ścieżka bezwzględna poza folderem danych), do którego trafią słowa",
      "                  odzyskiwania; wymagany bez --json",
      "  verify          porównuje zaimportowane dane z kopią zapasową danych Pythona; niczego nie zmienia",
      "  --json          protokół aplikacji: jeden obiekt JSON na wiersz (słowa potwierdza wiersz `confirm`)",
    ].join("\n"),
    en: [
      "usage: cashu migrate [--recovery-file <path>] [--json]",
      "       cashu migrate verify [--json]",
      "  migrate         imports the old (Python) app's data into this data folder, all or nothing;",
      "                  the original files move intact into python-backup-<time>/ in this folder",
      "  --recovery-file a new file (absolute path outside the data folder) that receives the",
      "                  recovery words; required without --json",
      "  verify          compares the imported data with the backup of the Python data; changes nothing",
      "  --json          the app's protocol: one JSON object per line (a `confirm` line accepts the words)",
    ].join("\n"),
  } satisfies Text,
  stage: {
    pl: (stage: MigrateStage) =>
      ({
        preflight: "Sprawdzanie folderu danych...",
        copy: "Kopiowanie danych Pythona do folderu roboczego...",
        import: "Importowanie kopii...",
        verify: "Weryfikacja importu...",
        cutover: "Przenoszenie oryginałów do kopii zapasowej i włączanie nowych danych...",
      })[stage],
    en: (stage: MigrateStage) =>
      ({
        preflight: "Checking the data folder...",
        copy: "Copying the Python data into a working folder...",
        import: "Importing the copy...",
        verify: "Verifying the import...",
        cutover: "Moving the originals into the backup and switching to the new data...",
      })[stage],
  } satisfies Fn<[MigrateStage]>,
  wordsSaved: {
    pl: (file: string) =>
      `Słowa odzyskiwania zapisano w ${file}. Przechowuj je bezpiecznie, a po zrobieniu kopii usuń ten plik.`,
    en: (file: string) =>
      `The recovery words were saved to ${file}. Keep them safe, and delete this file once backed up.`,
  } satisfies Fn<[string]>,
  migrated: {
    pl: (c: MigrateCounts, backup: string) =>
      `Import zakończony: profile ${c.profiles}, tabele ${c.financialTables}, wiersze ${c.financialRows}, sejfy ${c.vaults}. Oryginalne pliki: ${backup}.`,
    en: (c: MigrateCounts, backup: string) =>
      `Import finished: profiles ${c.profiles}, tables ${c.financialTables}, rows ${c.financialRows}, vaults ${c.vaults}. Original files: ${backup}.`,
  } satisfies Fn<[MigrateCounts, string]>,
  alreadyMigrated: {
    pl: (at: string, backup: string) =>
      `Ten folder danych został już zaimportowany (${at}); niczego nie zmieniono. Oryginalne pliki: ${backup}.`,
    en: (at: string, backup: string) =>
      `This data folder was already imported (${at}); nothing was changed. Original files: ${backup}.`,
  } satisfies Fn<[string, string]>,
  verifyHint: {
    pl: "Sprawdź import poleceniem: cashu migrate verify",
    en: "Check the import with: cashu migrate verify",
  } satisfies Text,
  verified: {
    pl: (c: MigrateCounts, backup: string) =>
      `Weryfikacja zgodna: profile ${c.profiles}, tabele ${c.financialTables}, wiersze ${c.financialRows}, sejfy ${c.vaults} (źródło: ${backup}).`,
    en: (c: MigrateCounts, backup: string) =>
      `Verification passed: profiles ${c.profiles}, tables ${c.financialTables}, rows ${c.financialRows}, vaults ${c.vaults} (source: ${backup}).`,
  } satisfies Fn<[MigrateCounts, string]>,
  unpriced: {
    pl: (items: readonly UnpricedLine[]) =>
      [
        `Uwaga: aplikacja nie wyceni ${items.length} instrumentów (wartość 0 zł, dopóki nie będzie notowań):`,
        ...items.map(
          (i) =>
            `  ${i.label} (${i.currency}): ${i.reason === "no_fx" ? `brak kursu PLN/${i.currency}` : "brak notowań"}`,
        ),
      ].join("\n"),
    en: (items: readonly UnpricedLine[]) =>
      [
        `Warning: the app cannot value ${items.length} instruments (0 until it has prices):`,
        ...items.map(
          (i) =>
            `  ${i.label} (${i.currency}): ${i.reason === "no_fx" ? `no PLN/${i.currency} rate` : "no prices"}`,
        ),
      ].join("\n"),
  } satisfies Fn<[readonly UnpricedLine[]]>,
  agents: {
    pl: (r: PythonAgentRetirement) =>
      `Usługi w tle starej aplikacji (launchd): ${agentList(r, AGENT_STATE_PL)}.${r.bootout === "skipped" && r.agents.some((a) => a.state === "retired") ? " Usunięto tylko pliki plist (launchctl nie był użyty: własny folder agentów)." : ""}`,
    en: (r: PythonAgentRetirement) =>
      `The old app's background agents (launchd): ${agentList(r, AGENT_STATE_EN)}.${r.bootout === "skipped" && r.agents.some((a) => a.state === "retired") ? " Only the plist files were removed (launchctl not used: custom agents folder)." : ""}`,
  } satisfies Fn<[PythonAgentRetirement]>,
  agentsByHand: {
    pl: (commands: readonly string[]) =>
      ["Dokończ ręcznie:", ...commands.map((line) => `  ${line}`)].join("\n"),
    en: (commands: readonly string[]) =>
      ["Finish by hand:", ...commands.map((line) => `  ${line}`)].join("\n"),
  } satisfies Fn<[readonly string[]]>,
  mcp: {
    pl: (commands: readonly string[]) =>
      [
        "Podłącz ponownie serwery MCP w Claude Code (stare wpisy wskazują na usuniętą aplikację). Dla każdego profilu:",
        ...commands.map((line) => `  ${line}`),
      ].join("\n"),
    en: (commands: readonly string[]) =>
      [
        "Re-add your MCP servers in Claude Code (the old entries point at the removed app). For each profile:",
        ...commands.map((line) => `  ${line}`),
      ].join("\n"),
  } satisfies Fn<[readonly string[]]>,
  mcpUnknown: {
    pl: "Podłącz ponownie serwery MCP w Claude Code: polecenia są w aplikacji, Ustawienia > Agent AI (MCP).",
    en: "Re-add your MCP servers in Claude Code: the commands are in the app, Settings > AI agent (MCP).",
  } satisfies Text,
  failed: {
    pl: (code: StartupFailureCode, detail: string) =>
      `Import się nie powiódł (${code}${detail === "" ? "" : `, ${detail}`}).`,
    en: (code: StartupFailureCode, detail: string) =>
      `The import failed (${code}${detail === "" ? "" : `, ${detail}`}).`,
  } satisfies Fn<[StartupFailureCode, string]>,
  verifyFailed: {
    pl: (code: StartupFailureCode, detail: string) =>
      `Weryfikacja się nie powiodła (${code}${detail === "" ? "" : `, ${detail}`}). Niczego nie zmieniono.`,
    en: (code: StartupFailureCode, detail: string) =>
      `Verification failed (${code}${detail === "" ? "" : `, ${detail}`}). Nothing was changed.`,
  } satisfies Fn<[StartupFailureCode, string]>,
  originalsUntouched: {
    pl: "Oryginalne pliki Pythona pozostały nietknięte.",
    en: "The original Python files are untouched.",
  } satisfies Text,
  incomplete: {
    pl: "Przenoszenie zostało przerwane; uruchom ponownie `cashu migrate`, aby je dokończyć.",
    en: "Moving the files was interrupted; run `cashu migrate` again to finish it.",
  } satisfies Text,
  report: {
    pl: (file: string) => `Raport dla asystenta: ${file}`,
    en: (file: string) => `Report for your assistant: ${file}`,
  } satisfies Fn<[string]>,
} as const;
