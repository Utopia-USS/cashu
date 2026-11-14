// The pairing flow on the phone (design pair steps, dev-feedback #23.8): scan or paste the Mac's code,
// the six digits, receiving, the role, the first sync, and every way it can stop. The user never sees
// "relay": the concept is sync / synchronizacja. PL + EN. Copy marked "proposed" waits for the
// designer's pass (scratch f52-w3-phone-pairing.md lists it).
import { catalog, enCount, plCount } from "@cashu/i18n";

const pln = new Intl.NumberFormat("pl-PL");
const eng = new Intl.NumberFormat("en-US");
/** m:ss of a countdown. */
const clock = (seconds: number) =>
  `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;

export const S = catalog({
  close: { pl: "Zamknij", en: "Close" },
  // The profile's name on this phone until the first sync brings the real one.
  newProfile: { pl: "Nowy profil", en: "New profile" },
  cancel: { pl: "Anuluj", en: "Cancel" },
  // Scan (prototype step 1).
  scanTitle: { pl: "Zeskanuj kod z Maca", en: "Scan the code on your Mac" },
  scanWhere: {
    pl: "Na Macu: Ustawienia > Urządzenia > Połącz telefon",
    en: "On the Mac: Settings > Devices > Connect a phone",
  },
  scanNote: {
    pl: "Kod jest zaproszeniem tylko dla tego telefonu i szybko wygasa.",
    en: "The code is an invitation for this phone only and expires soon.",
  },
  scannerLabel: { pl: "Aparat do skanowania kodu", en: "Camera for scanning the code" },
  cameraAsk: { pl: "Zezwól na dostęp do aparatu", en: "Allow the camera" },
  cameraDenied: {
    pl: "cashU nie ma dostępu do aparatu. Wklej kod z Maca albo włącz aparat w Ustawieniach iOS.",
    en: "cashU can't use the camera. Paste the code from your Mac, or turn the camera on in iOS Settings.",
  },
  pasteInstead: { pl: "Wklej kod", en: "Paste the code" },
  scanInstead: { pl: "Skanuj aparatem", en: "Scan with the camera" },
  pasteLabel: { pl: "Kod z Maca", en: "Code from your Mac" },
  pasteHint: {
    pl: "Na Macu wybierz „Kopiuj kod” pod kodem QR i wklej go tutaj.",
    en: "On the Mac, choose “Copy code” under the QR code and paste it here.",
  },
  pasteGo: { pl: "Połącz", en: "Connect" },
  notACode: {
    pl: "To nie jest kod cashU. Zeskanuj kod z Ustawień > Urządzenia na Macu.",
    en: "This is not a cashU code. Scan the code from Settings > Devices on your Mac.",
  },
  nameLabel: { pl: "Nazwa tego telefonu na Macu", en: "This phone's name on your Mac" },
  // Discard (proposed): this phone holds the profile with changes that never reached the Mac.
  discardTitle: {
    pl: (profile: string) => `Niewysłane zmiany w profilu ${profile}`,
    en: (profile: string) => `Unsent changes in ${profile}`,
  },
  discardBody: {
    pl: "Ten telefon ma zmiany, które nie dotarły do Maca. Ponowne połączenie je usunie.",
    en: "This phone has changes that never reached your Mac. Connecting again removes them.",
  },
  discardYes: { pl: "Usuń je i połącz", en: "Remove them and connect" },
  // Connecting.
  connecting: { pl: "Łączenie z Makiem...", en: "Connecting to your Mac..." },
  // Code (prototype step 2).
  codeTitle: { pl: "Wpisz te cyfry na Macu", en: "Type these digits on your Mac" },
  codeBody: {
    pl: "Jeśli Mac prosi o inne cyfry, przerwij: ktoś inny mógł zeskanować kod.",
    en: "If the Mac asks for different digits, stop: someone else may have scanned the code.",
  },
  codeDigits: {
    pl: (digits: string) => `Kod: ${digits.split("").join(" ")}`,
    en: (digits: string) => `Code: ${digits.split("").join(" ")}`,
  },
  codeExpires: {
    pl: (seconds: number) => `Kod wygasa za ${clock(seconds)}`,
    en: (seconds: number) => `The code expires in ${clock(seconds)}`,
  },
  codeName: {
    pl: (name: string) => `Na Macu ten telefon będzie widoczny jako „${name}”`,
    en: (name: string) => `Your Mac will list this phone as “${name}”`,
  },
  // Receiving.
  receiving: { pl: "Odbieranie klucza profilu...", en: "Receiving the profile's key..." },
  receivingParts: {
    pl: (n: number) => `Odebrano ${plCount(n, "część", "części", "części")}`,
    en: (n: number) => `${enCount(n, "part", "parts")} received`,
  },
  storing: { pl: "Zapisywanie na tym telefonie...", en: "Saving on this phone..." },
  // Role (#23.4).
  roleTitle: { pl: "Czyj to telefon?", en: "Whose phone is this?" },
  roleMine: { pl: "Ten telefon jest mój", en: "This phone is mine" },
  rolePartner: { pl: "To telefon partnera lub partnerki", en: "This phone is my partner's" },
  roleSub: {
    pl: "Od tego zależą powiadomienia. Możesz to zmienić później w profilu.",
    en: "This decides the notifications. You can change it later in the profile sheet.",
  },
  roleContinue: { pl: "Dalej", en: "Continue" },
  // First sync (prototype step 3, #23.8).
  firstSyncTitle: {
    pl: "Profil trafia na ten telefon",
    en: "Your profile is coming to this phone",
  },
  firstSyncProgress: {
    pl: (done: number, total: number) =>
      `Odbieranie danych z Maca · ${pln.format(done)} z ~${pln.format(total)}`,
    en: (done: number, total: number) =>
      `Receiving your data from your Mac · ${eng.format(done)} of ~${eng.format(total)}`,
  },
  firstSyncWaiting: {
    pl: "Czekanie na dane z Maca...",
    en: "Waiting for your data from your Mac...",
  },
  doneTitle: {
    pl: (profile: string) => `Profil ${profile} jest gotowy na tym telefonie`,
    en: (profile: string) => `${profile} is ready on this phone`,
  },
  stillReceiving: {
    pl: "Starsza historia jeszcze dochodzi; możesz już korzystać z cashU.",
    en: "Older history is still arriving; you can use cashU already.",
  },
  storedNote: {
    pl: "Dane są zaszyfrowane na tym telefonie. Włącz Face ID, żeby nikt poza Tobą ich nie otworzył.",
    en: "Stored encrypted on this phone. Turn on Face ID so only you can open it.",
  },
  open: { pl: "Otwórz cashU", en: "Open cashU" },
  // Stopped (#23.8 and proposed).
  scanAgain: { pl: "Skanuj ponownie", en: "Scan again" },
  failedTitle: { pl: "Nie udało się połączyć", en: "Couldn't connect" },
  failed: {
    pl: (
      reason:
        | "expired"
        | "taken"
        | "other_project"
        | "offline"
        | "no_sync"
        | "refused"
        | "unpushed"
        | "failed",
    ): string => {
      switch (reason) {
        case "expired":
          return "Kod wygasł. Na Macu wybierz „Pokaż nowy kod” i zeskanuj go ponownie.";
        case "taken":
          return "Ten kod został już użyty przez inne urządzenie. Pokaż nowy kod na Macu.";
        case "other_project":
          return "Ten kod pochodzi z innej wersji cashU niż ten telefon.";
        case "offline":
          return "Brak połączenia z synchronizacją. Sprawdź internet w telefonie i spróbuj ponownie.";
        case "no_sync":
          return "Ta wersja cashU nie ma skonfigurowanej synchronizacji.";
        case "refused":
          return "Mac przerwał łączenie. Pokaż nowy kod na Macu i zeskanuj go ponownie.";
        case "unpushed":
          return "Na tym telefonie pojawiły się nowe niewysłane zmiany. Zeskanuj nowy kod.";
        default:
          return "Łączenie nie zostało dokończone. Pokaż nowy kod na Macu i zeskanuj go ponownie.";
      }
    },
    en: (
      reason:
        | "expired"
        | "taken"
        | "other_project"
        | "offline"
        | "no_sync"
        | "refused"
        | "unpushed"
        | "failed",
    ): string => {
      switch (reason) {
        case "expired":
          return "The code expired. On the Mac, choose “Show a new code” and scan it again.";
        case "taken":
          return "Another device already used this code. Show a new code on your Mac.";
        case "other_project":
          return "This code comes from a different cashU build than this phone.";
        case "offline":
          return "Can't reach sync. Check this phone's internet and try again.";
        case "no_sync":
          return "This version of cashU has no sync set up.";
        case "refused":
          return "The Mac stopped connecting. Show a new code on your Mac and scan it again.";
        case "unpushed":
          return "New unsent changes appeared on this phone. Scan a new code.";
        default:
          return "Connecting didn't finish. Show a new code on your Mac and scan it again.";
      }
    },
  },
});
