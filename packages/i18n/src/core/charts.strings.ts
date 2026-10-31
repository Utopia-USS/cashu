// Accessible texts of the SVG charts (frontend/src/charts.tsx). See docs/agents/localization.md.
import { catalog } from "../index.js";

export const S = catalog({
  chart: { pl: "wykres", en: "chart" },
  /** The name of an interactive chart: its label plus the keyboard hint. */
  interactive: {
    pl: (label?: string) =>
      label ? `${label} (strzałki: wartości)` : "Wykres (strzałki: wartości)",
    en: (label?: string) =>
      label ? `${label} (arrow keys: values)` : "Chart (arrow keys: values)",
  },
  none: { pl: "brak", en: "none" },
});
