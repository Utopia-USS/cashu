// Texts of the asset header topic select (SegmentSelect.tsx). See docs/agents/localization.md.
import { catalog } from "../../index.js";

export const S = catalog({
  autoTitle: {
    pl: "auto: na podstawie symbolu lub klasy aktywów. Twój wybór ma pierwszeństwo.",
    en: "auto: from the symbol or asset class. A choice overrides it.",
  },
  setByClaude: { pl: "ustawił Claude", en: "set by Claude" },
  saveFailed: {
    pl: (err: string) => `Nie zapisano: ${err}`,
    en: (err: string) => `Not saved: ${err}`,
  },
  topic: { pl: "Temat", en: "Topic" },
  none: { pl: "brak", en: "none" },
  assetClasses: { pl: "Klasy aktywów", en: "Asset classes" },
  sectors: { pl: "Sektory", en: "Sectors" },
});
