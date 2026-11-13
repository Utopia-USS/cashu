// How a signal of the strategy's rules or of an alert reads on the phone, built from the signal's own
// facts (PL + EN). Kinds without a sentence here keep the engine's text.
import { catalog, enCount, plCount } from "@cashu/i18n";

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
  drawdown: {
    pl: (name: string, pct: string, days: number, high: string, now: string) =>
      `${name}: ${pct} poniżej szczytu z ${days} sesji (${high} → ${now})`,
    en: (name: string, pct: string, days: number, high: string, now: string) =>
      `${name} is ${pct} below its ${days}-session high (${high} → ${now})`,
  },
  priceAbove: {
    pl: (name: string, level: string, now: string) =>
      `${name}: kurs powyżej ${level} (teraz ${now})`,
    en: (name: string, level: string, now: string) => `${name} is above ${level} (now ${now})`,
  },
  priceBelow: {
    pl: (name: string, level: string, now: string) =>
      `${name}: kurs poniżej ${level} (teraz ${now})`,
    en: (name: string, level: string, now: string) => `${name} is below ${level} (now ${now})`,
  },
  lossFromCost: {
    pl: (name: string, pct: string, cost: string, value: string) =>
      `${name}: strata ${pct} względem kosztu zakupu (${cost} → ${value})`,
    en: (name: string, pct: string, cost: string, value: string) =>
      `${name} is down ${pct} from cost (${cost} → ${value})`,
  },
  gainFromCost: {
    pl: (name: string, pct: string, cost: string, value: string) =>
      `${name}: zysk ${pct} względem kosztu zakupu (${cost} → ${value})`,
    en: (name: string, pct: string, cost: string, value: string) =>
      `${name} is up ${pct} on cost (${cost} → ${value})`,
  },
  bucket: {
    pl: (id: string) => `Koszyk ${id}`,
    en: (id: string) => `Bucket ${id}`,
  },
  driftOver: {
    pl: (name: string, weight: string, target: string, amount: string) =>
      `${name}: ${weight} portfela przy celu ${target} (${amount} ponad cel)`,
    en: (name: string, weight: string, target: string, amount: string) =>
      `${name} is ${weight} of the portfolio against a ${target} target (${amount} over)`,
  },
  driftUnder: {
    pl: (name: string, weight: string, target: string, amount: string) =>
      `${name}: ${weight} portfela przy celu ${target} (do celu brakuje ${amount})`,
    en: (name: string, weight: string, target: string, amount: string) =>
      `${name} is ${weight} of the portfolio against a ${target} target (${amount} short)`,
  },
  weightAbove: {
    pl: (name: string, weight: string, threshold: string) =>
      `${name}: ${weight} portfela, powyżej progu ${threshold}`,
    en: (name: string, weight: string, threshold: string) =>
      `${name} is ${weight} of the portfolio, above your ${threshold} line`,
  },
  weightBelow: {
    pl: (name: string, weight: string, threshold: string) =>
      `${name}: ${weight} portfela, poniżej progu ${threshold}`,
    en: (name: string, weight: string, threshold: string) =>
      `${name} is ${weight} of the portfolio, below your ${threshold} line`,
  },
  contributionGap: {
    pl: (days: number, period: number) =>
      `Ostatnia wpłata: ${plCount(days, "dzień", "dni", "dni")} temu (plan: co ${plCount(period, "dzień", "dni", "dni")})`,
    en: (days: number, period: number) =>
      `Last deposit ${enCount(days, "day", "days")} ago (plan: every ${enCount(period, "day", "days")})`,
  },
  noDeposits: {
    pl: (period: number) => `Brak wpłat (plan: co ${plCount(period, "dzień", "dni", "dni")})`,
    en: (period: number) => `No deposits yet (plan: every ${enCount(period, "day", "days")})`,
  },
  cashBelow: {
    pl: (weight: string, cash: string, limit: string) =>
      `Gotówka: ${weight} portfela (${cash}), poniżej minimum ${limit}`,
    en: (weight: string, cash: string, limit: string) =>
      `Cash is ${weight} of the portfolio (${cash}), below your ${limit} minimum`,
  },
  cashAbove: {
    pl: (weight: string, cash: string, limit: string) =>
      `Gotówka: ${weight} portfela (${cash}), powyżej maksimum ${limit}`,
    en: (weight: string, cash: string, limit: string) =>
      `Cash is ${weight} of the portfolio (${cash}), above your ${limit} maximum`,
  },
});
