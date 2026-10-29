// Texts of the instrument label (InstLabel.tsx). See src/i18n.ts.
import { catalog } from "../../../i18n.ts";

export const S = catalog({
  classifyTitle: { pl: "Sklasyfikuj · poza alokacją i regułami", en: "Classify · outside allocation and rules" },
  classifyAria: { pl: (name: string) => `Sklasyfikuj ${name}`, en: (name: string) => `Classify ${name}` },
});
