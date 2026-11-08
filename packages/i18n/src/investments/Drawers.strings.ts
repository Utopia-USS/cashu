// Texts of the investments drawers (frontend/src/modules/investments/Drawers.tsx). See docs/agents/localization.md.
import { catalog, enCount, plCount } from "../index.js";

export const S = catalog({
  row: { pl: (n: number) => `wiersz ${n}: `, en: (n: number) => `row ${n}: ` },

  // import
  back: { pl: "← Wstecz", en: "← Back" },
  importing: { pl: "Importuję…", en: "Importing…" },
  runningConnector: { pl: "Uruchamiam konektor…", en: "Running the connector…" },
  checking: { pl: "Sprawdzam…", en: "Checking…" },
  preview: { pl: "Podgląd", en: "Preview" },
  importTitle: { pl: "Import transakcji", en: "Import transactions" },
  stepDone: { pl: "Gotowe", en: "Done" },
  addAccount: { pl: "Dodaj rachunek", en: "Add an account" },
  brokerFile: { pl: "Plik od brokera", en: "File from the broker" },
  importer: { pl: "Importer", en: "Importer" },
  connectors: { pl: "Konektory", en: "Connectors" },
  remembered: {
    pl: (name: string) => `zapamiętany: ${name}`,
    en: (name: string) => `remembered: ${name}`,
  },
  notApproved: { pl: " (niezatwierdzony)", en: " (not approved)" },
  detected: {
    pl: (name: string) => ` · rozpoznano: ${name}`,
    en: (name: string) => ` · detected: ${name}`,
  },
  nRows: {
    pl: (n: number) => plCount(n, "wiersz", "wiersze", "wierszy"),
    en: (n: number) => enCount(n, "row", "rows"),
  },
  fileErrors: {
    pl: "Plik ma błędy: popraw je przed importem.",
    en: "The file has errors: fix them before importing.",
  },
  importedBefore: {
    pl: (d: string) => `Plik importowany już ${d}: powtórzone wiersze to duplikaty.`,
    en: (d: string) => `File already imported on ${d}: repeated rows are duplicates.`,
  },
  nNew: { pl: (n: number) => plCount(n, "nowy", "nowe", "nowych"), en: (n: number) => `${n} new` },
  nDuplicates: {
    pl: (n: number) => plCount(n, "duplikat", "duplikaty", "duplikatów"),
    en: (n: number) => enCount(n, "duplicate", "duplicates"),
  },
  nSkipped: {
    pl: (n: number) => plCount(n, "pominięty", "pominięte", "pominiętych"),
    en: (n: number) => `${n} skipped`,
  },
  colDate: { pl: "Data", en: "Date" },
  colType: { pl: "Typ", en: "Type" },
  colInstrument: { pl: "Instrument", en: "Instrument" },
  colQty: { pl: "Ilość", en: "Quantity" },
  colAmount: { pl: "Kwota", en: "Amount" },
  colStatus: { pl: "Status", en: "Status" },
  newInstrument: { pl: "nowy instrument", en: "new instrument" },
  duplicate: { pl: "duplikat", en: "duplicate" },
  new: { pl: "nowy", en: "new" },
  skipped: { pl: "pominięty", en: "skipped" },
  moreRows: {
    pl: (n: number) => `… ${n} kolejnych wierszy · `,
    en: (n: number) => `… ${n} more rows · `,
  },
  showAll: { pl: "pokaż wszystkie", en: "show all" },
  reconciliation: { pl: "Uzgodnienie", en: "Reconciliation" },
  matching: { pl: "zgodne", en: "matching" },
  correction: {
    pl: (add: boolean, q: string, d: string | null) =>
      `${add ? "dodaj" : "odejmij"} ${q} szt.${d ? ` (korekta stanu na ${d})` : ""}`,
    en: (add: boolean, q: string, d: string | null) =>
      `${add ? "add" : "subtract"} ${q} units${d ? ` (holdings adjustment on ${d})` : ""}`,
  },
  imported: {
    pl: (txns: string, corrections: number) =>
      `Zaimportowano ${txns}${corrections ? ` i ${plCount(corrections, "korektę", "korekty", "korekt")}` : ""}.`,
    en: (txns: string, corrections: number) =>
      `Imported ${txns}${corrections ? ` and ${enCount(corrections, "adjustment", "adjustments")}` : ""}.`,
  },
  classify: {
    pl: (n: number) => `Sklasyfikuj ${plCount(n, "instrument", "instrumenty", "instrumentów")}`,
    en: (n: number) => `Classify ${enCount(n, "instrument", "instruments")}`,
  },

  // manual transaction
  fxRequired: {
    pl: (acc: string, cur: string) => `Podaj kurs: ${acc} za 1 ${cur}.`,
    en: (acc: string, cur: string) => `Enter the rate: ${acc} per 1 ${cur}.`,
  },
  addTxn: { pl: "Dodaj transakcję", en: "Add a transaction" },
  cashEffect: {
    pl: (m: string) => `Wpływ na gotówkę: ${m}`,
    en: (m: string) => `Effect on cash: ${m}`,
  },
  noCashEffect: { pl: "bez wpływu na gotówkę", en: "no effect on cash" },
  saving: { pl: "Zapisuję…", en: "Saving…" },
  notSaved: { pl: (e: string) => `Nie zapisano: ${e}`, en: (e: string) => `Not saved: ${e}` },
  account: { pl: "Rachunek", en: "Account" },
  optional: { pl: " (opcjonalnie)", en: " (optional)" },
  noInstrument: { pl: "bez instrumentu", en: "no instrument" },
  choose: { pl: "wybierz…", en: "choose…" },
  newInstrumentOpt: { pl: "nowy instrument…", en: "new instrument…" },
  symbol: { pl: "Symbol", en: "Symbol" },
  symbolPlaceholder: { pl: "np. VWCE", en: "e.g. VWCE" },
  isin: { pl: "ISIN (zalecany)", en: "ISIN (recommended)" },
  name: { pl: "Nazwa", en: "Name" },
  emptyUnknownCost: { pl: "Pusta = koszt nieznany", en: "Empty = cost unknown" },
  price: { pl: (c: string) => `Cena (${c})`, en: (c: string) => `Price (${c})` },
  amount: { pl: (c: string) => `Kwota (${c})`, en: (c: string) => `Amount (${c})` },
  splitRatio: { pl: "Współczynnik (nowe na 1 starą)", en: "Ratio (new per 1 old)" },
  fee: { pl: "Prowizja", en: "Fee" },
  txnCurrency: { pl: "Waluta transakcji", en: "Transaction currency" },
  quotedIn: {
    pl: (c: string) => `instrument jest notowany w ${c}`,
    en: (c: string) => `the instrument is quoted in ${c}`,
  },
  rate: {
    pl: (acc: string, cur: string) => `Kurs (${acc} za 1 ${cur})`,
    en: (acc: string, cur: string) => `Rate (${acc} per 1 ${cur})`,
  },
  note: { pl: "Notatka", en: "Note" },
  unsignedFoot: {
    pl: "Kwoty bez znaku; kierunek wynika z typu.",
    en: "Amounts without a sign; the type sets the direction.",
  },

  // brokerage account
  otherManual: { pl: "inny (ręcznie)", en: "other (manual)" },
  accountExists: {
    pl: "Rachunek o tej nazwie u tego brokera już istnieje.",
    en: "An account with this name already exists at this broker.",
  },
  addBrokerage: { pl: "Dodaj rachunek maklerski", en: "Add a brokerage account" },
  broker: { pl: "Broker", en: "Broker" },
  wrapper: { pl: "Opakowanie", en: "Wrapper" },
  currency: { pl: "Waluta", en: "Currency" },

  // thesis
  editThesis: { pl: "Edytuj tezę", en: "Edit the thesis" },
  addThesis: { pl: "Dodaj tezę", en: "Add a thesis" },
  thesis: { pl: "Teza", en: "Thesis" },
  reviewedToday: { pl: "przejrzana dziś", en: "reviewed today" },
  entryType: { pl: "Typ wejścia", en: "Entry type" },
  entry: { pl: "Wejście", en: "Entry" },
  entryPlaceholder: { pl: "Dlaczego ta pozycja?", en: "Why this position?" },
  invalidation: { pl: "Unieważnienie", en: "Invalidation" },
  invalidationPlaceholder: { pl: "Co by znaczyło, że się mylę?", en: "What would mean I'm wrong?" },
  exitPlan: { pl: "Plan wyjścia", en: "Exit plan" },
  sizePlan: { pl: "Wielkość i dokupienia", en: "Size and adding to it" },

  // an instrument's transactions
  srcImport: { pl: "import", en: "import" },
  srcManual: { pl: "ręcznie", en: "manual" },
  srcReconciliation: { pl: "korekta", en: "adjustment" },
  txns: { pl: "Transakcje", en: "Transactions" },
  txnsLabel: { pl: "Transakcje instrumentu", en: "Instrument transactions" },
  colPrice: { pl: "Cena", en: "Price" },
  colCash: { pl: "Gotówka", en: "Cash" },
  colSource: { pl: "Źródło", en: "Source" },
  noTxns: { pl: "Brak transakcji.", en: "No transactions." },
});
