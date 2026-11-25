import { catalog, enCount, enForm, plCount } from "@cashu/i18n";

export const S = catalog({
  categorize: { pl: "Przypisz kategorie", en: "Categorize" },
  close: { pl: "Zamknij", en: "Close" },
  skip: { pl: "Pomiń", en: "Skip" },
  stepOf: {
    pl: (step: number, total: number) => `${step} z ${total}`,
    en: (step: number, total: number) => `${step} of ${total}`,
  },
  card: {
    pl: (date: string, account: string) => `${date} · ${account}`,
    en: (date: string, account: string) => `${date} · ${account}`,
  },
  suggested: { pl: "Propozycja", en: "Suggested" },
  useIt: { pl: "Użyj", en: "Use it" },
  orPickAnother: { pl: "Albo wybierz inną", en: "Or pick another" },
  pickCategory: { pl: "Wybierz kategorię", en: "Pick a category" },
  more: { pl: "Więcej", en: "More" },
  noSuggestion: {
    pl: "Jeszcze bez propozycji - wybierz niżej",
    en: "No suggestion yet - pick one below",
  },
  couldNotSave: {
    pl: "Nie udało się zapisać. Spróbuj jeszcze raz.",
    en: "Could not save. Try again.",
  },
  allCategorized: { pl: "Wszystko ma kategorię", en: "All categorized" },
  doneBody: {
    pl: (n: number) =>
      `Gotowe: ${plCount(n, "płatność", "płatności", "płatności")}. Pozostałe urządzenia zobaczą zmiany przy następnej synchronizacji.`,
    en: (n: number) =>
      `${enCount(n, "payment", "payments")} done. Your other devices see ${enForm(n, "it", "them")} at the next sync.`,
  },
  moreLeft: {
    pl: (n: number) => `Jeszcze ${plCount(n, "płatność", "płatności", "płatności")} bez kategorii.`,
    en: (n: number) =>
      `${enCount(n, "more payment is", "more payments are")} still without a category.`,
  },
  continue: { pl: "Dalej", en: "Continue" },
  done: { pl: "Gotowe", en: "Done" },
  nothingToDo: { pl: "Każda płatność ma już kategorię", en: "Nothing to categorize" },
});
