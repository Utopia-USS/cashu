/**
 * UI texts of the budget's blank-page steps (`modules/budget/setup.py`), Polish and English, byte-equal
 * to the Python source (parity check `core.overview`). The CLI placeholder file name is UI text too.
 */

export const budgetSetupStrings = {
  statementTitle: { pl: "Pierwszy wyciąg z banku", en: "First bank statement" },
  statementDescription: {
    pl: "Plik CSV (mBank, Pekao, Erste) albo Open Banking.",
    en: "A CSV file (mBank, Pekao, Erste) or Open Banking.",
  },
  statementFile: { pl: "WYCIAG.csv", en: "STATEMENT.csv" },
  categoriesTitle: { pl: "Kategorie wydatków", en: "Expense categories" },
  categoriesDescription: {
    pl: "W zakładce Wydatki; reguła zapamięta sprzedawcę.",
    en: "In the Expenses tab; a rule remembers the merchant.",
  },
  expensesTab: { pl: "Wydatki", en: "Expenses" },
  transfersTitle: { pl: "Przelewy między kontami", en: "Transfers between accounts" },
  transfersSingle: {
    pl: "Jedno konto bankowe: nic do dopasowania.",
    en: "One bank account: nothing to match.",
  },
  transfersDescription: {
    pl: "Rozpoznawane po IBAN-ach Twoich kont; nie liczą się jako wydatki.",
    en: "By IBAN between your accounts; they do not count as expenses.",
  },
} as const;
