// Texts of the macro regimes (src/modules/investments/v2/research/macro.ts). See src/i18n.ts.
import { catalog } from "../../../../i18n.ts";

/** Regime labels and short subjects (the backend's INV/macro/regimes.py renders the same labels). */
export const MACRO_TEXT = catalog({
  riskLabel: { pl: "Rynek akcji", en: "Stock market" },
  riskSubject: { pl: "akcje", en: "stocks" },
  dollarLabel: { pl: "Dolar", en: "Dollar" },
  dollarSubject: { pl: "dolar", en: "dollar" },
  emLabel: { pl: "Rynki wschodzące", en: "Emerging markets" },
  emSubject: { pl: "EM", en: "EM" },
  commoditiesLabel: { pl: "Surowce", en: "Commodities" },
  commoditiesSubject: { pl: "surowce", en: "commodities" },
  ratesLabel: { pl: "Obligacje i stopy", en: "Bonds and rates" },
  ratesSubject: { pl: "stopy", en: "rates" },
});

/** Label per machine state (the backend's `state_label` words, kept in sync with regimes.py). */
const noData = { pl: "brak danych", en: "no data" };
const noTrend = { pl: "bez trendu", en: "no trend" };
export const RISK_STATE = catalog({
  bull: { pl: "hossa", en: "bull market" },
  bear: { pl: "bessa", en: "bear market" },
  correction: { pl: "korekta", en: "correction" },
  weak: { pl: "słabość", en: "weakness" },
  flat: noTrend,
  unknown: noData,
});
export const DOLLAR_STATE = catalog({
  strong: { pl: "umacnia się", en: "strengthening" },
  weak: { pl: "słabnie", en: "weakening" },
  flat: noTrend,
  unknown: noData,
});
export const EM_STATE = catalog({
  leading: { pl: "silniejsze od świata", en: "stronger than the world" },
  lagging: { pl: "słabsze od świata", en: "weaker than the world" },
  inline: { pl: "w linii", en: "in line" },
  unknown: noData,
});
export const COMMODITIES_STATE = catalog({
  bull: { pl: "hossa surowcowa", en: "commodity bull market" },
  bear: { pl: "bessa surowcowa", en: "commodity bear market" },
  flat: noTrend,
  unknown: noData,
});
export const RATES_STATE = catalog({
  rising: { pl: "rentowności rosną", en: "yields rising" },
  falling: { pl: "rentowności spadają", en: "yields falling" },
  stable: { pl: "rentowności stabilne", en: "yields stable" },
  unknown: noData,
});

export const S = catalog({
  /** The inversion modifier of the rates state label (the backend appends the same words). */
  inverted: { pl: "krzywa odwrócona", en: "inverted curve" },
  macroPrefix: { pl: (label: string) => `Makro · ${label}`, en: (label: string) => `Macro · ${label}` },
  overYears: { pl: (n: number) => `ponad ${n} lat`, en: (n: number) => `over ${n} years` },
  overYear: { pl: "ponad roku", en: "over a year" },
  overMonths: { pl: (n: number) => `ponad ${n} mies.`, en: (n: number) => `over ${n} months` },
  overMonth: { pl: "ponad miesiąca", en: "over a month" },
  since: { pl: (what: string) => `od ${what}`, en: (what: string) => `since ${what}` },
  before: { pl: (d: string) => `przed ${d}`, en: (d: string) => `before ${d}` },
  dataFrom: { pl: (d: string) => `dane z ${d}`, en: (d: string) => `data from ${d}` },
  outdated: { pl: "nieaktualne", en: "outdated" },
  noData: { pl: "Brak danych.", en: "No data." },
});
