// Texts of the copy-paste agent prompt (the recovery screen's "Copy prompt for agent"), PL + EN
// (docs/agents/localization.md). Resolved with an explicit language, because Electron main has no UI
// language source. The commands, codes and tool names inside stay as they are.
import type { StartupFailureCode } from "./codes.js";

export type PromptLang = "pl" | "en";

export const PROMPT = {
  intro: {
    pl: "cashU nie uruchomił się. Pomóż mi zdiagnozować problem. Poniżej są tylko kody, etapy, liczby i ścieżki względem katalogu domowego - żadnych moich danych finansowych.",
    en: "cashU could not start. Please help me diagnose it. Below are only codes, stages, counts and paths relative to my home folder - none of my financial data.",
  },
  introOldData: {
    pl: "cashU znalazł w swoim folderze danych dane starej aplikacji cashU (Python). Aplikacja ich nie importuje; pomóż mi je przenieść. Poniżej są tylko kody, etapy, liczby i ścieżki względem katalogu domowego - żadnych moich danych finansowych.",
    en: "cashU found data of the old (Python) cashU app in its data folder. The app does not import it; please help me bring it over. Below are only codes, stages, counts and paths relative to my home folder - none of my financial data.",
  },
  app: { pl: "Aplikacja", en: "App" },
  build: { pl: "kompilacja", en: "build" },
  code: { pl: "Kod błędu", en: "Failure code" },
  detail: { pl: "Szczegół", en: "Detail" },
  stage: { pl: "Etap", en: "Stage" },
  at: { pl: "Czas", en: "Time" },
  originals: { pl: "Oryginalne pliki nietknięte", en: "Original files untouched" },
  yes: { pl: "tak", en: "yes" },
  notConfirmed: { pl: "nie potwierdzono", en: "not confirmed" },
  facts: { pl: "Fakty (liczby)", en: "Facts (counts)" },
  none: { pl: "brak", en: "none" },
  dataDir: { pl: "Folder danych", en: "Data folder" },
  reportFile: { pl: "Raport diagnostyczny", en: "Diagnostics report" },
  meaning: { pl: "Co oznacza ten kod", en: "What this code means" },
  logTitle: {
    pl: "Ostatnie wpisy logu usługi w tle (tylko kody)",
    en: "Recent background service log (codes only)",
  },
  logEmpty: { pl: "(brak wpisów)", en: "(no entries)" },
  omitted: {
    pl: (n: number) => `(pominięto wierszy bez kodu: ${n})`,
    en: (n: number) => `(lines without a code left out: ${n})`,
  },
  oldDataTitle: {
    pl: "Jak przenieść stare dane (robisz to Ty, agent, przez funkcje importu aplikacji):",
    en: "How to bring the old data over (you, the agent, do it through the app's import paths):",
  },
  oldDataSetup: {
    pl: (mcp: string) =>
      `Poproś mnie o wybranie w aplikacji „Kontynuuj bez starych danych” i założenie profilu, potem podłącz serwer MCP profilu: \`${mcp}\`.`,
    en: (mcp: string) =>
      `Ask me to choose "Continue without the old data" in the app and create the profile, then connect the profile's MCP server: \`${mcp}\`.`,
  },
  oldDataSkill: {
    pl: "Pracuj w workspace agenta tego profilu według skilla import-builder, sekcja „Old cashU (Python) data”.",
    en: 'Work in the profile\'s agent workspace and follow the import-builder skill, section "Old cashU (Python) data".',
  },
  oldDataBlind: {
    pl: "Nigdy nie oglądaj wartości ze starej bazy (kwot, numerów kont, IBAN-ów, nazw, tytułów): schemat poznaj tylko z nazw tabel i kolumn (`.schema` na kopii) oraz z historii repozytorium cashU, a wynik sprawdzaj narzędziami bez wartości (`inspect_export`, `validate_import`, `validate_budget_import`).",
    en: "Never look at the values in the old database (amounts, account numbers, IBANs, names, titles): learn its schema only from table and column names (`.schema` on a copy) and the cashU repository history, and check your output with value-free tools (`inspect_export`, `validate_import`, `validate_budget_import`).",
  },
  oldDataConvert: {
    pl: "Na kopii cashu.db poza folderem danych uruchom lokalnie własny konwerter do formatów z docs/budget-import-format.md (wyciągi) i docs/import-format.md (historia inwestycji); historię inwestycji przekaż przez `propose_import`, a plik budżetu zaimportuję samodzielnie w Wydatki > Import.",
    en: "On a copy of cashu.db outside the data folder, run your own converter locally into the formats of docs/budget-import-format.md (statements) and docs/import-format.md (investment history); hand the investment history over with `propose_import`, and I import the budget file myself in Wydatki > Import.",
  },
  oldDataRest: {
    pl: "Strategię (strategy.md, strategy.yaml) skopiuj do workspace agenta nowego profilu albo zaproponuj przez `propose_strategy`; notatki, tezy, obserwowane i alerty dodaj narzędziami MCP (`add_research_note`, `upsert_thesis`, `add_to_watchlist`, `add_alert`). Powiedz mi, czego nie da się przenieść.",
    en: "Copy the strategy (strategy.md, strategy.yaml) into the new profile's agent workspace or propose it with `propose_strategy`; add notes, theses, watchlist entries and alerts with the MCP tools (`add_research_note`, `upsert_thesis`, `add_to_watchlist`, `add_alert`). Tell me what cannot be brought over.",
  },
  rulesTitle: { pl: "Zasady dla agenta:", en: "Rules for the agent:" },
  ruleCopy: {
    pl: "Niczego w folderze danych nie edytuj, nie przenoś ani nie usuwaj; zmienia go tylko aplikacja. Wszystko próbuj na kopii poza nim.",
    en: "Do not edit, move or delete anything in the data folder; only the app changes it. Try everything on a copy outside it.",
  },
  ruleDelete: {
    pl: "Niczego nie usuwaj ani nie nadpisuj, także plików diagnostycznych i kopii zapasowych.",
    en: "Delete or overwrite nothing, including diagnostics files and backups.",
  },
  ruleSend: {
    pl: "Nigdy nie wysyłaj danych nigdzie: żadnego przesyłania plików i żadnego wklejania zawartości plików, kwot, numerów kont, nazwisk ani kontrahentów do czatu.",
    en: "Never send data anywhere: no uploads, and never paste file contents, amounts, account numbers, names or counterparties into the chat.",
  },
  ruleAsk: {
    pl: "Zanim cokolwiek zmienisz lub zaproponujesz, powiedz mi, co zrobisz; importy i propozycje zatwierdzam sam lub sama w aplikacji.",
    en: "Tell me what you will do before you change or propose anything; I approve imports and proposals myself in the app.",
  },
  codeMeaning: {
    pl: (code: StartupFailureCode) => MEANING_PL[code],
    en: (code: StartupFailureCode) => MEANING_EN[code],
  },
} as const;

