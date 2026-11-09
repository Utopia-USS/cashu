// Texts of the Przegląd page (frontend/src/core/Overview.tsx). See docs/agents/localization.md.
import { catalog } from "../index.js";

export const S = catalog({
  modules: { pl: "Moduły", en: "Modules" },
  noModules: { pl: "Brak modułów.", en: "No modules." },
  enableModules: { pl: "Włącz moduły", en: "Turn on modules" },
  since: { pl: (month: string) => `od ${month}`, en: (month: string) => `since ${month}` },
  netWorth: { pl: "Wartość netto", en: "Net worth" },
  assets: { pl: "Aktywa", en: "Assets" },
  liabilities: { pl: "Zobowiązania", en: "Liabilities" },
  homeEquity: { pl: "Kapitał w nieruchomości", en: "Home equity" },
  homeEquityDetail: { pl: "nieruchomość - hipoteka", en: "property - mortgage" },
  liquid: { pl: "Płynne środki", en: "Liquid" },
  monthsOfSpending: {
    pl: (n: string) => `${n} mies. wydatków`,
    en: (n: string) => `${n} mo. of spending`,
  },
  accountsAndCash: { pl: "konta i gotówka", en: "accounts and cash" },
  otherCurrencies: {
    pl: (list: string) => `inne waluty: ${list}`,
    en: (list: string) => `other currencies: ${list}`,
  },
  netWorthConverted: {
    pl: (currency: string) => `Wartość netto, przeliczona na ${currency}`,
    en: (currency: string) => `Net worth, converted to ${currency}`,
  },
  convertedParts: {
    pl: (list: string) => `w tym ${list}`,
    en: (list: string) => `incl. ${list}`,
  },
  convertedTitle: {
    pl: (currency: string, day: string, missing: string | null) =>
      `Kwoty w innych walutach (obok, bez przeliczania) są przeliczone na ${currency} kursem średnim NBP z ${day} i wliczone w wartość netto, aktywa i płynne środki.${missing ? ` Bez kursu, więc poza sumą: ${missing}.` : ""}`,
    en: (currency: string, day: string, missing: string | null) =>
      `The amounts in other currencies (shown as they are) are converted to ${currency} at the NBP mid rate of ${day} and counted in net worth, assets and liquid money.${missing ? ` No rate, so left out: ${missing}.` : ""}`,
  },
  notConverted: {
    pl: "Wartość netto w innych walutach, każda osobno i bez przeliczania: konta bankowe i rachunki maklerskie w tej walucie.",
    en: "Net worth in other currencies, each on its own and not converted: the bank and brokerage accounts in that currency.",
  },
});
