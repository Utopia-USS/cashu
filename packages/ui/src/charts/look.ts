// The old chart look (ab24ab6 index.css 529-567 `.chart` `.tip` `.legend` `.spark`, 722-726 `.donut`) as
// Tailwind classes of the theme tokens, in one place for the web renderer, the legend and the swatch.
// Every class is a literal (Tailwind scans the source for them).
import type { ChartRole } from "./scene.js";

export const LOOK = {
  /** `.chart .ax` / `.chart .lbl`: 10.5px tabular figures (fill set per tone). */
  text: "text-3xs-plus tabular-nums",
  /** `.chart:focus-visible`: 2px accent outline, 4px offset, radius 4px. */
  focusRing:
    "rounded-2xs focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-focus",
  /** `.tip`: card, 1px border, radius 8px, padding 6px 9px, 11.5px / 1.45, shadow, above the chart marks. */
  tip: "pointer-events-none absolute z-5 whitespace-nowrap rounded-control border border-border bg-surface-raised px-2.25 py-1.5 text-2xs-plus leading-widget text-fg shadow-tip",
  /** `.tip b`: bold tabular value. */
  tipValue: "font-bold tabular-nums",
  /** `.donut .c`: the centre stack over the ring; the line height inherits (1.45 inside the old `.g3` grid). */
  center:
    "pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-center",
  /** `.donut .c b`: 15px bold, -0.01em, tabular. */
  centerTitle: "text-base font-bold tracking-snug tabular-nums text-fg",
  /** `.donut .c span`: 10.5px muted. */
  centerCaption: "text-3xs-plus text-fg-muted",
  /** `.legend`: wrapped row, 4px / 14px gaps, 11.5px muted. */
  legend: "flex flex-wrap items-center gap-x-3.5 gap-y-1 text-2xs-plus text-fg-muted",
} as const;

/** Background of a swatch / dot per colour role (`.arow .sw`, `.legend i.sw` take the bucket colour). */
export const BG: Record<ChartRole, string> = {
  series1: "bg-chart-1",
  series2: "bg-chart-2",
  series3: "bg-chart-3",
  series4: "bg-chart-4",
  series5: "bg-chart-5",
  series6: "bg-chart-6",
  series7: "bg-chart-7",
  series8: "bg-chart-8",
  grid: "bg-chart-grid",
  text: "bg-fg",
  muted: "bg-fg-muted",
  positive: "bg-positive",
  negative: "bg-negative",
  warning: "bg-warning",
  info: "bg-info",
  plan: "bg-chip",
  surface: "bg-surface-raised",
  accent: "bg-accent",
  bench: "bg-bench",
  "inv-global": "bg-inv-global",
  "inv-pl": "bg-inv-pl",
  "inv-bonds": "bg-inv-bonds",
  "inv-cash": "bg-inv-cash",
  "inv-other": "bg-inv-other",
  "inv-5": "bg-inv-5",
  "inv-6": "bg-inv-6",
  "inv-7": "bg-inv-7",
};

/** Border colour of a legend line mark per colour role (`.legend i.main` takes the series colour). */
export const BORDER: Record<ChartRole, string> = {
  series1: "border-chart-1",
  series2: "border-chart-2",
  series3: "border-chart-3",
  series4: "border-chart-4",
  series5: "border-chart-5",
  series6: "border-chart-6",
  series7: "border-chart-7",
  series8: "border-chart-8",
  grid: "border-chart-grid",
  text: "border-fg",
  muted: "border-fg-muted",
  positive: "border-positive",
  negative: "border-negative",
  warning: "border-warning",
  info: "border-info",
  plan: "border-chip",
  surface: "border-surface-raised",
  accent: "border-accent",
  bench: "border-bench",
  "inv-global": "border-inv-global",
  "inv-pl": "border-inv-pl",
  "inv-bonds": "border-inv-bonds",
  "inv-cash": "border-inv-cash",
  "inv-other": "border-inv-other",
  "inv-5": "border-inv-5",
  "inv-6": "border-inv-6",
  "inv-7": "border-inv-7",
};
