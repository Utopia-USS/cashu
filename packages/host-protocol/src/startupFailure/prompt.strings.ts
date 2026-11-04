// Texts of the copy-paste agent prompt (the recovery screen's "Copy prompt for agent"), PL + EN
// (docs/agents/localization.md). Resolved with an explicit language, because Electron main and the
// migration CLI have no UI language source. The commands and codes inside stay as they are.
import type { StartupFailureCode } from "./codes.js";

export type PromptLang = "pl" | "en";

export const PROMPT = {
  intro: {
    pl: "cashU nie uruchomił się. Pomóż mi zdiagnozować problem. Poniżej są tylko kody, etapy, liczby i ścieżki względem katalogu domowego - żadnych moich danych finansowych.",
    en: "cashU could not start. Please help me diagnose it. Below are only codes, stages, counts and paths relative to my home folder - none of my financial data.",
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
  commandsTitle: {
    pl: "Polecenia do uruchomienia w Terminalu (dokładnie w tej postaci):",
    en: "Commands to run in Terminal (exactly as shown):",
  },
  migrateHint: {
    pl: "`migrate` importuje dane starej aplikacji do tego folderu (oryginalne pliki trafiają nienaruszone do python-backup-<czas>/) albo kończy przerwany import; `migrate verify` porównuje zaimportowane dane z kopią danych Pythona i niczego nie zmienia.",
    en: "`migrate` imports the old app's data into this folder (the original files move intact into python-backup-<time>/) or finishes an interrupted import; `migrate verify` compares the imported data with the copy of the Python data and changes nothing.",
  },
  verifyHint: {
    pl: "`migrate verify` porównuje zaimportowane dane z kopią danych Pythona i niczego nie zmienia.",
    en: "`migrate verify` compares the imported data with the copy of the Python data and changes nothing.",
  },
  runbook: { pl: "Instrukcja migracji", en: "Migration runbook" },
  runbookWhere: { pl: "w repozytorium cashU", en: "in the cashU repository" },
  rulesTitle: { pl: "Zasady dla agenta:", en: "Rules for the agent:" },
  ruleCopy: {
    pl: "Niczego w folderze danych nie edytuj, nie przenoś ani nie usuwaj ręcznie; zmieniać go mogą tylko powyższe polecenia cashU. Wszystko inne próbuj na kopii.",
    en: "Do not edit, move or delete anything in the data folder by hand; only the cashU commands above may change it. Try anything else on a copy.",
  },
  ruleDelete: {
    pl: "Niczego nie usuwaj ani nie nadpisuj, także plików diagnostycznych i kopii zapasowych.",
    en: "Delete or overwrite nothing, including diagnostics files and backups.",
  },
  ruleSend: {
    pl: "Nigdy nie wysyłaj danych nigdzie: żadnych uploadów i żadnego wklejania zawartości plików, kwot, numerów kont, nazwisk ani kontrahentów do czatu.",
    en: "Never send data anywhere: no uploads, and never paste file contents, amounts, account numbers, names or counterparties into the chat.",
  },
  ruleAsk: {
    pl: "Podawaj mi polecenia do uruchomienia i wyjaśniaj kody, które zwracają; uruchomię je sam lub sama.",
    en: "Give me the commands to run and explain the codes they print; I will run them myself.",
  },
  codeMeaning: {
    pl: (code: StartupFailureCode) => MEANING_PL[code],
    en: (code: StartupFailureCode) => MEANING_EN[code],
  },
} as const;

const MEANING_PL: Record<StartupFailureCode, string> = {
  python_data_present:
    "W folderze danych są dane starej aplikacji (Python). Nowa aplikacja ich nie otwiera; trzeba je jednorazowo zaimportować (`cashu migrate`) i zweryfikować.",
  native_inventory_unavailable:
    "Spis sejfów (native/v1/inventory.json) albo dziennik tworzenia profilu jest niekompletny lub nieprawidłowy, więc usługa w tle odmówiła startu.",
  vault_key_unavailable:
    "Klucz sejfu nie jest dostępny w pęku kluczy systemu albo nie daje się odszyfrować.",
  migrate_verify_mismatch:
    "Weryfikacja migracji (migrate verify) znalazła różnicę między danymi Pythona a zaimportowanym sejfem.",
  view_rebuild_failed:
    "Nie udało się odbudować widoku z zaszyfrowanej historii; historia pozostaje nietknięta.",
  migrate_import_failed:
    "Import danych Pythona (cashu migrate) przerwał się. Import czyta tylko kopię danych i usuwa własne pliki tymczasowe, więc oryginał jest nietknięty i import można powtórzyć.",
  migration_incomplete:
    "Import danych Pythona został przerwany w trakcie przełączania (istnieje dziennik przełączenia). Pliki Pythona są nadal na miejscu albo już nienaruszone w python-backup-<czas>/; ponowne `cashu migrate` dokończy przełączenie.",
  unknown: "Przyczyna nie ma jeszcze własnego kodu; pomóc może log i powtórzenie startu.",
};

const MEANING_EN: Record<StartupFailureCode, string> = {
  python_data_present:
    "The data folder holds data of the old (Python) app. The new app does not open it; it has to be imported once (`cashu migrate`) and verified.",
  native_inventory_unavailable:
    "The vault inventory (native/v1/inventory.json) or the profile creation journal is incomplete or invalid, so the background service refused to start.",
  vault_key_unavailable: "A vault key is missing from the system key store or cannot be decrypted.",
  migrate_verify_mismatch:
    "Migration verification (migrate verify) found a difference between the Python data and the imported vault.",
  view_rebuild_failed:
    "The view could not be rebuilt from the encrypted history; the history itself is untouched.",
  migrate_import_failed:
    "The import of the Python data (cashu migrate) stopped. The import reads only a copy of the data and removes its own staging files, so the original is untouched and the import can be run again.",
  migration_incomplete:
    "The import of the Python data stopped during the switch-over (a cutover journal exists). The Python files are still in place or already intact in python-backup-<time>/; running `cashu migrate` again finishes the switch-over.",
  unknown: "The cause has no code of its own yet; the log and a retry may help.",
};
