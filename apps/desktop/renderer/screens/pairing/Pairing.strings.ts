import { catalog } from "@cashu/i18n";

export const T = catalog({
  title: { pl: "Połącz telefon", en: "Pair a phone" },
  // #23.7 verbatim.
  intro: {
    pl: "Otwórz cashU na telefonie i zeskanuj ten kod. Telefon potrzebuje internetu; Mac nie musi być włączony.",
    en: "Open cashU on your phone and scan this code. The phone needs internet; the Mac does not have to stay on.",
  },
  create: { pl: "Utwórz zaproszenie", en: "Create invitation" },
  qrLabel: { pl: "Kod zaproszenia dla telefonu", en: "Invitation code for phone" },
  pasteHint: {
    pl: "Jeśli aparat nie działa, przekaż ten kod na telefon w zaufany sposób i wklej go tam.",
    en: "If the camera is unavailable, pass this code to the phone in a trusted way and paste it there.",
  },
  // Designer addendum 2 (2026-11-14): the code as text under the QR, for the phone's paste path.
  copy: { pl: "Kopiuj kod", en: "Copy code" },
  codeLabel: { pl: "Kod do wklejenia na telefonie", en: "Code to paste on the phone" },
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
  // Proposed (W3-7 addendum a), for the designer: the phone is admitted, its first sync not seen yet.
  waitingForPhone: {
    pl: "Telefon dodany. Czekamy na jego pierwszą synchronizację: zostaw cashU otwarte na telefonie, aż się skończy.",
    en: "Phone added. Waiting for its first sync: keep cashU open on the phone until it finishes.",
  },
  complete: { pl: "Telefon połączono.", en: "Phone paired." },
  refused: {
    pl: "Nie udało się połączyć telefonu. Sprawdź stan urządzeń, zanim spróbujesz ponownie.",
    en: "The phone could not be paired. Check device status before trying again.",
  },
  unavailable: { pl: "Łączenie jest teraz niedostępne.", en: "Pairing is unavailable now." },
  expired: { pl: "Zaproszenie wygasło.", en: "Invitation expired." },
  // #23.8 (a).
  newCode: { pl: "Pokaż nowy kod", en: "Show a new code" },
  // Lead addendum 3b: refusals relay_off / no_config.
  syncOff: {
    pl: "Najpierw włącz synchronizację: telefon łączy się z Makiem przez nią.",
    en: "Turn on sync first: the phone connects to your Mac through it.",
  },
  goToSync: { pl: "Przejdź do synchronizacji", en: "Go to sync" },
});
