// Texts of the start-up recovery screen (T54): what happened in plain words, why the data is safe,
// "Import my data" with its progress and one-time recovery words, and the other actions. The failure
// codes and commands themselves stay as they are (the agent prompt quotes them).
import type { MigrateStage, StartupFailureCode } from "@cashu/host-protocol/startup-failure";
import { catalog } from "@cashu/i18n";

/** The codes and import stages the screen explains (the View takes these, not protocol types). */
export type RecoveryCode = StartupFailureCode;
export type RecoveryStage = MigrateStage;

const WHAT_PL: Record<StartupFailureCode, string> = {
  python_data_present:
    "W folderze danych są dane z poprzedniej wersji cashU. Ta wersja ich nie otwiera: trzeba je raz zaimportować.",
  native_inventory_unavailable:
    "Spis Twoich profili jest niekompletny albo nie zgadza się z plikami, więc cashU wolał nie startować.",
  vault_key_unavailable:
    "Klucz, którym zaszyfrowany jest profil, nie jest dostępny w pęku kluczy systemu albo nie daje się odczytać.",
  migrate_verify_mismatch:
    "Sprawdzenie importu znalazło różnicę między danymi poprzedniej wersji a zaimportowanym profilem.",
  view_rebuild_failed:
    "Po aktualizacji cashU musi przeliczyć widok danych z zaszyfrowanej historii i to się nie udało.",
  migrate_import_failed: "Import danych z poprzedniej wersji cashU przerwał się.",
  migration_incomplete:
    "Import danych z poprzedniej wersji cashU przerwał się w trakcie przełączania na nowe dane.",
  unknown: "Usługa w tle nie uruchomiła się z przyczyny, która nie ma jeszcze własnego opisu.",
};

const WHAT_EN: Record<StartupFailureCode, string> = {
  python_data_present:
    "The data folder holds data from the previous version of cashU. This version does not open it: it has to be imported once.",
  native_inventory_unavailable:
    "The list of your profiles is incomplete or does not match the files, so cashU chose not to start.",
  vault_key_unavailable:
    "The key that encrypts a profile is missing from the system keychain or cannot be read.",
  migrate_verify_mismatch:
    "Checking the import found a difference between the previous version's data and the imported profile.",
  view_rebuild_failed:
    "After an update cashU has to recompute the data view from the encrypted history, and that failed.",
  migrate_import_failed: "The import of the previous cashU version's data stopped.",
  migration_incomplete:
    "The import of the previous cashU version's data stopped while switching over to the new data.",
  unknown: "The background service did not start, for a reason that has no description yet.",
};

const SAFE_PL: Record<StartupFailureCode, string> = {
  python_data_present:
    "cashU tylko sprawdził, że te pliki istnieją. Import czyta ich kopię, a oryginały przenosi nienaruszone do folderu python-backup-<czas> w folderze danych.",
  native_inventory_unavailable: "Pliki profili nie zostały zmienione.",
  vault_key_unavailable: "Pliki profilu i klucze nie zostały zmienione.",
  migrate_verify_mismatch:
    "Sprawdzenie tylko czyta dane i niczego nie zmienia; pliki poprzedniej wersji pozostają Twoją kopią zapasową.",
  view_rebuild_failed:
    "Zaszyfrowana historia jest nietknięta; nieudane przeliczenie zostało wycofane.",
  migrate_import_failed:
    "Import czytał tylko kopię danych i usunął swoje pliki tymczasowe. Pliki poprzedniej wersji są tam, gdzie były, a import można powtórzyć.",
  migration_incomplete:
    "Pliki poprzedniej wersji są nadal na miejscu albo już nienaruszone w folderze python-backup-<czas>. Ponowny import dokończy przełączenie.",
  unknown: "",
};

const SAFE_EN: Record<StartupFailureCode, string> = {
  python_data_present:
    "cashU only checked that these files exist. The import reads a copy of them and moves the originals intact into a python-backup-<time> folder inside the data folder.",
  native_inventory_unavailable: "The profile files were not changed.",
  vault_key_unavailable: "The profile files and keys were not changed.",
  migrate_verify_mismatch:
    "The check only reads the data and changes nothing; the previous version's files remain your backup.",
  view_rebuild_failed:
    "The encrypted history is untouched; the failed recomputation was rolled back.",
  migrate_import_failed:
    "The import read only a copy of the data and removed its own temporary files. The previous version's files are where they were, and the import can be run again.",
  migration_incomplete:
    "The previous version's files are still in place or already intact in a python-backup-<time> folder. Running the import again finishes the switch-over.",
  unknown: "",
};

const STAGE_PL: Record<MigrateStage, string> = {
  preflight: "Sprawdzanie danych",
  copy: "Kopiowanie danych",
  import: "Importowanie",
  verify: "Sprawdzanie importu",
  cutover: "Przełączanie na nowe dane",
};

