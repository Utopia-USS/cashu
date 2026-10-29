// Texts of the research widget in the asset detail (src/modules/investments/v2/research/AssetResearch.tsx). See src/i18n.ts.
import { catalog } from "../../../../i18n.ts";

export const S = catalog({
  research: { pl: "Research", en: "Research" },
  neverRan: { pl: "jeszcze nie działał", en: "hasn't run yet" },
  noNotes: { pl: "Brak notatek.", en: "No notes." },
  only30: { pl: "tylko 30 dni", en: "last 30 days only" },
  allN: { pl: (n: number) => `wszystkie (${n})`, en: (n: number) => `all (${n})` },
  sentiment8w: { pl: "Sentyment 8 tyg.", en: "Sentiment 8 wks" },
  noNotes30: { pl: "Brak notatek (30 dni)", en: "No notes (30 days)" },
  days30: { pl: "30 dni", en: "30 days" },
});
