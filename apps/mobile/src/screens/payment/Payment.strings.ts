// The payment sheet: one payment, its category, the rule for its payee, its details and the payee's
// earlier payments. PL + EN.
import { catalog } from "@cashu/i18n";

export const S = catalog({
  close: { pl: "Zamknij", en: "Close" },
  missing: { pl: "Tej płatności już nie ma", en: "This payment is gone" },
  betweenOwn: { pl: "Między Twoimi kontami", en: "Between your own accounts" },
  transferBody: {
    pl: (counterpart: string) =>
      ` - rozpoznane po numerze konta ${counterpart}, więc nie liczy się do wydatków.`,
    en: (counterpart: string) =>
      ` - recognised by the account number of ${counterpart}, so it does not count as spending.`,
  },
  transferBodyPlain: {
    pl: " - rozpoznane po numerze konta, więc nie liczy się do wydatków.",
    en: " - recognised by the account number, so it does not count as spending.",
  },
  category: { pl: "Kategoria", en: "Category" },
  suggested: {
    pl: (category: string) => `propozycja: ${category}`,
    en: (category: string) => `suggested: ${category}`,
  },
  suggestedHint: { pl: "Propozycja", en: "Suggested" },
  more: { pl: "Więcej", en: "More" },
  couldNotSave: {
    pl: "Nie udało się zapisać. Spróbuj jeszcze raz.",
    en: "Could not save. Try again.",
  },
  ruleActive: {
    pl: (category: string) => `Zawsze w kategorii ${category}`,
    en: (category: string) => `Always filed under ${category}`,
  },
  details: { pl: "Szczegóły", en: "Details" },
  account: { pl: "Konto", en: "Account" },
  date: { pl: "Data", en: "Date" },
  statement: { pl: "Tytuł z wyciągu", en: "Statement" },
  imported: {
    pl: (date: string, source: string) => `Zaimportowano ${date} · ${source}`,
    en: (date: string, source: string) => `Imported ${date} · ${source}`,
  },
  sourceOpenBanking: { pl: "Open Banking", en: "open banking" },
  sourceCsv: { pl: "plik z wyciągiem", en: "statement file" },
  sourceManual: { pl: "dodane ręcznie", en: "added by hand" },
  sourceConnector: { pl: "konektor", en: "connector" },
  earlierWith: {
    pl: (payee: string) => `Wcześniejsze płatności: ${payee}`,
    en: (payee: string) => `Earlier with ${payee}`,
  },
  firstPayment: {
    pl: (payee: string) => `Pierwsza płatność w Twojej historii: ${payee}.`,
    en: (payee: string) => `First payment to ${payee} in your history.`,
  },
});
