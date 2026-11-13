// How a signal of the strategy's rules, of an alert, of research or of a plan check reads on the phone,
// built from the signal's own facts (PL + EN). Kinds without a sentence here keep the engine's text.
import { catalog, enCount, plCount, plForm } from "@cashu/i18n";

/** "1st", "2nd", "10th", "21st" (the plan's day of the month in English). */
function enOrdinal(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  const unit = n % 10;
  return `${n}${unit === 1 ? "st" : unit === 2 ? "nd" : unit === 3 ? "rd" : "th"}`;
}

/** The plan sentence: "Plan zakłada wpłatę 2500 zł do 10. dnia każdego miesiąca." */
const plPlan = (amount: string, day: number | null) =>
  day === null
    ? `Plan zakłada wpłatę ${amount} co miesiąc.`
    : `Plan zakłada wpłatę ${amount} do ${day}. dnia każdego miesiąca.`;

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
  // A bucket is named by its generic label or the neutral word "Koszyk" / "Bucket" (never its id).
  driftOver: {
    pl: (bucket: string, weight: string, target: string, amount: string) =>
      `${bucket}: ${weight} portfela przy celu ${target} (${amount} ponad cel)`,
    en: (bucket: string, weight: string, target: string, amount: string) =>
      `${bucket}: ${weight} of the portfolio against a ${target} target (${amount} over)`,
  },
  driftUnder: {
    pl: (bucket: string, weight: string, target: string, amount: string) =>
      `${bucket}: ${weight} portfela przy celu ${target} (do celu brakuje ${amount})`,
    en: (bucket: string, weight: string, target: string, amount: string) =>
      `${bucket}: ${weight} of the portfolio against a ${target} target (${amount} short)`,
  },
  weightAbove: {
    pl: (name: string, weight: string, threshold: string) =>
      `${name}: ${weight} portfela, powyżej progu ${threshold}`,
    en: (name: string, weight: string, threshold: string) =>
      `${name} is ${weight} of the portfolio, above your ${threshold} threshold`,
  },
  weightBelow: {
    pl: (name: string, weight: string, threshold: string) =>
      `${name}: ${weight} portfela, poniżej progu ${threshold}`,
    en: (name: string, weight: string, threshold: string) =>
      `${name} is ${weight} of the portfolio, below your ${threshold} threshold`,
  },
  bucketWeightAbove: {
    pl: (bucket: string, weight: string, threshold: string) =>
      `${bucket}: ${weight} portfela, powyżej progu ${threshold}`,
    en: (bucket: string, weight: string, threshold: string) =>
      `${bucket}: ${weight} of the portfolio, above your ${threshold} threshold`,
  },
  bucketWeightBelow: {
    pl: (bucket: string, weight: string, threshold: string) =>
      `${bucket}: ${weight} portfela, poniżej progu ${threshold}`,
    en: (bucket: string, weight: string, threshold: string) =>
      `${bucket}: ${weight} of the portfolio, below your ${threshold} threshold`,
  },
  // The contribution plan: the monthly amount in the base currency, by a day of the month (or none).
  contributionGap: {
    pl: (days: number, last: string, amount: string, day: number | null) =>
      `Brak wpłaty od ${plCount(days, "dnia", "dni", "dni")} (ostatnia ${last}). ${plPlan(amount, day)}`,
    en: (days: number, last: string, amount: string, day: number | null) =>
      `No contribution for ${enCount(days, "day", "days")} (last ${last}). Your plan expects ${amount} a month${day === null ? "" : ` by the ${enOrdinal(day)}`}.`,
  },
  noContributions: {
    pl: (amount: string, day: number | null) =>
      `Nie ma jeszcze żadnej wpłaty. ${plPlan(amount, day)}`,
    en: (amount: string, day: number | null) =>
      `No contributions yet. Your plan expects ${amount} a month${day === null ? "" : ` by the ${enOrdinal(day)}`}.`,
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
  taggedWeight: {
    pl: (tags: readonly string[], weight: string, limit: string, labels: string) =>
      `Pozycje z ${plForm(tags.length, "tagiem", "tagami", "tagami")} ${tags.join(", ")} to ${weight} portfela (Twój limit: ${limit}): ${labels}`,
    en: (tags: readonly string[], weight: string, limit: string, labels: string) =>
      `Positions tagged ${tags.join(", ")} are ${weight} of the portfolio (your limit ${limit}): ${labels}`,
  },
  newHigh: {
    pl: (name: string, days: number, close: string, previous: string) =>
      `${name}: najwyższe zamknięcie od ${days} sesji, ${close} (poprzedni szczyt ${previous})`,
    en: (name: string, days: number, close: string, previous: string) =>
      `${name} set a new ${days}-session high at ${close} (previous ${previous})`,
  },
  smaAbove: {
    pl: (name: string, days: number, close: string, sma: string) =>
      `${name}: zamknięcie powyżej średniej z ${days} sesji (${close} wobec ${sma})`,
    en: (name: string, days: number, close: string, sma: string) =>
      `${name} closed above its ${days}-session average (${close} vs ${sma})`,
  },
  smaBelow: {
    pl: (name: string, days: number, close: string, sma: string) =>
      `${name}: zamknięcie poniżej średniej z ${days} sesji (${close} wobec ${sma})`,
    en: (name: string, days: number, close: string, sma: string) =>
      `${name} closed below its ${days}-session average (${close} vs ${sma})`,
  },
  breakoutUp: {
    pl: (name: string, days: number, pct: string, edge: string) =>
      `${name}: wybicie z konsolidacji ${days} sesji, ${pct} powyżej ${edge}`,
    en: (name: string, days: number, pct: string, edge: string) =>
      `${name} broke out of its ${days}-session range, ${pct} above ${edge}`,
  },
  breakoutDown: {
    pl: (name: string, days: number, pct: string, edge: string) =>
      `${name}: wybicie z konsolidacji ${days} sesji, ${pct} poniżej ${edge}`,
    en: (name: string, days: number, pct: string, edge: string) =>
      `${name} broke out of its ${days}-session range, ${pct} below ${edge}`,
  },
  volumeSpike: {
    pl: (name: string, ratio: string, days: number) =>
      `${name}: wolumen ${ratio}x średniej z ${days} sesji`,
    en: (name: string, ratio: string, days: number) =>
      `${name} traded ${ratio}x its ${days}-session average volume`,
  },
  // A custom rule or alert: the owner's own condition (an expression, shown as written) and its measures.
  // `conditionMet` also matches the engine's default text (domain rules/kinds/evaluate.strings.ts), which
  // tells a rule without the owner's own message.
  conditionMet: { pl: "Warunek spełniony", en: "Condition met" },
  custom: {
    pl: (who: string, when: string | null, values: string) =>
      `${who === "" ? "Warunek spełniony" : `${who}: warunek spełniony`}${when === null ? "" : ` (${when})`}${values === "" ? "" : `, ${values}`}`,
    en: (who: string, when: string | null, values: string) =>
      `${who === "" ? "Condition met" : `${who}: condition met`}${when === null ? "" : ` (${when})`}${values === "" ? "" : `, ${values}`}`,
  },
  unknown: { pl: "brak danych", en: "unknown" },
  yes: { pl: "tak", en: "yes" },
  no: { pl: "nie", en: "no" },
  // Research: a note's relation to the thesis in the shared words (ui-logic `RELATION_LABEL`).
  research: {
    pl: (title: string, relation: string | null, strength: number, sources: number) =>
      `Analiza: ${title}${relation === null ? "" : ` - ${relation}`} (siła ${strength}/3, ${plCount(sources, "źródło", "źródła", "źródeł")})`,
    en: (title: string, relation: string | null, strength: number, sources: number) =>
      `Analysis: ${title}${relation === null ? "" : ` - ${relation}`} (strength ${strength}/3, ${enCount(sources, "source", "sources")})`,
  },
  // Plan checks.
  noExitFulfilled: {
    pl: (name: string) => `${name}: teza spełniona, brak planu wyjścia`,
    en: (name: string) => `${name}: the thesis is fulfilled and there is no exit plan`,
  },
  noExitUp: {
    pl: (name: string, pct: string) => `${name}: brak planu wyjścia przy zysku ${pct}`,
    en: (name: string, pct: string) => `${name}: no exit plan while the position is ${pct} up`,
  },
  planWeakened: {
    pl: (name: string, plan: string) => `${name}: plan „${plan}”, a teza jest osłabiona`,
    en: (name: string, plan: string) =>
      `${name}: the plan says "${plan}", but the thesis is weakened`,
  },
  planInvalidated: {
    pl: (name: string, plan: string) => `${name}: plan „${plan}”, a teza jest podważona`,
    en: (name: string, plan: string) =>
      `${name}: the plan says "${plan}", but the thesis is invalidated`,
  },
});
