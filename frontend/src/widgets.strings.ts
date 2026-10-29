// Texts of the v2 widget primitives (src/widgets.tsx). See src/i18n.ts.
import { catalog, enCount, plForm } from "./i18n.ts";

export const S = catalog({
  addedByAgent: { pl: "Dodane przez agenta", en: "Added by the agent" },
  alertMet: { pl: "spełniony", en: "met" },
  alertNear: { pl: "blisko", en: "near" },
  alertWaiting: { pl: "czeka", en: "waiting" },
  unreadNotes: {
    pl: (n: number) => (n === 1 ? "1 nowa notatka research" : `${n} ${plForm(n, "nowa notatka", "nowe notatki", "nowych notatek")} research`),
    en: (n: number) => enCount(n, "new research note", "new research notes"),
  },
});

export const POLARITY = catalog({
  positive: { pl: "szansa", en: "opportunity" },
  negative: { pl: "ryzyko", en: "risk" },
  neutral: { pl: "neutralny", en: "neutral" },
});

/** Alert status -> [label, css class]; the class is not translated. */
export const ALERT_STATUS = catalog({
  active: { pl: ["aktywny", "active"] as [string, string], en: ["active", "active"] },
  triggered: { pl: ["spełniony", "trig"] as [string, string], en: ["triggered", "trig"] },
  snoozed: { pl: ["uśpiony", "snz"] as [string, string], en: ["snoozed", "snz"] },
  muted: { pl: ["wyciszony", "mute"] as [string, string], en: ["muted", "mute"] },
  expired: { pl: ["wygasł", "mute"] as [string, string], en: ["expired", "mute"] },
});
