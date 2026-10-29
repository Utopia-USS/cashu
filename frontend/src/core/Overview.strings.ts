// Texts of the Przegląd page (src/core/Overview.tsx). See src/i18n.ts.
import { catalog } from "../i18n.ts";

export const S = catalog({
  modules: { pl: "Moduły", en: "Modules" },
  noModules: { pl: "Brak modułów.", en: "No modules." },
  enableModules: { pl: "Włącz moduły", en: "Turn on modules" },
  since: { pl: (month: string) => `od ${month}`, en: (month: string) => `since ${month}` },
  netWorth: { pl: "Wartość netto", en: "Net worth" },
  assets: { pl: "Aktywa", en: "Assets" },
  liabilities: { pl: "Zobowiązania", en: "Liabilities" },
  homeEquity: { pl: "Home equity", en: "Home equity" },
  homeEquityDetail: { pl: "nieruchomość - hipoteka", en: "property - mortgage" },
  liquid: { pl: "Płynne", en: "Liquid" },
  monthsOfSpending: { pl: (n: string) => `${n} mies. wydatków`, en: (n: string) => `${n} mo. of spending` },
  accountsAndCash: { pl: "konta i gotówka", en: "accounts and cash" },
  otherCurrencies: { pl: (list: string) => `inne waluty: ${list}`, en: (list: string) => `other currencies: ${list}` },
  notConverted: { pl: "bez przeliczenia", en: "not converted" },
});
