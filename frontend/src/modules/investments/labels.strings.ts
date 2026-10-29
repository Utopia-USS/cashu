// Texts of the investments labels (src/modules/investments/labels.ts). See src/i18n.ts.
import { catalog, enCount, plCount } from "../../i18n.ts";

export const S = catalog({
  weekdayShort: {
    pl: ["nd", "pn", "wt", "śr", "czw", "pt", "sob"] as readonly string[],
    en: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
  },
  nTxns: {
    pl: (n: number) => plCount(n, "transakcja", "transakcje", "transakcji"),
    en: (n: number) => enCount(n, "transaction", "transactions"),
  },
  nTxnsAcc: {
    pl: (n: number) => plCount(n, "transakcję", "transakcje", "transakcji"),
    en: (n: number) => enCount(n, "transaction", "transactions"),
  },
  nInstruments: {
    pl: (n: number) => plCount(n, "instrument", "instrumenty", "instrumentów"),
    en: (n: number) => enCount(n, "instrument", "instruments"),
  },
  nAccountsInv: {
    pl: (n: number) => plCount(n, "rachunek", "rachunki", "rachunków"),
    en: (n: number) => enCount(n, "account", "accounts"),
  },
  nChanges: {
    pl: (n: number) => plCount(n, "zmiana", "zmiany", "zmian"),
    en: (n: number) => enCount(n, "change", "changes"),
  },
  nSignals: {
    pl: (n: number) => plCount(n, "sygnał", "sygnały", "sygnałów"),
    en: (n: number) => enCount(n, "signal", "signals"),
  },
  nBuckets: {
    pl: (n: number) => plCount(n, "koszyk", "koszyki", "koszyków"),
    en: (n: number) => enCount(n, "bucket", "buckets"),
  },
  nRules: {
    pl: (n: number) => plCount(n, "reguła", "reguły", "reguł"),
    en: (n: number) => enCount(n, "rule", "rules"),
  },
});

export const WEEKDAYS = catalog({
  monday: { pl: "poniedziałek", en: "Monday" },
  tuesday: { pl: "wtorek", en: "Tuesday" },
  wednesday: { pl: "środa", en: "Wednesday" },
  thursday: { pl: "czwartek", en: "Thursday" },
  friday: { pl: "piątek", en: "Friday" },
  saturday: { pl: "sobota", en: "Saturday" },
  sunday: { pl: "niedziela", en: "Sunday" },
});

export const TXN_TYPE = catalog({
  buy: { pl: "kupno", en: "buy" },
  sell: { pl: "sprzedaż", en: "sell" },
  dividend: { pl: "dywidenda", en: "dividend" },
  deposit: { pl: "wpłata", en: "deposit" },
  withdrawal: { pl: "wypłata", en: "withdrawal" },
  fee: { pl: "opłata", en: "fee" },
  tax: { pl: "podatek", en: "tax" },
  interest: { pl: "odsetki", en: "interest" },
  fx_conversion: { pl: "wymiana walut", en: "currency exchange" },
  split: { pl: "split", en: "split" },
  transfer_in: { pl: "przeniesienie na rachunek", en: "transfer in" },
  transfer_out: { pl: "przeniesienie z rachunku", en: "transfer out" },
  adjustment: { pl: "korekta stanu", en: "holdings adjustment" },
});

export const ASSET_CLASS = catalog({
  equity: { pl: "akcje", en: "stocks" },
  etf: { pl: "ETF", en: "ETF" },
  fund: { pl: "fundusz", en: "fund" },
  bond: { pl: "obligacje", en: "bonds" },
  treasury_bond: { pl: "obligacje skarbowe", en: "treasury bonds" },
  cash: { pl: "gotówka", en: "cash" },
  crypto: { pl: "kryptowaluty", en: "crypto" },
  commodity: { pl: "surowce", en: "commodities" },
  claim: { pl: "wierzytelność", en: "claim" },
  other: { pl: "inne", en: "other" },
});

