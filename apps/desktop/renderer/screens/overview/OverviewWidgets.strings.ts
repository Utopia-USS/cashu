import { catalog } from "@cashu/i18n";

export const W = catalog({
  invalidCash: {
    pl: "Podaj dodatnią kwotę i tytuł.",
    en: "Enter a positive amount and a title.",
  },
  cashRefused: {
    pl: "Nie udało się zmienić portfela gotówkowego.",
    en: "The cash wallet could not be changed.",
  },
  /** `cash_currency_mismatch`: the wallet of this currency holds another one (malformed data). */
  cashCurrencyMismatch: {
    pl: "Portfel gotówkowy jest prowadzony w innej walucie, więc wydatku nie zapisano.",
    en: "The cash wallet is kept in another currency, so the expense was not saved.",
  },
  invalidAsset: { pl: "Sprawdź nazwę, kwotę i datę.", en: "Check the name, amount and date." },
  assetRefused: {
    pl: "Nie udało się zmienić pozycji majątku.",
    en: "The asset could not be changed.",
  },
  investmentUnavailable: {
    pl: "Dane inwestycji pojawią się, gdy ten profil będzie miał strategię i źródło notowań.",
    en: "Investment data will be available when this profile has a strategy and market binding.",
  },
  benchmark: { pl: "Benchmark", en: "Benchmark" },
});
