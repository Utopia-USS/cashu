// How a signal of the strategy's rules or of an alert reads on the phone, built from the signal's own
// facts (PL + EN). Kinds without a sentence here keep the engine's text.
import { catalog, enCount } from "@cashu/i18n";

export const S = catalog({
  fell: {
    pl: (name: string, pct: string, days: number, from: string, to: string) =>
      `${name}: spadek o ${pct} w ciągu ${days} sesji (${from} → ${to})`,
    en: (name: string, pct: string, days: number, from: string, to: string) =>
      `${name} fell ${pct} in ${enCount(days, "session", "sessions")} (${from} → ${to})`,
  },
  rose: {
    pl: (name: string, pct: string, days: number, from: string, to: string) =>
      `${name}: wzrost o ${pct} w ciągu ${days} sesji (${from} → ${to})`,
    en: (name: string, pct: string, days: number, from: string, to: string) =>
      `${name} rose ${pct} in ${enCount(days, "session", "sessions")} (${from} → ${to})`,
  },
  concentration: {
    pl: (name: string, weight: string, limit: string) =>
      `${name} to ${weight} portfela (Twój limit: ${limit})`,
    en: (name: string, weight: string, limit: string) =>
      `${name} is ${weight} of the portfolio (your limit ${limit})`,
  },
});
