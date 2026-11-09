// Texts of the investments drawers (frontend/src/modules/investments/Drawers.tsx). See docs/agents/localization.md.
import { catalog } from "../index.js";

export const S = catalog({
  // import
  addAccount: { pl: "Dodaj rachunek", en: "Add an account" },
  colDate: { pl: "Data", en: "Date" },
  colType: { pl: "Typ", en: "Type" },
  colInstrument: { pl: "Instrument", en: "Instrument" },
  colQty: { pl: "Ilość", en: "Quantity" },

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
