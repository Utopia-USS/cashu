// The Investments tab's Strategy view: the strategy document as written on the Mac (read only) and what
// watches it (the rules and the alerts). PL + EN (glossary: Strategia = Strategy, Reguła = Rule).
import { catalog, enCount, plCount } from "@cashu/i18n";

export const S = catalog({
  active: { pl: "aktywna", en: "active" },
  updated: {
    pl: (date: string) => `zaktualizowana ${date}`,
    en: (date: string) => `updated ${date}`,
  },
  noStrategyYet: { pl: "Jeszcze nie masz strategii", en: "No strategy yet" },
  writeOnMac: {
    pl: "Strategię piszesz na Macu z agentem; tutaj pojawi się do czytania.",
    en: "You write the strategy on your Mac with the agent; it shows up here to read.",
  },
  watches: { pl: "Co jej pilnuje", en: "What watches it" },
  rulesAndAlerts: {
    pl: (rules: number, alerts: number) =>
      `${plCount(rules, "reguła", "reguły", "reguł")} · ${plCount(alerts, "alert", "alerty", "alertów")}`,
    en: (rules: number, alerts: number) =>
      `${enCount(rules, "rule", "rules")} · ${enCount(alerts, "alert", "alerts")}`,
  },
  ok: { pl: "ok", en: "ok" },
  fired: { pl: "zadziałała", en: "fired" },
  noRules: { pl: "Strategia nie ma jeszcze reguł", en: "The strategy has no rules yet" },
  // A rule in words, from its kind and its parameters.
  ruleBands: { pl: "Koszyki w granicach pasm", en: "Buckets within their bands" },
  ruleConcentration: {
    pl: (pct: string) => `Jedna pozycja najwyżej ${pct}`,
    en: (pct: string) => `One position at most ${pct}`,
  },
  ruleCashMax: {
    pl: (pct: string) => `Gotówka najwyżej ${pct}`,
    en: (pct: string) => `Cash at most ${pct}`,
  },
  ruleCashMin: {
    pl: (pct: string) => `Gotówka co najmniej ${pct}`,
    en: (pct: string) => `Cash at least ${pct}`,
  },
  ruleDrawdown: {
    pl: (pct: string) => `Spadek od szczytu ponad ${pct}`,
    en: (pct: string) => `Fall from the high above ${pct}`,
  },
  ruleLoss: {
    pl: (pct: string) => `Strata od kosztu ponad ${pct}`,
    en: (pct: string) => `Loss from cost above ${pct}`,
  },
  ruleGain: {
    pl: (pct: string) => `Zysk od kosztu ponad ${pct}`,
    en: (pct: string) => `Gain from cost above ${pct}`,
  },
  ruleDeposit: {
    pl: (days: number) => `Wpłata co najmniej co ${days} dni`,
    en: (days: number) => `A deposit at least every ${days} days`,
  },
  ruleCustom: { pl: "Twoja własna reguła", en: "Your own rule" },
  ruleOther: { pl: "Reguła strategii", en: "A strategy rule" },
  readOnlyHere: {
    pl: "Tutaj tylko do czytania. Zmiany wprowadzasz na Macu, gdzie zatwierdzasz je, zanim zaczną działać.",
    en: "Read only here. Changes are made on your Mac, where you approve them before they apply.",
  },
});
