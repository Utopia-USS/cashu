// Texts of the start-up recovery screen (T54): what happened in plain words, why the data is safe,
// and the actions (for the old app's data also the way on to first-run setup). The failure codes
// themselves stay as they are (the agent prompt quotes them).
import type { StartupFailureCode } from "@cashu/host-protocol/startup-failure";
import { catalog } from "@cashu/i18n";

/** The codes the screen explains (the View takes these, not protocol types). */
export type RecoveryCode = StartupFailureCode;

const WHAT_PL: Record<StartupFailureCode, string> = {
  python_data_present:
    "W folderze danych są dane z poprzedniej wersji cashU. Ta wersja ich nie importuje: może je przenieść Twój agent AI według promptu poniżej. Możesz też zacząć od nowa bez nich.",
  native_inventory_unavailable:
    "Spis Twoich profili jest niekompletny albo nie zgadza się z plikami, więc cashU wolał nie startować.",
  vault_key_unavailable:
    "Klucz, którym zaszyfrowany jest profil, nie jest dostępny w pęku kluczy systemu albo nie daje się odczytać. Jeśli macOS pytał o dostęp do pęku kluczy (na przykład po przebudowaniu aplikacji), wybierz „Zawsze zezwalaj” i kliknij „Spróbuj ponownie”: odmowa niczego nie usuwa.",
  view_rebuild_failed:
    "Po aktualizacji cashU musi przeliczyć widok danych z zaszyfrowanej historii i to się nie udało.",
  unknown: "Usługa w tle nie uruchomiła się z przyczyny, która nie ma jeszcze własnego opisu.",
};

const WHAT_EN: Record<StartupFailureCode, string> = {
  python_data_present:
    "The data folder holds data from the previous version of cashU. This version does not import it: your AI agent can bring it over with the prompt below. You can also start fresh without it.",
  native_inventory_unavailable:
    "The list of your profiles is incomplete or does not match the files, so cashU chose not to start.",
  vault_key_unavailable:
    "The key that encrypts a profile is missing from the system keychain or cannot be read. If macOS asked for access to the keychain (for example after the app was rebuilt), choose Always Allow and click Try again: denying it deletes nothing.",
  view_rebuild_failed:
    "After an update cashU has to recompute the data view from the encrypted history, and that failed.",
  unknown: "The background service did not start, for a reason that has no description yet.",
};

const SAFE_PL: Record<StartupFailureCode, string> = {
  python_data_present:
    "cashU tylko sprawdził, że te pliki istnieją. Nie otwiera ich, nie przenosi ani nie zmienia, także gdy zaczniesz bez nich.",
  native_inventory_unavailable: "Pliki profili nie zostały zmienione.",
  vault_key_unavailable: "Pliki profilu i klucze nie zostały zmienione.",
  view_rebuild_failed:
    "Zaszyfrowana historia jest nietknięta; nieudane przeliczenie zostało wycofane.",
  unknown: "",
};

const SAFE_EN: Record<StartupFailureCode, string> = {
  python_data_present:
    "cashU only checked that these files exist. It never opens, moves or changes them, also when you start without them.",
  native_inventory_unavailable: "The profile files were not changed.",
  vault_key_unavailable: "The profile files and keys were not changed.",
  view_rebuild_failed:
    "The encrypted history is untouched; the failed recomputation was rolled back.",
  unknown: "",
};

export const S = catalog({
  title: { pl: "cashU nie może się uruchomić", en: "cashU cannot start" },
  oldDataTitle: {
    pl: "Dane z poprzedniej wersji cashU",
    en: "Data from the previous version of cashU",
  },
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
  continueWithoutOldData: {
    pl: "Kontynuuj bez starych danych",
    en: "Continue without the old data",
  },
  quit: { pl: "Zakończ", en: "Quit" },
  unavailable: {
    pl: "Nie udało się odczytać raportu o błędzie startu.",
    en: "The start-up failure report could not be read.",
  },
});
