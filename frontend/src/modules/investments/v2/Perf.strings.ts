// Texts of the portfolio charts (src/modules/investments/v2/Perf.tsx). See src/i18n.ts.
import { catalog, enCount, plCount } from "../../../i18n.ts";

/** A performance range in words. */
export const RANGE_TEXT_L = catalog({
  "1m": { pl: "1 mies.", en: "1 month" },
  "3m": { pl: "3 mies.", en: "3 months" },
  ytd: { pl: "od początku roku", en: "year to date" },
  "1y": { pl: "12 mies.", en: "12 months" },
  "3y": { pl: "3 lata", en: "3 years" },
  max: { pl: "całość", en: "all time" },
});

/** Why the benchmark is missing, by the backend's status code. */
export const BENCH_NOTE_L = catalog({
  no_strategy: { pl: "benchmark: brak strategii", en: "benchmark: no strategy" },
  not_configured: { pl: "benchmark: ustaw benchmark.proxy w strategii", en: "benchmark: set benchmark.proxy in the strategy" },
  proxy_not_found: { pl: "benchmark: nie znaleziono instrumentu", en: "benchmark: instrument not found" },
  no_prices: { pl: "benchmark: brak notowań (cashu invest backfill)", en: "benchmark: no quotes (cashu invest backfill)" },
});

export const S = catalog({
  range1y: { pl: "1R", en: "1Y" },
  range3y: { pl: "3R", en: "3Y" },
  portfolio: { pl: "portfel", en: "portfolio" },
  difference: { pl: "różnica", en: "difference" },
  valueVsBench: { pl: "Wartość vs benchmark", en: "Value vs benchmark" },
  range: { pl: "Zakres", en: "Range" },
  benchmark: { pl: "benchmark", en: "benchmark" },
  contributionsIn: { pl: (r: string) => `wpłaty ${r}`, en: (r: string) => `contributions ${r}` },
  benchUnavailable: { pl: "benchmark niedostępny", en: "benchmark unavailable" },
  chart: { pl: "wykres", en: "chart" },
  table: { pl: "tabela", en: "table" },
  sameContributions: { pl: (name: string, c: string) => `${name} w ${c}, te same wpłaty`, en: (name: string, c: string) => `${name} in ${c}, same contributions` },
  noHistoryRun: { pl: "Brak historii: uruchom ", en: "No history: run " },
  tooLittleHistory: { pl: "Za mało historii.", en: "Not enough history." },
  thDate: { pl: "Data", en: "Date" },
  thPortfolio: { pl: "Portfel", en: "Portfolio" },
  thDifference: { pl: "Różnica", en: "Difference" },
  valueChartLabel: {
    pl: (bench: string | null, range: string) => `Wartość portfela${bench ? ` i ${bench} przy tych samych wpłatach` : ""}, ${range}`,
    en: (bench: string | null, range: string) => `Portfolio value${bench ? ` and ${bench} with the same contributions` : ""}, ${range}`,
  },
  portfolioEnd: { pl: (v: string) => `portfel ${v}`, en: (v: string) => `portfolio ${v}` },
  drawdownTitle: { pl: "Obsunięcie od szczytu", en: "Drawdown from the high" },
  months12: { pl: "12 mies.", en: "12 months" },
  noHistory: { pl: "Brak historii.", en: "No history." },
  now: { pl: "Teraz", en: "Now" },
  max: { pl: "Maks.", en: "Max" },
  recoveredIn: { pl: (n: number) => `odrobione w ${plCount(n, "dzień", "dni", "dni")}`, en: (n: number) => `recovered in ${enCount(n, "day", "days")}` },
  notRecovered: { pl: "jeszcze nieodrobione", en: "not recovered yet" },
  drawdownChartLabel: { pl: "Obsunięcie portfela od szczytu, 12 miesięcy", en: "Portfolio drawdown from the high, 12 months" },
  pctInt: { pl: (n: number) => `${n} %`, en: (n: number) => `${n}%` },
  contributions: { pl: "Wpłaty", en: "Contributions" },
  thisYear: { pl: "W tym roku", en: "This year" },
  plan: { pl: (v: string) => `plan ${v}`, en: (v: string) => `plan ${v}` },
  missed: {
    pl: (n: number) => ` · ${plCount(n, "miesiąc", "miesiące", "miesięcy")} bez wpłaty`,
    en: (n: number) => ` · ${enCount(n, "month", "months")} without a contribution`,
  },
  noPlan: { pl: "bez planu w strategii", en: "no plan in the strategy" },
  next: { pl: "Następna", en: "Next" },
  fromBudget: { pl: "z nadwyżki budżetu", en: "from the budget surplus" },
  byPlan: { pl: "wg planu", en: "per plan" },
  contributionsChartLabel: { pl: "Wpłaty w ostatnich 12 miesiącach", en: "Contributions over the last 12 months" },
  noContributions: { pl: "Brak wpłat.", en: "No contributions." },
});
