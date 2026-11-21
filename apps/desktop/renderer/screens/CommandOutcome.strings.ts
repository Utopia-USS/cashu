import { catalog } from "@cashu/i18n";

export const O = catalog({
  refused: { pl: "Nie udało się zapisać zmiany.", en: "The change could not be saved." },
  unavailable: {
    pl: "Nie można teraz zapisać. Spróbuj ponownie, gdy połączenie wróci.",
    en: "Saving is unavailable. Try again when the connection is restored.",
  },
  unknown: {
    pl: "Nie wiadomo, czy zmiana się zapisała. Wpisane dane zostały zachowane. Sprawdź, zanim spróbujesz ponownie.",
    en: "The outcome is unconfirmed. Your draft is kept. Check the state before trying again.",
  },
  previousCompleted: {
    pl: "Poprzednia zmiana została zapisana. To, co wpisujesz teraz, nie jest jeszcze zapisane; zapisz to osobno.",
    en: "The previous change is confirmed. Your current draft remains open; save it separately.",
  },
  previousRefused: {
    pl: "Poprzednia zmiana nie została zapisana. To, co wpisujesz teraz, zostaje w formularzu.",
    en: "The previous change was refused. Your current draft remains open.",
  },
});