const STAGE_EN: Record<MigrateStage, string> = {
  preflight: "Checking the data",
  copy: "Copying the data",
  import: "Importing",
  verify: "Checking the import",
  cutover: "Switching to the new data",
};

export const S = catalog({
  title: { pl: "cashU nie może się uruchomić", en: "cashU cannot start" },
  what: {
    pl: (code: StartupFailureCode) => WHAT_PL[code],
    en: (code: StartupFailureCode) => WHAT_EN[code],
  },
  safeTitle: { pl: "Twoje dane", en: "Your data" },
  safe: {
    pl: (code: StartupFailureCode) => SAFE_PL[code],
    en: (code: StartupFailureCode) => SAFE_EN[code],
  },
  untouched: {
    pl: "cashU niczego nie usunął, a oryginalne pliki pozostały nietknięte.",
    en: "cashU deleted nothing, and the original files stayed untouched.",
  },
  notConfirmed: {
    pl: "Nie da się potwierdzić, na którym etapie start się przerwał. Niczego nie usuwaj i pracuj na kopii folderu danych.",
    en: "It cannot be confirmed at which step the start stopped. Delete nothing and work on a copy of the data folder.",
  },
  dataDir: { pl: "Folder danych", en: "Data folder" },
  report: { pl: "Raport diagnostyczny", en: "Diagnostics report" },
  reportMissing: { pl: "nie zapisano", en: "not written" },
  code: { pl: "Kod", en: "Code" },
  stage: { pl: "Etap", en: "Stage" },
  importTitle: { pl: "Import danych", en: "Import your data" },
  importHint: {
    pl: "Import przenosi dane z poprzedniej wersji do tej wersji. W trakcie pokaże jednorazowo nową frazę odzyskiwania do zapisania.",
    en: "The import brings the previous version's data into this version. Along the way it shows a new recovery phrase once, for you to write down.",
  },
  importData: { pl: "Zaimportuj moje dane", en: "Import my data" },
  finishImport: { pl: "Dokończ import", en: "Finish the import" },
  importStarting: { pl: "Uruchamianie importu...", en: "Starting the import..." },
  importRefused: {
    pl: "Nie udało się uruchomić importu.",
    en: "The import could not be started.",
  },
  importCancelling: { pl: "Anulowanie importu...", en: "Cancelling the import..." },
  importCancelled: {
    pl: "Import anulowano; niczego nie utworzono.",
    en: "The import was cancelled; nothing was created.",
  },
  stageLabel: {
    pl: (stage: MigrateStage) => STAGE_PL[stage],
    en: (stage: MigrateStage) => STAGE_EN[stage],
  },
  stageDone: { pl: "gotowe", en: "done" },
  stageRunning: { pl: "w toku", en: "in progress" },
  wordsTitle: { pl: "Zapisz frazę odzyskiwania", en: "Save your recovery phrase" },
  wordsHint: {
    pl: "Zapisz te słowa poza komputerem, w bezpiecznym miejscu. Nie udostępniaj ich nikomu. Po zamknięciu tego kroku nie pokażemy ich ponownie.",
    en: "Write these words down somewhere safe outside this computer. Do not share them. They will not be shown again after this step closes.",
  },
  wordsConfirmed: {
    pl: "Zapisałem lub zapisałam frazę i mogę ją odzyskać.",
    en: "I saved the phrase and can retrieve it.",
  },
  wordsContinue: { pl: "Kontynuuj import", en: "Continue the import" },
  wordsCancel: { pl: "Anuluj import", en: "Cancel the import" },
  nextTitle: { pl: "Co dalej", en: "What next" },
  next: {
    pl: "Skopiuj prompt i wklej go swojemu agentowi (na przykład Claude Code). Zawiera tylko kody, etapy, liczby, polecenia i ścieżki względem katalogu domowego, bez kwot, numerów kont i nazw.",
    en: "Copy the prompt and paste it to your agent (for example Claude Code). It holds only codes, stages, counts, commands and paths relative to your home folder, no amounts, account numbers or names.",
  },
  showPrompt: { pl: "Pokaż prompt", en: "Show the prompt" },
  copy: { pl: "Kopiuj prompt dla agenta", en: "Copy prompt for agent" },
  copied: { pl: "Skopiowano prompt.", en: "Prompt copied." },
  copyFailed: { pl: "Nie udało się skopiować promptu.", en: "The prompt could not be copied." },
  openFolder: { pl: "Otwórz folder danych", en: "Open data folder" },
  openFailed: {
    pl: "Nie udało się otworzyć folderu danych.",
    en: "The data folder could not be opened.",
  },
  retry: { pl: "Spróbuj ponownie", en: "Try again" },
  quit: { pl: "Zakończ", en: "Quit" },
  unavailable: {
    pl: "Nie udało się odczytać raportu o błędzie startu.",
    en: "The start-up failure report could not be read.",
  },
});
