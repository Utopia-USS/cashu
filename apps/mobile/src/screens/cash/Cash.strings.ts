import { catalog } from "@cashu/i18n";

export const S = catalog({
  cashExpense: { pl: "Wydatek gotówkowy", en: "Cash expense" },
  close: { pl: "Zamknij", en: "Close" },
  /** The typed amount while amounts are hidden: the digits as typed, with the currency. */
  typed: {
    pl: (amount: string, currency: string) => `${amount} ${currency}`,
    en: (amount: string, currency: string) => `${currency} ${amount}`,
  },
  /** Around the wallet balance: "From your cash wallet · PLN 320.00 in it". */
  walletBefore: { pl: "Z portfela z gotówką (jest w nim ", en: "From your cash wallet · " },
  walletAfter: { pl: ")", en: " in it" },
  walletNew: {
    pl: "Portfel z gotówką powstanie przy pierwszym wydatku",
    en: "A cash wallet is created with the first expense",
  },
  more: { pl: "Więcej", en: "More" },
  titleLabel: { pl: "Na co", en: "What it was" },
  titlePlaceholder: { pl: "Na co to było?", en: "What was it?" },
  date: { pl: "Dzień", en: "Day" },
  today: { pl: "Dzisiaj", en: "Today" },
  yesterday: { pl: "Wczoraj", en: "Yesterday" },
  backspace: { pl: "Usuń", en: "Delete" },
  add: {
    pl: (amount: string) => `Dodaj ${amount}`,
    en: (amount: string) => `Add ${amount}`,
  },
  addExpense: { pl: "Dodaj wydatek", en: "Add expense" },
  errorAmount: { pl: "Wpisz kwotę większą od zera.", en: "Enter an amount above zero." },
  errorTitle: { pl: "Wpisz, na co to było.", en: "Say what it was." },
  errorCategory: { pl: "Wybierz kategorię.", en: "Pick a category." },
  couldNotSave: {
    pl: "Nie udało się zapisać. Spróbuj jeszcze raz.",
    en: "Could not save. Try again.",
  },
  firstSaveWent: {
    pl: "Pierwszy zapis się udał. Sprawdź wpis przed ponownym zapisaniem.",
    en: "The first save went through. Check the entry before saving again.",
  },
});
