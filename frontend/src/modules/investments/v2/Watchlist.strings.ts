// Texts of the watchlist (Watchlist.tsx). See src/i18n.ts.
import { catalog, enCount, enForm, plCount, plForm } from "../../../i18n.ts";

/** The alert kind as a short word before the level ("poniżej 560,00 $"). */
export const KIND_WORD = catalog({
  price_below: { pl: "poniżej", en: "below" },
  price_above: { pl: "powyżej", en: "above" },
  sma_cross: { pl: "SMA", en: "SMA" },
  new_high: { pl: "nowy szczyt", en: "new high" },
  drawdown_from_high: { pl: "spadek od szczytu", en: "drawdown from high" },
  range_breakout: { pl: "wybicie", en: "breakout" },
  volume_spike: { pl: "wolumen", en: "volume" },
});

export const S = catalog({
  removed: { pl: (label: string) => `Usunięto ${label} z obserwowanych`, en: (label: string) => `Removed ${label} from the watchlist` },
  removeWhat: { pl: "usunięcie z obserwowanych", en: "removal from the watchlist" },
  backAsYours: { pl: "wraca jako Twoja pozycja", en: "comes back as your item" },
  removeFailed: { pl: (err: string) => `Nie usunięto: ${err}`, en: (err: string) => `Not removed: ${err}` },
  alerts: {
    pl: (n: number) => plCount(n, "alert", "alerty", "alertów"),
    en: (n: number) => enCount(n, "alert", "alerts"),
  },
  alertsWord: { pl: (n: number) => plForm(n, "alert", "alerty", "alerty"), en: (n: number) => enForm(n, "alert", "alerts") },
  noAlert: { pl: "bez alertu", en: "no alert" },
  unwatch: { pl: "Przestań obserwować", en: "Stop watching" },
  unwatchAria: { pl: (label: string) => `Przestań obserwować ${label}`, en: (label: string) => `Stop watching ${label}` },
  empty: { pl: "Brak obserwowanych.", en: "Nothing on the watchlist." },
  colRecommendation: { pl: "Rekomendacja", en: "Recommendation" },
  col30d: { pl: "30 dni", en: "30 days" },
  colPrice: { pl: "Cena", en: "Price" },
  colWeek: { pl: "tydz.", en: "wk" },
  colAlerts: { pl: "Alerty", en: "Alerts" },
  colActions: { pl: "Akcje", en: "Actions" },
  recommendationAria: { pl: (r: string) => `Rekomendacja: ${r}`, en: (r: string) => `Recommendation: ${r}` },
  none: { pl: "brak", en: "none" },
  spark30d: { pl: (label: string) => `${label}: 30 dni`, en: (label: string) => `${label}: 30 days` },
  noPrice: { pl: "brak ceny", en: "no price" },
  stale: { pl: "stara", en: "stale" },
  oneSessionTitle: { pl: "zmiana z 1 sesji", en: "1-session change" },
  oneDay: { pl: "1 d.", en: "1d" },
  title: { pl: "Obserwowane", en: "Watchlist" },
  add: { pl: "+ Dodaj", en: "+ Add" },
});