const MEANING_PL: Record<StartupFailureCode, string> = {
  python_data_present:
    "W folderze danych są dane starej aplikacji cashU (Python), a nie ma jeszcze profilu nowej aplikacji. Aplikacja ich nie otwiera, nie przenosi i nie zmienia; można je przenieść przez funkcje importu z pomocą agenta.",
  native_inventory_unavailable:
    "Spis sejfów (native/v1/inventory.json) albo dziennik tworzenia profilu jest niekompletny lub nieprawidłowy, więc usługa w tle odmówiła startu.",
  vault_key_unavailable:
    "Klucz sejfu nie jest dostępny w pęku kluczy systemu albo nie daje się odszyfrować.",
  view_rebuild_failed:
    "Nie udało się odbudować widoku z zaszyfrowanej historii; historia pozostaje nietknięta.",
  unknown: "Przyczyna nie ma jeszcze własnego kodu; pomóc może log i ponowne uruchomienie.",
};

const MEANING_EN: Record<StartupFailureCode, string> = {
  python_data_present:
    "The data folder holds data of the old (Python) cashU app and no profile of the new app yet. The app never opens, moves or changes it; an agent can bring it over through the import paths.",
  native_inventory_unavailable:
    "The vault inventory (native/v1/inventory.json) or the profile creation journal is incomplete or invalid, so the background service refused to start.",
  vault_key_unavailable: "A vault key is missing from the system key store or cannot be decrypted.",
  view_rebuild_failed:
    "The view could not be rebuilt from the encrypted history; the history itself is untouched.",
  unknown: "The cause has no code of its own yet; the log and a retry may help.",
};
