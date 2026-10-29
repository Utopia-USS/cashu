// Texts of the investments widgets on Przegląd and the minimal view (Overview.tsx). See src/i18n.ts.
import { catalog, enCount, intlLocale, plCount } from "../../../i18n.ts";

const MONTH_ADJ = ["styczniowa", "lutowa", "marcowa", "kwietniowa", "majowa", "czerwcowa", "lipcowa", "sierpniowa", "wrześniowa", "październikowa", "listopadowa", "grudniowa"];
const ROMAN = ["I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X", "XI", "XII"];
/** English month name of a 0-based month index. */
const enMonth = (i: number, month: "long" | "short") => new Intl.DateTimeFormat(intlLocale(), { month }).format(new Date(2000, i, 1));

export const S = catalog({
  // planned deposit actions
  planned: { pl: (amount: string, date: string) => `Zaplanowano wpłatę ${amount} · ${date}`, en: (amount: string, date: string) => `Contribution planned ${amount} · ${date}` },
  undonePlan: { pl: "Cofnięto: plan wpłaty", en: "Undone: contribution plan" },
  undoFailed: { pl: (err: string) => `Nie cofnięto: ${err}`, en: (err: string) => `Not undone: ${err}` },
  plansUnsupported: { pl: "Serwer nie obsługuje planów wpłat: zaktualizuj aplikację.", en: "The server does not support contribution plans: update the app." },
  planSaveFailed: { pl: (err: string) => `Nie zapisano planu: ${err}`, en: (err: string) => `Plan not saved: ${err}` },
  planChangeFailed: { pl: (err: string) => `Nie zmieniono planu: ${err}`, en: (err: string) => `Plan not changed: ${err}` },
  tagBooked: { pl: (amount: string) => `zaksięgowano ${amount}`, en: (amount: string) => `booked ${amount}` },
  tagPlanned: { pl: (amount: string, date: string) => `zaplanowano ${amount} · ${date}`, en: (amount: string, date: string) => `planned ${amount} · ${date}` },

  // hero fact, header tag
  investments: { pl: "Inwestycje", en: "Investments" },
  week: { pl: "tydz.", en: "wk" },
  chances: { pl: (n: number) => plCount(n, "szansa", "szanse", "szans"), en: (n: number) => enCount(n, "opportunity", "opportunities") },
  risks: { pl: (n: number) => plCount(n, "ryzyko", "ryzyka", "ryzyk"), en: (n: number) => enCount(n, "risk", "risks") },
  signalsCount: { pl: (n: number) => `${n} sygnałów`, en: (n: number) => enCount(n, "signal", "signals") },
  lastQuote: { pl: (date: string) => `ostatnie notowanie ${date}`, en: (date: string) => `last quote ${date}` },
  noQuotes: { pl: "brak notowań", en: "no quotes" },
  stalePrices: {
    pl: (n: number) => plCount(n, "nieaktualna cena", "nieaktualne ceny", "nieaktualnych cen"),
    en: (n: number) => enCount(n, "stale price", "stale prices"),
  },

  // summary widget
  today: { pl: "dziś", en: "today" },
  toDo: { pl: "do zrobienia", en: "to do" },
  months12: { pl: "12 mies.", en: "12 mo" },
  weeklyReview: { pl: "przegląd tygodnia:", en: "weekly review:" },
  rules: { pl: "reguły", en: "rules" },
  runOk: { pl: "ok", en: "ok" },
  runPartial: { pl: "częściowo", en: "partial" },
  runError: { pl: "błąd", en: "error" },
  rulesNeverRan: { pl: "reguły jeszcze nie działały", en: "rules have not run yet" },
  noBenchmark: { pl: "bez benchmarku", en: "no benchmark" },
  chancesLabel: { pl: "Szanse", en: "Opportunities" },
  risksLabel: { pl: "Ryzyka", en: "Risks" },
  alertsMet: {
    pl: (n: number) => plCount(n, "alert spełniony", "alerty spełnione", "alertów spełnionych"),
    en: (n: number) => enCount(n, "alert triggered", "alerts triggered"),
  },
  valueChart12m: { pl: "Wartość portfela, 12 miesięcy", en: "Portfolio value, 12 months" },

  // surplus widget
  surplusTitle: { pl: "Nadwyżka → wpłata", en: "Surplus → contribution" },
  noMonthClose: { pl: "Brak zamknięcia miesiąca.", en: "No month close." },
  monthClose: { pl: "zamknięcie miesiąca", en: "month close" },
  depositsOfYear: { pl: (year: string) => `wpłaty ${year}:`, en: (year: string) => `contributions ${year}:` },
  ofTotal: { pl: "z", en: "of" },
  planCovered: { pl: "plan pokryty", en: "plan covered" },
  missing: { pl: "brakuje", en: "missing" },
  bookedFromImport: { pl: "zaksięgowana z importu", en: "booked from an import" },
  toBookByImport: { pl: "do zaksięgowania importem", en: "to be booked by an import" },
  surplusOf: { pl: (i: number) => `Nadwyżka ${ROMAN[i]}`, en: (i: number) => `${enMonth(i, "short")} surplus` },
  forInvesting: { pl: (amount: string) => `na inwestycje ${amount} po poduszce`, en: (amount: string) => `${amount} to invest after the cushion` },
  depositPlan: { pl: "Plan wpłaty", en: "Contribution plan" },
  noPlanInStrategy: { pl: "brak planu w strategii", en: "no plan in the strategy" },
  byDay: { pl: (day: number) => `do ${day}. dnia`, en: (day: number) => `by day ${day}` },
  short: { pl: "Brakuje", en: "Short" },
  stays: { pl: "Zostaje", en: "Left over" },
  inAccount: { pl: "na koncie", en: "in the account" },
  cushion: { pl: "poduszka", en: "cushion" },
  cushionMonths: { pl: (n: number) => `${n} mies.`, en: (n: number) => `${n} mo` },
  cushionMissing: { pl: "poduszka: brakuje", en: "cushion: missing" },
  belowTarget: { pl: (bucket: string, pp: string) => `${bucket} poniżej celu: wpłata domyka ${pp}`, en: (bucket: string, pp: string) => `${bucket} below target: the contribution closes ${pp}` },
  planAmount: { pl: (amount: string) => `Zaplanuj ${amount}`, en: (amount: string) => `Plan ${amount}` },
  otherAmount: { pl: "Inna kwota", en: "Other amount" },
  amountAria: { pl: "Kwota wpłaty", en: "Contribution amount" },
  plan: { pl: "Zaplanuj", en: "Plan" },
  change: { pl: "zmień", en: "change" },

  // minimal view
  alerts: { pl: (n: number) => plCount(n, "alert", "alerty", "alertów"), en: (n: number) => enCount(n, "alert", "alerts") },
  noAlerts: { pl: "bez alertów", en: "no alerts" },
  signals: { pl: (n: number) => plCount(n, "sygnał", "sygnały", "sygnałów"), en: (n: number) => enCount(n, "signal", "signals") },
  noSignals: { pl: "bez sygnałów", en: "no signals" },
  portfolio: { pl: "Portfel", en: "Portfolio" },
  sinceFirstDeposit: { pl: "od pierwszej wpłaty", en: "since the first contribution" },
  deposited: { pl: "Wpłacono", en: "Contributed" },
  deposits: { pl: (n: number) => plCount(n, "wpłata", "wpłaty", "wpłat"), en: (n: number) => enCount(n, "contribution", "contributions") },
  depositsOf: {
    pl: (n: number, amount: string) => `${plCount(n, "wpłata", "wpłaty", "wpłat")} po ${amount}`,
    en: (n: number, amount: string) => `${enCount(n, "contribution", "contributions")} of ${amount}`,
  },
  setInStrategy: { pl: "ustaw w strategii", en: "set it in the strategy" },
  nextDeposit: { pl: "Następna wpłata", en: "Next contribution" },
  depositsTitle: { pl: "Wpłaty", en: "Contributions" },
  months6: { pl: "6 mies.", en: "6 mo" },
  planOf: { pl: (amount: string) => `plan ${amount}`, en: (amount: string) => `plan ${amount}` },
  byDayShort: { pl: (day: number) => ` · do ${day}.`, en: (day: number) => ` · by day ${day}` },
  regularity: { pl: "regularność", en: "regularity" },
  xOfY: { pl: (a: number, b: number) => `${a} z ${b}`, en: (a: number, b: number) => `${a} of ${b}` },
  depositsChart: { pl: "Wpłaty w ostatnich 6 miesiącach", en: "Contributions in the last 6 months" },
  thisMonth: { pl: "Na ten miesiąc", en: "This month" },
  addAlert: { pl: "dodaj alert", en: "add an alert" },
  watchInstrument: { pl: "obserwuj instrument", en: "watch an instrument" },
  done: { pl: "zrobione", en: "done" },
  step2: { pl: "krok 2", en: "step 2" },
  monthDeposit: { pl: (i: number) => `Wpłata ${MONTH_ADJ[i]}`, en: (i: number) => `${enMonth(i, "long")} contribution` },
  depositBy: { pl: (amount: string, date: string) => `Wpłata ${amount} do ${date}`, en: (amount: string, date: string) => `Contribution ${amount} by ${date}` },
  doneThisMonth: { pl: "zrobiona w tym miesiącu", en: "done this month" },
  plannedOn: { pl: (date: string) => `zaplanowana ${date}`, en: (date: string) => `planned ${date}` },
  perPlan: { pl: "wg planu", en: "as planned" },
  nothingMore: { pl: "Nic więcej", en: "Nothing more" },
  monthlyReviewEnough: { pl: "przegląd raz w miesiącu wystarczy", en: "a review once a month is enough" },
});
