// Accessible texts of the SVG charts (packages/ui charts and the legacy frontend/src/charts.tsx). See
// docs/agents/localization.md.
import { catalog } from "@cashu/i18n";

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
  /** What a screen reader hears for an amount hidden by privacy mode. */
  hidden: { pl: "ukryte", en: "hidden" },
  noData: { pl: "brak danych", en: "no data" },
  /** A series without a name in the summary. */
  series: { pl: (n: number) => `seria ${n}`, en: (n: number) => `series ${n}` },
  total: { pl: "razem", en: "total" },
  plan: { pl: "plan", en: "plan" },
  /** One line of a chart summary: the last value and the range of a series. */
  seriesSummary: {
    pl: (name: string, last: string, min: string, max: string) =>
      `${name}: ostatnio ${last}, najniżej ${min}, najwyżej ${max}`,
    en: (name: string, last: string, min: string, max: string) =>
      `${name}: latest ${last}, low ${min}, high ${max}`,
  },
  /** The x range of a chart summary. */
  range: {
    pl: (from: string, to: string) => `od ${from} do ${to}`,
    en: (from: string, to: string) => `from ${from} to ${to}`,
  },
  /** Native: the hint of a chart scrubbed by swiping up / down (VoiceOver adjustable). */
  adjustHint: {
    pl: "Przesuń w górę lub w dół, aby przejść po wartościach",
    en: "Swipe up or down to step through the values",
  },
});
