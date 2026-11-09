export const investmentCliText = {
  noAccounts: {
    pl: "Brak rachunków maklerskich. Dodaj: cashu invest accounts add NAZWA --broker xtb",
    en: "No brokerage accounts. Add one: cashu invest accounts add NAME --broker xtb",
  },
  accountsTitle: { pl: "Rachunki maklerskie", en: "Brokerage accounts" },
  accountAdded: { pl: "Rachunek maklerski", en: "Brokerage account" },
  noSignals: { pl: "Brak sygnałów.", en: "No signals." },
  signalsTitle: { pl: "Sygnały", en: "Signals" },
  written: { pl: "Zapisano", en: "Written" },
  strategyExists: {
    pl: "Pliki strategii już istnieją.",
    en: "Strategy files already exist.",
  },
  forceUnavailable: {
    pl: "Nadpisanie strategii przez CLI jest niedostępne w tym hoście.",
    en: "Strategy overwrite through the CLI is unavailable in this host.",
  },
  partialStrategy: {
    pl: "Inicjalizacja strategii nie została ukończona. Sprawdź pliki przed ponowieniem.",
    en: "Strategy initialization did not complete. Check the files before retrying.",
  },
  completedFiles: { pl: "Ukończone pliki:", en: "Completed files:" },
  attemptedFile: { pl: "Plik o niepewnym wyniku:", en: "File with uncertain outcome:" },
  strategyFailed: {
    pl: "Operacja na strategii nie powiodła się. Sprawdź pliki strategii i spróbuj ponownie.",
    en: "Strategy operation failed. Check the strategy files and try again.",
  },
  unknownTemplate: { pl: "Nieznany szablon strategii.", en: "Unknown strategy template." },
  noStrategy: {
    pl: "Brak strategii (strategy.yaml). Utwórz: cashu invest strategy init",
    en: "No strategy yet (strategy.yaml). Create one: cashu invest strategy init",
  },
  version: { pl: "wersja", en: "version" },
  error: { pl: "błąd", en: "error" },
  inactiveRule: { pl: "nieaktywna reguła", en: "inactive rule" },
  line: { pl: "wiersz", en: "line" },
  unknownOutcome: {
    pl: "Nieznany wynik polecenia. Sprawdź:",
    en: "Command outcome unknown. Check:",
  },
  doNotRetry: {
    pl: "Nie ponawiaj przed wyjaśnieniem wyniku.",
    en: "Do not issue a new attempt until reconciled.",
  },
  contextChanged: {
    pl: "Profil lub uprawnienie do plików zmieniło się podczas polecenia.",
    en: "The profile or file authority changed during the command.",
  },
  importer: { pl: "importer", en: "importer" },
  rows: { pl: "wiersze", en: "rows" },
  newRows: { pl: "nowe", en: "new" },
  duplicates: { pl: "duplikaty", en: "duplicates" },
  positions: { pl: "pozycje", en: "positions" },
  renames: { pl: "zmiany nazw", en: "renames" },
  delistings: { pl: "wycofania", en: "delistings" },
  newInstruments: { pl: "nowe instrumenty", en: "new instruments" },
  newInstrument: { pl: "nowy instrument", en: "new instrument" },
  warning: { pl: "ostrzeżenie", en: "warning" },
  notImported: {
    pl: "Nie zaimportowano: popraw błędy powyżej.",
    en: "Not imported: fix the errors above.",
  },
  dryRun: { pl: "Podgląd: nic nie zapisano.", en: "Dry run: nothing written." },
  importUnavailable: {
    pl: "Import niedostępny: utracono uprawnienie lub przywództwo.",
    en: "Import unavailable: authority or leadership was lost.",
  },
  imported: { pl: "Zaimportowano", en: "Imported" },
  transactions: { pl: "transakcji", en: "transactions" },
  batch: { pl: "partia", en: "batch" },
  corrections: { pl: "korekty", en: "corrections" },
  reconciliation: { pl: "uzgodnienie", en: "reconciliation" },
  brokerQuantity: { pl: "broker", en: "broker" },
  historyQuantity: { pl: "historia", en: "history" },
  delta: { pl: "różnica", en: "delta" },
  archived: { pl: "Archiwum:", en: "Archived:" },
  noInvestmentVault: {
    pl: "Brak wybranego profilu inwestycyjnego.",
    en: "No selected investment profile.",
  },
  runUnavailable: {
    pl: "Kontrola inwestycji jest niedostępna.",
    en: "Investment check is unavailable.",
  },
  runBusy: { pl: "Kontrola inwestycji już trwa.", en: "An investment check is already running." },
  runFailed: { pl: "Kontrola inwestycji nie powiodła się.", en: "Investment check failed." },
  market: { pl: "rynek", en: "market" },
  marketFailed: { pl: "odświeżenie rynku nie powiodło się", en: "market refresh failed" },
  macro: { pl: "makro", en: "macro" },
  macroFailed: { pl: "odświeżenie makro nie powiodło się", en: "macro refresh failed" },
  macroUnavailable: {
    pl: "Źródło danych makro jest niedostępne.",
    en: "Macro source is unavailable.",
  },
  bars: { pl: "punktów", en: "bars" },
  stored: { pl: "zapisano", en: "stored" },
  closes: { pl: "zamknięć", en: "closes" },
  since: { pl: "od", en: "since" },
  sinceBefore: { pl: "od ponad", en: "since before" },
  strategyLabel: { pl: "strategia", en: "strategy" },
  holdings: { pl: "pozycje", en: "holdings" },
  total: { pl: "suma", en: "total" },
  signalsNew: { pl: "nowe sygnały", en: "new signals" },
  signalsEscalated: { pl: "nasilone sygnały", en: "escalated signals" },
  alertsResolved: { pl: "rozwiązane alerty", en: "resolved alerts" },
  plansResolved: { pl: "rozwiązane plany", en: "resolved plans" },
  researchResolved: { pl: "rozwiązane badania", en: "resolved research" },
  profileError: { pl: "!", en: "!" },
  reason: { pl: "powód", en: "reason" },
  mergeNativeIds: {
    pl: "Użyj pełnych natywnych identyfikatorów instrumentów.",
    en: "Use full native instrument IDs.",
  },
  mergeBackupUnavailable: {
    pl: "Scalenie wymaga zaszyfrowanej kopii skarbca przed zapisem. Ta możliwość jest niedostępna.",
    en: "Merge requires an encrypted vault checkpoint before writing. That capability is unavailable.",
  },
  wouldMerge: { pl: "Scalono by", en: "Would merge" },
  merged: { pl: "Scalono", en: "Merged" },
  into: { pl: "z", en: "into" },
  moved: { pl: "przeniesiono by", en: "would move" },
  didMove: { pl: "przeniesiono", en: "moved" },
  mergeCheckpointSaved: {
    pl: "Zaszyfrowana kopia przed scaleniem:",
    en: "Encrypted pre-merge checkpoint:",
  },
} as const;