export const REGION = catalog({
  global: { pl: "globalny", en: "global" },
  developed: { pl: "rynki rozwinięte", en: "developed markets" },
  emerging: { pl: "rynki wschodzące", en: "emerging markets" },
  pl: { pl: "Polska", en: "Poland" },
  us: { pl: "USA", en: "US" },
  europe: { pl: "Europa", en: "Europe" },
  asia: { pl: "Azja", en: "Asia" },
  unknown: { pl: "nieznany", en: "unknown" },
});

export const VALUATION = catalog({
  market: { pl: "rynek", en: "market" },
  cost: { pl: "koszt", en: "cost" },
  manual: { pl: "ręczna", en: "manual" },
});

export const WRAPPER = catalog({
  regular: { pl: "zwykłe", en: "regular" },
  ike: { pl: "IKE", en: "IKE" },
  ikze: { pl: "IKZE", en: "IKZE" },
  oipe: { pl: "OIPE", en: "OIPE" },
  other: { pl: "inne", en: "other" },
});

/** Generic strategy bucket ids -> label (see BUCKETS in labels.ts). */
export const BUCKETS = catalog({
  global_equity: { pl: "Akcje globalne", en: "Global equities" },
  bond_etfs: { pl: "ETF-y obligacyjne", en: "Bond ETFs" },
  treasury_bonds: { pl: "Obligacje skarbowe", en: "Treasury bonds" },
  cash: { pl: "Gotówka", en: "Cash" },
  stocks: { pl: "Akcje", en: "Equities" },
  equity: { pl: "Akcje", en: "Equities" },
  equities: { pl: "Akcje", en: "Equities" },
  bonds: { pl: "Obligacje", en: "Bonds" },
  fixed_income: { pl: "Obligacje", en: "Bonds" },
  crypto: { pl: "Kryptowaluty", en: "Crypto" },
  real_estate: { pl: "Nieruchomości", en: "Real estate" },
  reits: { pl: "Nieruchomości", en: "Real estate" },
  commodities: { pl: "Surowce", en: "Commodities" },
  gold: { pl: "Złoto", en: "Gold" },
});

/** Genitive of the generic bucket labels ("domyka 1,1 pp Akcji globalnych"); English has no case, so the
 * English entry is the label itself. Keyed by bucket id. */
export const BUCKET_GEN = catalog({
  global_equity: { pl: "Akcji globalnych", en: "Global equities" },
  bond_etfs: { pl: "ETF-ów obligacyjnych", en: "Bond ETFs" },
  treasury_bonds: { pl: "Obligacji skarbowych", en: "Treasury bonds" },
  cash: { pl: "Gotówki", en: "Cash" },
  stocks: { pl: "Akcji", en: "Equities" },
  equity: { pl: "Akcji", en: "Equities" },
  equities: { pl: "Akcji", en: "Equities" },
  bonds: { pl: "Obligacji", en: "Bonds" },
  fixed_income: { pl: "Obligacji", en: "Bonds" },
  crypto: { pl: "Kryptowalut", en: "Crypto" },
  real_estate: { pl: "Nieruchomości", en: "Real estate" },
  reits: { pl: "Nieruchomości", en: "Real estate" },
  commodities: { pl: "Surowców", en: "Commodities" },
  gold: { pl: "Złota", en: "Gold" },
});

export const DECISION_ACTION = catalog({
  bought: { pl: "dokupuję", en: "buying more" },
  sold: { pl: "sprzedaję", en: "selling" },
  held: { pl: "bez zmian", en: "no change" },
  ignored: { pl: "pomijam", en: "skipping" },
  other: { pl: "odkładam", en: "postponing" },
});

export const ENTRY_TYPE = catalog({
  sentiment_correction: { pl: "korekta sentymentu", en: "sentiment correction" },
  trend: { pl: "trend", en: "trend" },
  special_situation: { pl: "sytuacja specjalna", en: "special situation" },
});

export const RUN_STATUS = catalog({
  ok: { pl: "ok", en: "ok" },
  partial: { pl: "częściowy", en: "partial" },
  failed: { pl: "błąd", en: "error" },
  running: { pl: "w toku", en: "running" },
});
