import { catalog } from "@cashu/i18n";

export const T = catalog({
  devicesTitle: { pl: "Urządzenia", en: "Devices" },
  unavailable: {
    pl: "Ta funkcja jest niedostępna w bieżącym środowisku.",
    en: "This feature is unavailable in the current environment.",
  },
  unavailableStatus: {
    pl: "Nie można sprawdzić bieżącego stanu.",
    en: "Current status cannot be checked.",
  },
  saved: { pl: "Zapisano", en: "Saved" },
  saveFailed: { pl: "Nie udało się zapisać.", en: "Could not save." },
  invalidProfile: {
    pl: "Podaj nazwę do 40 znaków i trzyliterowy kod waluty.",
    en: "Enter a name of up to 40 characters and a three-letter currency code.",
  },
  workspaceUnbound: {
    pl: "Zarządzanie workspace nie jest połączone z tym profilem.",
    en: "Workspace management is not connected to this profile.",
  },
  workspacePartial: {
    pl: "Część zmian zapisano. Sprawdź stan i ponów ręcznie.",
    en: "Some changes were saved. Check the status and retry manually.",
  },
  workspaceUnknown: {
    pl: "Wynik jest nieznany. Sprawdź stan przed ponowieniem.",
    en: "The outcome is unknown. Check status before retrying.",
  },
  workspacePathRequired: { pl: "Podaj ścieżkę folderu.", en: "Enter a folder path." },
  workspacePathRelative: {
    pl: "Podaj bezwzględną ścieżkę folderu.",
    en: "Enter an absolute folder path.",
  },
  workspacePathHome: {
    pl: "Wybierz podfolder zamiast katalogu domowego.",
    en: "Choose a subfolder instead of the home folder.",
  },
  workspacePathHidden: {
    pl: "Ten ukryty folder jest niedozwolony.",
    en: "This hidden folder is not allowed.",
  },
  workspacePathSymlink: {
    pl: "Ścieżka prowadzi przez dowiązanie symboliczne.",
    en: "The path passes through a symbolic link.",
  },
  workspaceTaken: {
    pl: "Folder należy już do innego profilu.",
    en: "The folder already belongs to another profile.",
  },
  workspaceBusy: {
    pl: "Workspace jest teraz aktualizowany.",
    en: "The workspace is being updated.",
  },
  workspaceWriteFailed: {
    pl: "Nie udało się zapisać wszystkich plików workspace.",
    en: "Workspace files could not all be written.",
  },
  workspaceSkillsUnavailable: {
    pl: "Źródło skilli jest niedostępne.",
    en: "The skill source is unavailable.",
  },
  workspaceRefresh: { pl: "Sprawdź ponownie", en: "Check again" },
  mcpInstructions: { pl: "Połączenie MCP", en: "MCP connection" },
  mcpUnavailable: {
    pl: "Polecenie MCP jest niedostępne bez sprawdzonej lokalizacji aplikacji i profilu.",
    en: "The MCP command is unavailable without a checked app location and profile.",
  },
  proposals: { pl: "Propozycje agenta", en: "Agent proposals" },
  noProposals: { pl: "Brak oczekujących propozycji.", en: "No pending proposals." },
  openProposal: { pl: "Otwórz propozycję", en: "Open proposal" },
  connectorUnavailable: {
    pl: "Katalog i uruchamianie konektorów nie są połączone. Istniejące propozycje można sprawdzić powyżej.",
    en: "Connector catalog and execution are not connected. Existing proposals can be reviewed above.",
  },
  connectorSaved: { pl: "Zapisano ustawienia konektora.", en: "Connector settings saved." },
  connectorFailed: {
    pl: "Nie można zmienić ustawień konektora.",
    en: "Could not change connector settings.",
  },
  connectorUnknown: {
    pl: "Wynik zmiany jest niepewny. Sprawdź stan po ponownym otwarciu Ustawień.",
    en: "The change outcome is uncertain. Check the state after reopening Settings.",
  },
  connectorRunFailed: {
    pl: "Pobranie nie powiodło się. Sprawdź stan zadania w tle.",
    en: "Fetch failed. Check the background job status.",
  },
  connectorInvalidParams: {
    pl: "Wybierz konto i uzupełnij wymagane parametry.",
    en: "Choose an account and complete the required parameters.",
  },
  connectorInstall: { pl: "Zainstaluj z folderu", en: "Install from folder" },
  connectorInstalled: {
    pl: "Konektor zainstalowany. Sprawdź skrót kodu przed zatwierdzeniem.",
    en: "Connector installed. Review its code digest before approval.",
  },
  connectorInterpreter: { pl: "Interpreter", en: "Interpreter" },
  connectorRemoveAll: {
    pl: "Usuń konektor ze wszystkich profili",
    en: "Remove connector from all profiles",
  },
  connectorRemoveAllConfirm: {
    pl: "Usunąć ten konektor ze wszystkich profili? Ta operacja usunie wszystkie powiązania, zapisane sekrety konektora i lokalną historię uruchomień.",
    en: "Remove this connector from all profiles? This deletes every binding, saved connector secret, and local run history.",
  },
  connectorSecret: { pl: "Sekret konektora", en: "Connector secret" },
  connectorParam: { pl: "Parametr", en: "Parameter" },
  workerUnavailable: {
    pl: "Stan harmonogramu i zadania w tle są niedostępne.",
    en: "Scheduler status and background jobs are unavailable.",
  },
  updatesUnavailable: {
    pl: "Sprawdzanie i instalowanie aktualizacji jest niedostępne.",
    en: "Update checking and installation are unavailable.",
  },
  auditUnknownArgs: {
    pl: (n: number) => `oraz ${n} nieznanych argumentów`,
    en: (n: number) => `and ${n} unknown arguments`,
  },
  copied: { pl: "Skopiowano", en: "Copied" },
  copyFailed: { pl: "Nie udało się skopiować.", en: "Could not copy." },
  workerOff: {
    pl: "Praca w otwartej aplikacji nie jest połączona.",
    en: "Work in the open app is not connected.",
  },
  workerSafeMode: {
    pl: "Praca w tle jest wyłączona w trybie bezpiecznym.",
    en: "Background work is disabled in safe mode.",
  },
  workerIdle: { pl: "Gotowa", en: "Idle" },
  workerRunning: { pl: "Trwa", en: "Running" },
  workerStopped: { pl: "Zatrzymana", en: "Stopped" },
  workerError: { pl: "Błąd", en: "Error" },
  serviceTitle: { pl: "Uruchamianie po zamknięciu aplikacji", en: "Start after closing the app" },
  serviceToggle: { pl: "Włącz codzienne uruchamianie", en: "Enable daily start" },
  serviceOff: { pl: "Wyłączone", en: "Off" },
  serviceEnabled: { pl: "Włączone", en: "Enabled" },
  serviceApproval: {
    pl: "Wymaga zgody w ustawieniach systemu",
    en: "Requires approval in System Settings",
  },
  serviceCancelApproval: { pl: "Anuluj oczekującą zgodę", en: "Cancel pending approval" },
  serviceUnavailable: { pl: "Niedostępne w tym środowisku", en: "Unavailable in this environment" },
  serviceError: {
    pl: "Nie można sprawdzić lub zmienić usługi",
    en: "Could not check or change the service",
  },
  serviceNextWake: { pl: "Następne planowane uruchomienie", en: "Next scheduled start" },
  notificationPermissionTitle: { pl: "Powiadomienia systemowe", en: "System notifications" },
  notificationPermissionAllowed: { pl: "Dozwolone", en: "Allowed" },
  notificationPermissionDenied: {
    pl: "Zablokowane. Zmień uprawnienie w ustawieniach systemu.",
    en: "Blocked. Change permission in system settings.",
  },
  notificationPermissionPending: { pl: "Wymaga zgody", en: "Permission needed" },
  notificationPermissionSystem: {
    pl: "Uprawnieniami zarządza system. Dostępność zależy od usługi powiadomień.",
    en: "Managed by the system. Availability depends on the notification service.",
  },
  notificationPermissionUnavailable: {
    pl: "Niedostępne w tym środowisku",
    en: "Unavailable in this environment",
  },
  notificationPermissionRequest: { pl: "Poproś o zgodę", en: "Request permission" },
  workerNoRuns: { pl: "Brak zapisanych przebiegów.", en: "No recorded runs." },
  workerConnector: { pl: "Pobranie konektorów", en: "Connector fetch" },
  auditDuration: { pl: (ms: number) => `${ms} ms`, en: (ms: number) => `${ms} ms` },
  auditHidden: {
    pl: "Dziennik ukryty w trybie prywatnym.",
    en: "Call log hidden in privacy mode.",
  },
});
