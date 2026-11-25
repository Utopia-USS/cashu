// Texts of the instrument label (InstLabel.tsx). See docs/agents/localization.md.
import { catalog } from "../../index.js";

export const S = catalog({
  classifyTitle: {
    pl: "Sklasyfikuj · poza alokacją i regułami",
    en: "Classify · outside allocation and rules",
  },
  classifyAria: {
    pl: (name: string) => `Sklasyfikuj ${name}`,
    en: (name: string) => `Classify ${name}`,
  },
});
