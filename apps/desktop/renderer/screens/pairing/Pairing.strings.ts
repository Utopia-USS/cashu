import { catalog } from "@cashu/i18n";

export const T = catalog({
  title: { pl: "Połącz telefon", en: "Pair a phone" },
  intro: {
    pl: "Otwórz cashU na telefonie i zeskanuj kod. cashU na komputerze musi być uruchomione i dostępne w tej samej sieci podczas łączenia i synchronizacji.",
    en: "Open cashU on your phone and scan the code. cashU must be running on the computer and available on the same network for pairing and sync.",
  },
  create: { pl: "Utwórz zaproszenie", en: "Create invitation" },
  qrLabel: { pl: "Kod zaproszenia dla telefonu", en: "Invitation code for phone" },
  pasteHint: {
    pl: "Jeśli aparat nie działa, przekaż zaproszenie na telefon w zaufany sposób.",
    en: "If the camera is unavailable, copy the invitation to the phone using a trusted method.",
  },
  copy: { pl: "Kopiuj zaproszenie", en: "Copy invitation" },
  expiry: { pl: "Zaproszenie wygasa o", en: "Invitation expires at" },
  sasInstruction: {
    pl: "Wpisz sześć cyfr wyświetlonych na telefonie.",
    en: "Type the six digits shown on your phone.",
  },
  sasLabel: { pl: "Sześć cyfr z telefonu", en: "Six digits from phone" },
  confirm: { pl: "Potwierdź kod", en: "Confirm code" },
  cancel: { pl: "Anuluj zaproszenie", en: "Cancel invitation" },
  checking: { pl: "Sprawdzanie stanu...", en: "Checking this operation..." },
  inspect: { pl: "Sprawdź wynik", en: "Check outcome" },
  unknown: {
    pl: "Nie wiadomo, czy się udało. Sprawdź, czy telefon został dodany, zanim utworzysz nowe zaproszenie.",
    en: "The outcome is unknown. Check whether the phone was added before creating another invitation.",
  },
  complete: { pl: "Telefon połączono.", en: "Phone paired." },
  refused: {
    pl: "Nie udało się połączyć telefonu. Sprawdź stan urządzeń, zanim spróbujesz ponownie.",
    en: "The phone could not be paired. Check device status before trying again.",
  },
  unavailable: { pl: "Łączenie jest teraz niedostępne.", en: "Pairing is unavailable now." },
  expired: { pl: "Zaproszenie wygasło.", en: "Invitation expired." },
});
