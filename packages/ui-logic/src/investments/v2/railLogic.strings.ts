// Texts of the home rail's pure logic (packages/ui-logic/src/investments/v2/railLogic.ts). See docs/agents/localization.md.
import { catalog } from "@cashu/i18n";

/** The tag an alert shows when neither the owner nor the agent gave one, by its kind. */
export const DEFAULT_TAG = catalog({
  price: { pl: "cena", en: "price" },
  average: { pl: "średnia", en: "average" },
  volume: { pl: "wolumen", en: "volume" },
  breakout: { pl: "wybicie", en: "breakout" },
  weight: { pl: "udział", en: "weight" },
  custom: { pl: "własna", en: "custom" },
});

export const S = catalog({
  missing: { pl: (gap: string) => `brakuje ${gap}`, en: (gap: string) => `${gap} to go` },
  firedOn: { pl: (day: string) => `od ${day}`, en: (day: string) => `since ${day}` },
});
