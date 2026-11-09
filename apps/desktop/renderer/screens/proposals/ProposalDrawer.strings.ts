import { catalog } from "@cashu/i18n";

export const P = catalog({
  title: { pl: "Propozycja agenta", en: "Agent proposal" },
  loading: { pl: "Wczytywanie propozycji…", en: "Loading proposal…" },
  loadFailed: { pl: "Nie udało się wczytać propozycji.", en: "Could not load the proposal." },
  close: { pl: "Zamknij", en: "Close" },
  unavailableDiff: {
    pl: "Porównanie z bieżącymi plikami jest niedostępne.",
    en: "Comparison with current files is unavailable.",
  },
  unavailableApproval: {
    pl: "Zatwierdzanie jest teraz niedostępne.",
    en: "Approval is unavailable without a checked executor.",
  },
  refused: { pl: "Działanie zostało odrzucone.", en: "The action was refused." },
  busy: {
    pl: "Inna propozycja jest teraz wprowadzana. Spróbuj ponownie później.",
    en: "Another proposal is being applied. Try again later.",
  },
  baseChanged: {
    pl: "Pliki, na których oparto propozycję, zmieniły się. Poproś o nową propozycję.",
    en: "The proposal base changed. Ask for a new proposal.",
  },
  ruleExists: {
    pl: "Strategia ma już regułę o tym identyfikatorze. Poproś o nową propozycję.",
    en: "The strategy already has a rule with this id. Ask for a new proposal.",
  },
  ruleInvalid: {
    pl: "Proponowana reguła zawiera błędy.",
    en: "The proposed rule does not pass validation.",
  },
  strategyMissing: {
    pl: "Brak pliku strategii albo nie można go odczytać.",
    en: "The strategy file is missing or cannot be read.",
  },
  strategyUnreadable: {
    pl: "Nie można odczytać obecnych plików strategii.",
    en: "The current strategy files cannot be read.",
  },
  invalidStrategy: {
    pl: "Po tej zmianie strategia zawierałaby błędy.",
    en: "The strategy does not pass validation after this change.",
  },
  rulesMadeInactive: {
    pl: "Ta zmiana wyłączyłaby inne reguły.",
    en: "This change would turn off other rules.",
  },
  notPending: {
    pl: "Ta propozycja została już rozpatrzona. Sprawdź jej stan.",
    en: "This proposal has already been reviewed. Check its status.",
  },
  authorityLost: {
    pl: "Dostęp do tego profilu wygasł. Otwórz go ponownie.",
    en: "Access to this profile was lost. Open it again.",
  },
  cleanupFailed: {
    pl: "Działanie zostało odrzucone, ale pliki tymczasowe wymagają sprawdzenia.",
    en: "The action was refused, but temporary files need review.",
  },
  unknown: {
    pl: "Nie wiadomo, czy się udało. Sprawdź stan propozycji, zanim spróbujesz ponownie.",
    en: "The outcome is unknown. Check the proposal's current status before trying again.",
  },
  recovery: {
    pl: "Trzeba odzyskać lub uzgodnić pliki. Sprawdź stan, zanim spróbujesz ponownie.",
    en: "File recovery or reconciliation is needed. Check the state before trying again.",
  },
  recoveryAuthority: {
    pl: "Wymagane odzyskanie: dostęp do profilu wygasł podczas zapisu.",
    en: "Recovery is needed: profile access was lost during the write.",
  },
  recoveryRestore: {
    pl: "Wymagane odzyskanie: nie udało się przywrócić plików.",
    en: "Recovery is needed: files could not be restored.",
  },
  recoveryEvent: {
    pl: "Wymagane odzyskanie: nie zapisano informacji o niepowodzeniu.",
    en: "Recovery is needed: the failure record was not committed.",
  },
  recoveryReconcile: {
    pl: "Wymagane odzyskanie: nie udało się uzgodnić plików.",
    en: "Recovery is needed: files could not be reconciled.",
  },
  failed: { pl: "Zapis nie został zakończony.", en: "The write did not complete." },
  notFound: { pl: "Nie znaleziono tej propozycji.", en: "This proposal was not found." },
  pending: { pl: "Oczekuje", en: "Pending" },
  result: { pl: "Wynik", en: "Result" },
  proposedYaml: { pl: "Proponowany strategy.yaml", en: "Proposed strategy.yaml" },
  proposedMd: { pl: "Proponowany strategy.md", en: "Proposed strategy.md" },
  rule: { pl: "Proponowana reguła", en: "Proposed rule" },
  version: { pl: (n: number) => `Wersja ${n}`, en: (n: number) => `Version ${n}` },
  approved: { pl: "Zatwierdzono", en: "Approved" },
  rejected: { pl: "Odrzucono", en: "Rejected" },
  unsupported: {
    pl: "Starszy skrypt konwertera nie może zostać zatwierdzony.",
    en: "A legacy converter script cannot be approved.",
  },
  detailsUnavailable: {
    pl: "Szczegóły tej propozycji są niedostępne.",
    en: "This proposal's details are unavailable.",
  },
  hidden: { pl: "Ukryte w trybie incognito", en: "Hidden in privacy mode" },
});
