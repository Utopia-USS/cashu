import { catalog } from "@cashu/i18n";

export const S = catalog({
  confirmDraft: {
    pl: "Akceptuję szkic przygotowany przez agenta",
    en: "I confirm this agent draft",
  },
  noChanges: { pl: "Brak zmian do zapisania", en: "No changes to save" },
  saved: { pl: "Zapisano", en: "Saved" },
  partialSave: {
    pl: "Teza została zapisana, ale widok rynku nie. Sprawdź, co się zapisało, zanim spróbujesz ponownie.",
    en: "The thesis was saved, but the market view was not. Check the current state before retrying.",
  },
  refused: { pl: "Nie zapisano", en: "Not saved" },
  unknown: {
    pl: "Nie wiadomo, czy się zapisało. Sprawdź aktualny stan.",
    en: "The outcome is unknown. Check the current state.",
  },
});
