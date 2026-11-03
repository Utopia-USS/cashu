import { catalog } from "@cashu/i18n";

export const W = catalog({
  accounts: { pl: "Konta", en: "Accounts" },
  noAccounts: { pl: "Brak kont bankowych.", en: "No bank accounts." },
  showEmpty: {
    pl: (count: number) => `Pokaż puste (${count})`,
    en: (count: number) => `Show empty (${count})`,
  },
  hideEmpty: { pl: "Ukryj puste", en: "Hide empty" },
  cash: { pl: "Gotówka", en: "Cash" },
  wallet: { pl: "Portfel gotówkowy", en: "Cash wallet" },
  addCashExpense: { pl: "Dodaj wydatek gotówkowy", en: "Add cash expense" },
  amount: { pl: "Kwota", en: "Amount" },
  title: { pl: "Tytuł", en: "Title" },
  category: { pl: "Kategoria", en: "Category" },
  add: { pl: "Dodaj", en: "Add" },
  remove: { pl: "Usuń", en: "Remove" },
  close: { pl: "Zamknij", en: "Close" },
  noCash: { pl: "Brak operacji gotówkowych.", en: "No cash transactions." },
  withdrawnSpent: {
    pl: "Wpłaty gotówki / wydatki",
    en: "Cash in / expenses",
  },
  invalidCash: {
    pl: "Podaj dodatnią kwotę i tytuł.",
    en: "Enter a positive amount and a title.",
  },
  cashRefused: {
    pl: "Nie udało się zmienić portfela gotówkowego.",
    en: "The cash wallet could not be changed.",
  },
  ofMonthlySpending: { pl: "wydatków miesięcznych", en: "of monthly spending" },
  ofMonthlyIncome: { pl: "miesięcznych przychodów", en: "of monthly income" },
  invalidAsset: { pl: "Sprawdź nazwę, kwotę i datę.", en: "Check the name, amount and date." },
  assetRefused: {
    pl: "Nie udało się zmienić pozycji majątku.",
    en: "The asset could not be changed.",
  },
  investmentUnavailable: {
    pl: "Dane inwestycji będą dostępne po podłączeniu strategii i rynku do tego profilu.",
    en: "Investment data will be available when this profile has a strategy and market binding.",
  },
  invalidPlan: {
    pl: "Podaj dodatnią kwotę i poprawną datę.",
    en: "Enter a positive amount and a valid date.",
  },
  planRefused: {
    pl: "Nie udało się zaplanować wpłaty.",
    en: "The contribution could not be planned.",
  },
  hide: { pl: "Ukryj", en: "Hide" },
  continueSetup: { pl: "Kontynuuj konfigurację", en: "Continue setup" },
  stepsDone: {
    pl: (done: number, total: number) => `${done} z ${total} kroków`,
    en: (done: number, total: number) => `${done} of ${total} steps`,
  },
  nextStep: {
    pl: (step: string) => `Następny krok: ${step}`,
    en: (step: string) => `Next step: ${step}`,
  },
  waitsForData: { pl: "Konfiguracja czeka na dane.", en: "Setup is waiting for data." },
});
