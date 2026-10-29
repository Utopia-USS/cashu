// Texts of the investments workspace logic (src/modules/investments/logic.ts). See src/i18n.ts.
import { catalog, enCount, enForm, plCount } from "../../i18n.ts";

export const S = catalog({
  // signal titles by rule kind
  titleDrawdown: { pl: (t: string) => `Spadek od szczytu ≥ ${t}`, en: (t: string) => `Drop from peak ≥ ${t}` },
  titleDrift: { pl: (b: string) => `Dryf alokacji: ${b}`, en: (b: string) => `Allocation drift: ${b}` },
  titleDriftPlain: { pl: "Dryf alokacji", en: "Allocation drift" },
  titleConcentration: { pl: (i: string) => `Koncentracja: ${i}`, en: (i: string) => `Concentration: ${i}` },
  titleContributionGap: { pl: "Brak wpłaty", en: "Missed contribution" },
  titleLoss: { pl: (t: string) => `Strata od kosztu ≥ ${t}`, en: (t: string) => `Loss from cost ≥ ${t}` },
  titleGain: { pl: (t: string) => `Zysk od kosztu ≥ ${t}`, en: (t: string) => `Gain from cost ≥ ${t}` },
  titleCashHigh: { pl: "Za dużo gotówki", en: "Too much cash" },
  titleCashLow: { pl: "Za mało gotówki", en: "Too little cash" },
  titleTagged: { pl: (tags: string) => `Udział tagów: ${tags}`, en: (tags: string) => `Tag weight: ${tags}` },
  titleCustom: { pl: "Reguła własna", en: "Custom rule" },

  // signal facts
  threshold: { pl: (t: string) => `próg ${t}`, en: (t: string) => `threshold ${t}` },
  band: { pl: (b: string) => `pasmo ±${b}`, en: (b: string) => `band ±${b}` },
  aboveTarget: { pl: (m: string) => `≈ ${m} nad celem`, en: (m: string) => `≈ ${m} above target` },
  belowTarget: { pl: (m: string) => `≈ ${m} pod celem`, en: (m: string) => `≈ ${m} below target` },
  max: { pl: (v: string) => `maks ${v}`, en: (v: string) => `max ${v}` },
  min: { pl: (v: string) => `min ${v}`, en: (v: string) => `min ${v}` },
  lastDeposit: { pl: (d: string) => `ostatnia wpłata ${d}`, en: (d: string) => `last contribution ${d}` },
  noDeposits: { pl: "brak wpłat w historii", en: "no contributions in the history" },
  depositPlan: {
    pl: (day: number | null, grace: number) => `plan: co miesiąc${day ? ` do ${day}.` : ""} (+${grace} dni)`,
    en: (day: number | null, grace: number) => `plan: monthly${day ? ` by day ${day}` : ""} (+${grace} days)`,
  },

  // decision tag
  decisionTag: { pl: (verb: string, q: string) => `decyzja: ${verb}${q}`, en: (verb: string, q: string) => `decision: ${verb}${q}` },
  pieces: { pl: (q: string) => ` ${q} szt.`, en: (q: string) => ` ${q} units` },

  // decision effect
  effect: {
    pl: (head: string, bucket: string, after: string, target: string, grows: boolean, drift: string) =>
      `${head} · ${bucket} po transakcji: ${after} (cel ${target}, dryf ${grows ? "rośnie" : "maleje"} do ${drift})`,
    en: (head: string, bucket: string, after: string, target: string, grows: boolean, drift: string) =>
      `${head} · ${bucket} after the trade: ${after} (target ${target}, drift ${grows ? "grows" : "shrinks"} to ${drift})`,
  },

  // change rows
  rowValue: { pl: "Wartość", en: "Value" },
  noStartValuation: { pl: "brak wyceny z początku okresu", en: "no valuation from the start of the period" },
  rowImport: { pl: "Import", en: "Import" },
  toClassify: { pl: (n: string) => `do sklasyfikowania: ${n}`, en: (n: string) => `to classify: ${n}` },
  manualCount: { pl: (n: number) => `${n} ręcznie`, en: (n: number) => `${n} manual` },
  fromAccounts: { pl: (accs: string) => ` z ${accs}`, en: (accs: string) => ` from ${accs}` },
  nNew: { pl: (n: number) => plCount(n, "nowy", "nowe", "nowych"), en: (n: number) => `${n} new` },
  nEscalated: { pl: (n: number) => plCount(n, "eskalował", "eskalowały", "eskalowało"), en: (n: number) => `${n} escalated` },
  nResolved: { pl: (n: number) => plCount(n, "wygasł", "wygasły", "wygasło"), en: (n: number) => `${n} expired` },
  subNew: { pl: (names: string) => `nowe: ${names}`, en: (names: string) => `new: ${names}` },
  subEscalated: { pl: (names: string) => `eskalacja: ${names}`, en: (names: string) => `escalated: ${names}` },
  subResolved: { pl: (names: string) => `wygasłe: ${names}`, en: (names: string) => `expired: ${names}` },
  rowSignals: { pl: "Sygnały", en: "Signals" },
  rowDividends: { pl: "Dywidendy", en: "Dividends" },
  dividendsSub: { pl: "leży jako gotówka na rachunku", en: "held as cash in the account" },
  rowPrices: { pl: "Ceny", en: "Prices" },
  noFreshQuote: { pl: (n: string) => `${n} bez świeżego notowania`, en: (n: string) => `${n} without a fresh quote` },
  bigMoves: {
    pl: (n: number) => `${n} ${n === 1 ? "duży ruch" : "duże ruchy"} cen`,
    en: (n: number) => `${n} big price ${enForm(n, "move", "moves")}`,
  },
  biggestMoves: { pl: (m: string) => `największe ruchy: ${m}`, en: (m: string) => `biggest moves: ${m}` },
  movesInWarnings: { pl: "szczegóły w ostrzeżeniach danych", en: "details in the data warnings" },
  rowDecisions: { pl: "Decyzje", en: "Decisions" },
  nDecisions: { pl: (n: number) => plCount(n, "decyzja", "decyzje", "decyzji"), en: (n: number) => enCount(n, "decision", "decisions") },
  inJournal: { pl: "w dzienniku decyzji", en: "in the decision journal" },
  rowStrategy: { pl: "Strategia", en: "Strategy" },
  noStrategy: { pl: "brak strategii", en: "no strategy" },
  newVersion: { pl: (v: number) => `nowa wersja v${v}`, en: (v: number) => `new version v${v}` },
  unchanged: { pl: "bez zmian", en: "no changes" },
  strategyPending: { pl: "reguły i alokacja ruszą po zapisaniu strategy.yaml", en: "rules and allocation start once strategy.yaml is saved" },
  someRulesInactive: { pl: " · część reguł nieaktywna", en: " · some rules inactive" },
  fileErrors: { pl: " · błędy w pliku", en: " · errors in the file" },

  // warnings
  account: { pl: "rachunek", en: "account" },
  instrumentN: { pl: (id: number) => `instrument ${id}`, en: (id: number) => `instrument ${id}` },
  instrument: { pl: "instrument", en: "instrument" },
  noSnapshot: { pl: (acc: string) => `${acc}: brak snapshotu brokera`, en: (acc: string) => `${acc}: no broker snapshot` },
  snapshotOld: { pl: (acc: string, d: string) => `${acc}: brak snapshotu od ${d}`, en: (acc: string, d: string) => `${acc}: no snapshot since ${d}` },
  noReconcile: { pl: "uzgodnienie niemożliwe", en: "can't reconcile" },
  stalePrice: { pl: "nieaktualna cena", en: "stale price" },
  lastTradePrice: { pl: "cena z ostatniej transakcji", en: "price from the last trade" },
  lastQuote: { pl: (d: string) => `ostatnie notowanie ${d}`, en: (d: string) => `last quote ${d}` },
  noQuotes: { pl: "brak notowań", en: "no quotes" },
  withTitle: { pl: (who: string, what: string) => `${who}: ${what}`, en: (who: string, what: string) => `${who}: ${what}` },
  fxUnavailable: { pl: (c: string) => `Kurs NBP ${c} niedostępny`, en: (c: string) => `NBP rate ${c} unavailable` },
  fxSkipped: {
    pl: "kwoty w tej walucie pominięte · odświeży się przy następnym przebiegu",
    en: "amounts in this currency skipped · refreshes on the next run",
  },
  fxRate: {
    pl: (c: string, stale: boolean) => `Kurs NBP ${c} ${stale ? "nieaktualny" : "niedostępny"}`,
    en: (c: string, stale: boolean) => `NBP rate ${c} ${stale ? "stale" : "unavailable"}`,
  },
  refreshesNextRun: { pl: "odświeży się przy następnym przebiegu", en: "refreshes on the next run" },
  checkAlias: { pl: "brak świeżego notowania · sprawdź alias Yahoo", en: "no fresh quote · check the Yahoo alias" },
  noPrice: { pl: "brak ceny", en: "no price" },
  positionSkipped: { pl: "pozycja pominięta w udziałach", en: "position left out of the weights" },
  historyGap: { pl: (acc: string) => `Luka w historii ${acc}`, en: (acc: string) => `History gap in ${acc}` },
  historyGapHint: {
    pl: (inst: string) => `${inst}: sprzedano więcej, niż wynika z historii · uzgodnij ze snapshotem`,
    en: (inst: string) => `${inst}: more sold than the history holds · reconcile with a snapshot`,
  },
  negativeCash: { pl: (acc: string) => `${acc}: ujemna gotówka w historii`, en: (acc: string) => `${acc}: negative cash in the history` },
  negativeCashHint: { pl: "brak wpłat w historii? liczona jako 0", en: "contributions missing from the history? counted as 0" },
  noManualValuation: { pl: "brak wyceny ręcznej", en: "no manual valuation" },
  valuedAtZero: { pl: "wyceniony na 0 do czasu wyceny", en: "valued at 0 until valued" },
  noInstrumentData: { pl: "brak danych instrumentu", en: "no instrument data" },
  substituteValuation: { pl: "wyceniony zastępczo", en: "valued with a fallback" },
  dataWarning: { pl: "Ostrzeżenie danych", en: "Data warning" },
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
  errFutureDate: { pl: "Data z przyszłości.", en: "The date is in the future." },
  errInstrument: { pl: "Wybierz instrument albo wpisz symbol.", en: "Choose an instrument or type a symbol." },
  errQtyPositive: { pl: "Ilość musi być większa od zera.", en: "Quantity must be greater than zero." },
  errQtyNegative: { pl: "Ilość nie może być ujemna.", en: "Quantity can't be negative." },
  errPrice: { pl: "Podaj cenę za sztukę.", en: "Enter the price per unit." },
  errPriceNegative: { pl: "Cena nie może być ujemna.", en: "Price can't be negative." },
  errAmount: { pl: "Podaj kwotę (bez znaku).", en: "Enter the amount (no sign)." },
  errFee: { pl: "Prowizja nie może być ujemna.", en: "Fee can't be negative." },
  errSplit: { pl: "Podaj współczynnik splitu (1:4 = 4).", en: "Enter the split ratio (1:4 = 4)." },

  // import / band / run error
  commit: {
    pl: (rows: number, corrections: number) => {
      const t = plCount(rows, "transakcję", "transakcje", "transakcji");
      return corrections ? `Zaimportuj ${t} i ${plCount(corrections, "korektę", "korekty", "korekt")}` : `Zaimportuj ${t}`;
    },
    en: (rows: number, corrections: number) => {
      const t = enCount(rows, "transaction", "transactions");
      return corrections ? `Import ${t} and ${enCount(corrections, "adjustment", "adjustments")}` : `Import ${t}`;
    },
  },
  bandOut: {
    pl: (n: number) => `${plCount(n, "koszyk", "koszyki", "koszyków")} poza pasmem`,
    en: (n: number) => `${enCount(n, "bucket", "buckets")} out of band`,
  },
  allInBand: { pl: "wszystko w paśmie", en: "all within band" },
  ruleInactive: { pl: "reguła nieaktywna (błąd w strategy.yaml)", en: "rule inactive (error in strategy.yaml)" },
  priceSourceDown: { pl: "źródło cen lub kursów nie odpowiedziało", en: "the price or rate source didn't respond" },
  strategyProblem: { pl: "problem ze strategią", en: "strategy problem" },
});
