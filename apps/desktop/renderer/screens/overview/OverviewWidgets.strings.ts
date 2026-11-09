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
  invalidAsset: { pl: "Sprawdź nazwę, kwotę i datę.", en: "Check the name, amount and date." },
  assetRefused: {
    pl: "Nie udało się zmienić pozycji majątku.",
    en: "The asset could not be changed.",
  },
  investmentUnavailable: {
    pl: "Dane inwestycji będą dostępne po podłączeniu strategii i rynku do tego profilu.",
    en: "Investment data will be available when this profile has a strategy and market binding.",
  },
  benchmark: { pl: "Benchmark", en: "Benchmark" },
});
