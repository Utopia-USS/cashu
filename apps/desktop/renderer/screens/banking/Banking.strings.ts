export const B = {
  title: { pl: "Open Banking", en: "Open Banking" },
  unavailable: {
    pl: "Open Banking jest niedostępny dla tego profilu.",
    en: "Open Banking is unavailable for this profile.",
  },
  configure: { pl: "Skonfiguruj Enable Banking", en: "Configure Enable Banking" },
  appId: { pl: "Identyfikator aplikacji (Application ID)", en: "Application ID" },
  appIdHint: {
    pl: "Znajdziesz go w panelu Enable Banking, w nawiasie obok nazwy aplikacji. Możesz zostawić puste: plik klucza nazywa się tak samo, więc cashU odczyta go z nazwy pliku.",
    en: "Find it in the Enable Banking Control Panel, in brackets next to the application name. You can leave it empty: the key file has the same name, so cashU reads it from the file name.",
  },
  dropKey: {
    pl: "Przeciągnij tutaj plik klucza prywatnego (.pem)",
    en: "Drag the private key file (.pem) here",
  },
  dropOr: { pl: "albo", en: "or" },
  chooseKey: { pl: "Wybierz prywatny plik klucza", en: "Choose private key file" },
  keyType: {
    pl: "To nie jest plik klucza .pem. Użyj pliku pobranego przy rejestracji aplikacji.",
    en: "This is not a .pem key file. Use the file downloaded when you registered the application.",
  },
  keyUnreadable: {
    pl: "Nie da się odczytać pliku klucza. Wybierz zwykły plik .pem (nie skrót), pobrany przy rejestracji aplikacji.",
    en: "The key file cannot be read. Choose a regular .pem file (not an alias), the one downloaded when you registered the application.",
  },
  keyInvalid: {
    pl: "Ten plik nie jest prywatnym kluczem RSA (co najmniej 2048 bitów). Użyj pliku .pem pobranego przy rejestracji aplikacji w Enable Banking.",
    en: "This file is not an RSA private key (at least 2048 bits). Use the .pem file downloaded when you registered the application in Enable Banking.",
  },
  configuration: {
    pl: "Nie udało się zapisać ustawień Enable Banking. Sprawdź identyfikator aplikacji i plik klucza.",
    en: "The Enable Banking settings could not be saved. Check the application ID and the key file.",
  },
  appIdRequired: {
    pl: "Wpisz identyfikator aplikacji: nazwa pliku klucza go nie zawiera.",
    en: "Enter the application ID: the key file's name does not contain it.",
  },
  keyHint: {
    pl: "Klucz jest odczytywany lokalnie. Hasło do banku wpisujesz tylko w przeglądarce banku.",
    en: "The key is read locally. Enter your bank password only in the bank's browser.",
  },
  check: { pl: "Sprawdź aplikację", en: "Check application" },
  banks: { pl: "Pobierz banki", en: "Load banks" },
  bank: { pl: "Bank", en: "Bank" },
  consent: { pl: "Połącz bank", en: "Connect bank" },
  openBank: { pl: "Otwórz stronę banku", en: "Open bank page" },
  manual: {
    pl: "Wklej pełny adres powrotu z przeglądarki",
    en: "Paste the full callback URL from the browser",
  },
  complete: { pl: "Dokończ połączenie", en: "Complete connection" },
  cancel: { pl: "Anuluj połączenie", en: "Cancel connection" },
  waiting: {
    pl: "Czekam na zgodę w przeglądarce banku.",
    en: "Waiting for consent in the bank browser.",
  },
  sessions: { pl: "Połączone banki", en: "Connected banks" },
  sync: { pl: "Synchronizuj teraz", en: "Sync now" },
  forget: { pl: "Usuń zapisane połączenie", en: "Forget saved connection" },
  localForget: {
    pl: "Usuwa połączenie z tego urządzenia.",
    en: "Removes the connection from this device.",
  },
  refreshed: { pl: "Dane zostały odświeżone.", en: "Data refreshed." },
  unknown: {
    pl: "Wynik importu jest nieznany. Sprawdź próbę przed ponowieniem.",
    en: "Import outcome is unknown. Check the attempt before retrying.",
  },
  checkAttempt: { pl: "Sprawdź próbę", en: "Check attempt" },
  completed: { pl: "Import zakończony.", en: "Import completed." },
  notStarted: { pl: "Import nie został rozpoczęty.", en: "Import was not started." },
  refused: { pl: "Import odrzucony.", en: "Import refused." },
  error: { pl: "Operacja nie powiodła się.", en: "Operation failed." },
  busy: { pl: "Trwa operacja...", en: "Working..." },
} as const;