export const strategyState = {
  valid: { pl: "poprawna", en: "valid" },
  partial: { pl: "częściowa", en: "partial" },
  invalid: { pl: "niepoprawna", en: "invalid" },
} as const;

export const macroStatus = {
  ok: { pl: "ok", en: "ok" },
  no_data: { pl: "brak danych", en: "no data" },
  skipped: { pl: "pominięto", en: "skipped" },
  error: { pl: "błąd", en: "error" },
} as const;

/** Why `cashu invest run` skipped or failed a profile; any other code is printed as it is. */
export const runReason: Readonly<Record<string, { readonly pl: string; readonly en: string }>> = {
  fetch_authority_unavailable: {
    pl: "to urządzenie nie ma teraz prawa pobierania danych (lider pobierania lub synchronizacja)",
    en: "this device may not fetch right now (fetch leader or sync)",
  },
  authority_lost: {
    pl: "profil lub uprawnienie zmieniło się podczas przebiegu",
    en: "the profile or its authority changed during the run",
  },
  file_authority_unavailable: {
    pl: "pliki strategii są niedostępne",
    en: "the strategy files are unavailable",
  },
  busy: { pl: "trwa inny przebieg", en: "another run is in progress" },
  preparation_failed: { pl: "przygotowanie nie powiodło się", en: "preparation failed" },
  daily_failed: { pl: "przebieg nie powiódł się", en: "the run failed" },
  outcome_unknown: { pl: "wynik zapisu nieznany", en: "write outcome unknown" },
};

export const runStatus = {
  ok: { pl: "ukończono", en: "ok" },
  partial: { pl: "częściowo", en: "partial" },
  failed: { pl: "niepowodzenie", en: "failed" },
  refused: { pl: "odmowa", en: "refused" },
  skipped: { pl: "pominięto", en: "skipped" },
} as const;

export const mergeRefusal = {
  same_instrument: { pl: "To ten sam instrument.", en: "These are the same instrument." },
  no_instrument: { pl: "Nie znaleziono instrumentu.", en: "Instrument not found." },
  different_currency: {
    pl: "Instrumenty mają różne waluty.",
    en: "Instruments have different currencies.",
  },
  different_isin: { pl: "Instrumenty mają różne ISIN.", en: "Instruments have different ISINs." },
} as const;

export const columns = {
  id: { pl: "id", en: "id" },
  name: { pl: "nazwa", en: "name" },
  broker: { pl: "broker", en: "broker" },
  wrapper: { pl: "konto", en: "wrapper" },
  currency: { pl: "waluta", en: "currency" },
  importer: { pl: "importer", en: "importer" },
  snapshot: { pl: "migawka", en: "snapshot" },
  lastImport: { pl: "ostatni import", en: "last import" },
  severity: { pl: "ważność", en: "severity" },
  status: { pl: "stan", en: "status" },
  rule: { pl: "reguła", en: "rule" },
  message: { pl: "wiadomość", en: "message" },
  since: { pl: "od", en: "since" },
} as const;
