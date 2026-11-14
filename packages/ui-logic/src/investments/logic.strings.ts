// Texts of the investments workspace logic (packages/ui-logic/src/investments/logic.ts). See docs/agents/localization.md.
import { catalog, enCount, plCount } from "@cashu/i18n";

export const S = catalog({
  // decision tag
  decisionTag: {
    pl: (verb: string, q: string) => `decyzja: ${verb}${q}`,
    en: (verb: string, q: string) => `decision: ${verb}${q}`,
  },
  pieces: { pl: (q: string) => ` ${q} szt.`, en: (q: string) => ` ${q} units` },

  // decision effect
  effect: {
    pl: (
      head: string,
      bucket: string,
      after: string,
      target: string,
      grows: boolean,
      drift: string,
    ) =>
      `${head} · ${bucket} po transakcji: ${after} (cel ${target}, dryf ${grows ? "rośnie" : "maleje"} do ${drift})`,
    en: (
      head: string,
      bucket: string,
      after: string,
      target: string,
      grows: boolean,
      drift: string,
    ) =>
      `${head} · ${bucket} after the trade: ${after} (target ${target}, drift ${grows ? "grows" : "shrinks"} to ${drift})`,
  },

  // warnings
  account: { pl: "rachunek", en: "account" },
  instrumentN: { pl: (id: number) => `instrument ${id}`, en: (id: number) => `instrument ${id}` },
  instrument: { pl: "instrument", en: "instrument" },
  noSnapshot: {
    pl: (acc: string) => `${acc}: brak snapshotu brokera`,
    en: (acc: string) => `${acc}: no broker snapshot`,
  },
  snapshotOld: {
    pl: (acc: string, d: string) => `${acc}: brak snapshotu od ${d}`,
    en: (acc: string, d: string) => `${acc}: no snapshot since ${d}`,
  },
  noReconcile: { pl: "uzgodnienie niemożliwe", en: "can't reconcile" },
  stalePrice: { pl: "nieaktualna cena", en: "stale price" },
  lastTradePrice: { pl: "cena z ostatniej transakcji", en: "price from the last trade" },
  lastQuote: { pl: (d: string) => `ostatnie notowanie ${d}`, en: (d: string) => `last quote ${d}` },
  noQuotes: { pl: "brak notowań", en: "no quotes" },
  withTitle: {
    pl: (who: string, what: string) => `${who}: ${what}`,
    en: (who: string, what: string) => `${who}: ${what}`,
  },
  fxUnavailable: {
    pl: (c: string) => `Kurs NBP ${c} niedostępny`,
    en: (c: string) => `NBP rate ${c} unavailable`,
  },
  fxSkipped: {
    pl: "kwoty w tej walucie pominięte · odświeży się przy następnym uruchomieniu",
    en: "amounts in this currency skipped · refreshes on the next run",
  },
  fxRate: {
    pl: (c: string, stale: boolean) => `Kurs NBP ${c} ${stale ? "nieaktualny" : "niedostępny"}`,
    en: (c: string, stale: boolean) => `NBP rate ${c} ${stale ? "stale" : "unavailable"}`,
  },
  refreshesNextRun: {
    pl: "odświeży się przy następnym uruchomieniu",
    en: "refreshes on the next run",
  },
  checkAlias: {
    pl: "brak świeżego notowania · sprawdź alias Yahoo",
    en: "no fresh quote · check the Yahoo alias",
  },
  noPrice: { pl: "brak ceny", en: "no price" },
  positionSkipped: {
    pl: "pozycja niewliczona do udziałów",
    en: "position left out of the weights",
  },
  historyGap: {
    pl: (acc: string) => `Luka w historii ${acc}`,
    en: (acc: string) => `History gap in ${acc}`,
  },
  historyGapHint: {
    pl: (inst: string) =>
      `${inst}: sprzedano więcej, niż wynika z historii · uzgodnij ze snapshotem`,
    en: (inst: string) => `${inst}: more sold than the history holds · reconcile with a snapshot`,
  },
  negativeCash: {
    pl: (acc: string) => `${acc}: ujemna gotówka w historii`,
    en: (acc: string) => `${acc}: negative cash in the history`,
  },
  negativeCashHint: {
    pl: "brak wpłat w historii? liczona jako 0",
    en: "contributions missing from the history? counted as 0",
  },
  noManualValuation: { pl: "brak wyceny ręcznej", en: "no manual valuation" },
  valuedAtZero: { pl: "wyceniony na 0 do czasu wyceny", en: "valued at 0 until valued" },
  noInstrumentData: { pl: "brak danych instrumentu", en: "no instrument data" },
  substituteValuation: { pl: "wyceniony zastępczo", en: "valued with a fallback" },
  dataWarning: { pl: "Ostrzeżenie o danych", en: "Data warning" },
  noCostBasis: {
    pl: (n: number) => `Brak kosztu nabycia dla ${plCount(n, "lotu", "lotów", "lotów")}`,
    en: (n: number) => `No cost basis for ${enCount(n, "lot", "lots")}`,
  },
  noCostBasisHint: {
    pl: "wynik tych pozycji jest niepełny · uzupełnij cenę w transakcji",
    en: "the result of these positions is incomplete · add the price to the transaction",
  },

  // manual transaction form
  errType: { pl: "Wybierz typ transakcji.", en: "Choose a transaction type." },
  errDate: { pl: "Podaj datę.", en: "Enter a date." },
  errFutureDate: { pl: "Data nie może być z przyszłości.", en: "The date is in the future." },
  errInstrument: {
    pl: "Wybierz instrument albo wpisz symbol.",
    en: "Choose an instrument or type a symbol.",
  },
  errQtyPositive: {
    pl: "Liczba sztuk musi być większa od zera.",
    en: "Quantity must be greater than zero.",
  },
  errQtyNegative: { pl: "Liczba sztuk nie może być ujemna.", en: "Quantity can't be negative." },
  errPrice: { pl: "Podaj cenę za sztukę.", en: "Enter the price per unit." },
  errPriceNegative: { pl: "Cena nie może być ujemna.", en: "Price can't be negative." },
  errAmount: { pl: "Podaj kwotę (bez znaku).", en: "Enter the amount (no sign)." },
  errFee: { pl: "Prowizja nie może być ujemna.", en: "Fee can't be negative." },
  errSplit: { pl: "Podaj współczynnik splitu (1:4 = 4).", en: "Enter the split ratio (1:4 = 4)." },

  // band / run error
  ruleInactive: {
    pl: "reguła nieaktywna (błąd w strategy.yaml)",
    en: "rule inactive (error in strategy.yaml)",
  },
  priceSourceDown: {
    pl: "źródło cen lub kursów nie odpowiedziało",
    en: "the price or rate source didn't respond",
  },
  strategyProblem: { pl: "problem ze strategią", en: "strategy problem" },
});
