import { catalog } from "@cashu/i18n";

export const O = catalog({
  refused: { pl: "Nie udało się zapisać zmiany.", en: "The change could not be saved." },
  unavailable: {
    pl: "Zapis jest teraz niedostępny. Spróbuj ponownie po przywróceniu połączenia.",
    en: "Saving is unavailable. Try again when the connection is restored.",
  },
  unknown: {
    pl: "Nie potwierdzono wyniku. Zachowaliśmy wpisane dane. Sprawdź stan przed ponowną próbą.",
    en: "The outcome is unconfirmed. Your draft is kept. Check the state before trying again.",
  },
  previousCompleted: {
    pl: "Poprzednią zmianę potwierdzono. Bieżący wpis pozostaje otwarty; zapisz go osobno.",
    en: "The previous change is confirmed. Your current draft remains open; save it separately.",
  },
  previousRefused: {
    pl: "Poprzedniej zmiany nie zapisano. Bieżący wpis pozostaje otwarty.",
    en: "The previous change was refused. Your current draft remains open.",
  },
});
