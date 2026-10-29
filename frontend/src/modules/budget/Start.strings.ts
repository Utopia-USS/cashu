// Texts of the budget's first steps (Start.tsx). See src/i18n.ts.
import { catalog, enCount, plCount } from "../../i18n.ts";

export const S = catalog({
  matched: {
    pl: (n: number) => `Dopasowano ${plCount(n, "parę", "pary", "par")} przelewów`,
    en: (n: number) => `Matched ${enCount(n, "transfer pair", "transfer pairs")}`,
  },
  noPairs: { pl: "Brak par do dopasowania", en: "No pairs to match" },
  notMatched: { pl: (reason: string) => `Nie dopasowano: ${reason}`, en: (reason: string) => `Not matched: ${reason}` },
  statementTitle: { pl: "Pierwszy wyciąg z banku", en: "First bank statement" },
  nAccounts: { pl: (n: number) => plCount(n, "konto", "konta", "kont"), en: (n: number) => enCount(n, "account", "accounts") },
  statementHint: { pl: "Plik CSV (mBank, Pekao, Erste) albo Open Banking.", en: "A CSV file (mBank, Pekao, Erste) or Open Banking." },
  importAnother: { pl: "Importuj kolejny", en: "Import another" },
  importStatement: { pl: "Importuj wyciąg", en: "Import a statement" },
  categoriesTitle: { pl: "Kategorie wydatków", en: "Expense categories" },
  categoriesCount: {
    pl: (n: number) => `${plCount(n, "sprzedawca", "sprzedawców", "sprzedawców")} bez kategorii · reguła zapamięta wybór.`,
    en: (n: number) => `${enCount(n, "merchant", "merchants")} without a category · a rule remembers the choice.`,
  },
  categoriesHint: { pl: "Najczęstsi sprzedawcy bez kategorii; reguła zapamięta wybór.", en: "The most frequent merchants without a category; a rule remembers the choice." },
  review: { pl: "Przejrzyj", en: "Review" },
  expensesLink: { pl: "Wydatki →", en: "Expenses →" },
  transfersTitle: { pl: "Przelewy między kontami", en: "Transfers between accounts" },
  matching: { pl: "Dopasowuję…", en: "Matching…" },
  match: { pl: "Dopasuj", en: "Match" },
  title: { pl: "Budżet domowy", en: "Home budget" },
  importedN: {
    pl: (n: number) => `Zaimportowano ${plCount(n, "transakcję", "transakcje", "transakcji")}`,
    en: (n: number) => `Imported ${enCount(n, "transaction", "transactions")}`,
  },
});
