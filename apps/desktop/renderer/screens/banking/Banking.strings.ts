export const B = {
  title: { pl: "Open Banking", en: "Open Banking" },
  unavailable: {
    pl: "Open Banking jest niedostępny dla tego profilu.",
    en: "Open Banking is unavailable for this profile.",
  },
  configure: { pl: "Skonfiguruj Enable Banking", en: "Configure Enable Banking" },
  appId: { pl: "Identyfikator aplikacji (Application ID)", en: "Application ID" },
  appIdHint: {
    pl: "Znajdziesz go w panelu Enable Banking, w nawiasie obok nazwy aplikacji. Możesz zostawić to pole puste: plik klucza nazywa się tak samo, więc cashU odczyta identyfikator z nazwy pliku.",
    en: "Find it in the Enable Banking Control Panel, in brackets next to the application name. You can leave it empty: the key file has the same name, so cashU reads it from the file name.",
  },
  dropKey: {
    pl: "Przeciągnij tutaj plik klucza prywatnego (.pem)",
    en: "Drag the private key file (.pem) here",
  },
  dropOr: { pl: "albo", en: "or" },
  chooseKey: { pl: "Wybierz plik klucza prywatnego", en: "Choose private key file" },
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
    pl: "Klucz jest odczytywany lokalnie. Hasło do banku wpisujesz tylko na stronie banku.",
    en: "The key is read locally. Enter your bank password only in the bank's browser.",
  },
  check: { pl: "Sprawdź aplikację", en: "Check application" },
  checked: {
    pl: "Połączenie z Enable Banking działa.",
    en: "The Enable Banking connection works.",
  },
  checkedApp: { pl: "Aplikacja:", en: "Application:" },
  bankSearch: { pl: "Szukaj banku", en: "Search for a bank" },
  bank: { pl: "Bank", en: "Bank" },
  banksLoading: { pl: "Pobieram listę banków...", en: "Loading the list of banks..." },
  banksFailed: {
    pl: "Nie udało się pobrać listy banków z Enable Banking.",
    en: "The list of banks could not be loaded from Enable Banking.",
  },
  banksRetry: { pl: "Pobierz listę banków ponownie", en: "Load the list again" },
  noBankMatch: {
    pl: "Żaden bank z listy Enable Banking nie pasuje. Sprawdź pisownię albo wpisz krótszą nazwę.",
    en: "No bank on Enable Banking's list matches. Check the spelling or type a shorter name.",
  },
  pickBank: {
    pl: "Wybierz bank z listy, żeby się połączyć.",
    en: "Pick a bank from the list to connect.",
  },
  consent: { pl: "Połącz bank", en: "Connect bank" },
  openBank: { pl: "Otwórz stronę banku", en: "Open bank page" },
  manual: {
    pl: "Wklej z przeglądarki pełny adres strony, na którą wrócisz z banku",
    en: "Paste the full callback URL from the browser",
  },
  complete: { pl: "Dokończ połączenie", en: "Complete connection" },
  cancel: { pl: "Anuluj połączenie", en: "Cancel connection" },
  waiting: {
    pl: "Czekam na Twoją zgodę na stronie banku.",
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
  attemptUnknown: {
    pl: "Nie wiadomo, czy ten import się udał.",
    en: "It is not known whether this import succeeded.",
  },
  importUnknown: {
    pl: "Nie wiadomo, czy import się udał. Kliknij „Sprawdź import” poniżej, zanim spróbujesz ponownie.",
    en: "It is not known whether the import succeeded. Press “Check attempt” below before you try again.",
  },
  changeUnknown: {
    pl: "Nie wiadomo, czy zmiana się zapisała. Zamknij Ustawienia i otwórz je ponownie, żeby zobaczyć aktualny stan.",
    en: "It is not known whether the change was saved. Close Settings and open them again to see the current state.",
  },
  previousUnknown: {
    pl: "Nie wiadomo, jak skończyła się poprzednia operacja. Kliknij „Sprawdź import” poniżej albo zamknij Ustawienia i otwórz je ponownie.",
    en: "The previous operation has an unknown outcome. Press “Check attempt” below, or close Settings and open them again.",
  },
  bankRefused: {
    pl: "Enable Banking nie przyjął tego połączenia. Wybierz bank z listy i spróbuj ponownie.",
    en: "Enable Banking did not accept this connection. Pick the bank from the list and try again.",
  },
  transport: {
    pl: "Brak połączenia z Enable Banking. Sprawdź internet i spróbuj ponownie.",
    en: "Enable Banking cannot be reached. Check the internet connection and try again.",
  },
  rateLimited: {
    pl: "Enable Banking chwilowo ogranicza zapytania. Spróbuj ponownie za kilka minut.",
    en: "Enable Banking is limiting requests for now. Try again in a few minutes.",
  },
  redirectNotAllowed: {
    pl: "Aplikacja w Enable Banking nie ma adresu powrotu cashU. W panelu Enable Banking dodaj do Redirect URLs adres https://127.0.0.1:18888/eb/callback i spróbuj ponownie.",
    en: "The Enable Banking application does not list cashU's return address. In the Enable Banking panel add https://127.0.0.1:18888/eb/callback to Redirect URLs and try again.",
  },
  unknownBank: {
    pl: "Enable Banking nie zna banku o tej nazwie. Wybierz bank z listy.",
    en: "Enable Banking does not know a bank of that name. Pick the bank from the list.",
  },
  appRestricted: {
    pl: "Aplikacja w Enable Banking nie ma jeszcze połączonych kont. W panelu Enable Banking kliknij przy aplikacji „Link accounts”, połącz konto w tym banku i spróbuj ponownie.",
    en: "The Enable Banking application has no linked accounts yet. In the Enable Banking panel press “Link accounts” on the application, link your account at this bank and try again.",
  },
  callback: {
    pl: "cashU nie może odebrać odpowiedzi z banku, bo port 18888 na tym komputerze jest zajęty. Zamknij drugą kopię cashU albo program, który go używa, i spróbuj ponownie.",
    en: "cashU cannot receive the bank's answer because port 18888 on this computer is in use. Close the other cashU copy or the program using it and try again.",
  },
  checkAttempt: { pl: "Sprawdź import", en: "Check attempt" },
  completed: { pl: "Import zakończony.", en: "Import completed." },
  notStarted: { pl: "Import nie został rozpoczęty.", en: "Import was not started." },
  refused: { pl: "Import odrzucony.", en: "Import refused." },
  error: { pl: "Operacja nie powiodła się.", en: "Operation failed." },
  busy: { pl: "Trwa operacja...", en: "Working..." },
} as const;
