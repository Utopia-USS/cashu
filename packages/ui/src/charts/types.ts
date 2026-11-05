// Props of the chart components, shared by the web and native renderers (identical props on both platforms).
// Values are plain numbers already in one unit (one currency, or a percentage): a chart never sums currencies.
import type { Layout } from "../layout.js";
import type { ChartColor, ChartRole, SeriesColor } from "./scene.js";

/** What the numbers are. Amounts disappear in privacy mode (axis labels, value labels, tooltips, the
 * accessible summary); shares (percentages, counts) stay, like the legacy incognito mode. */
export type ValueKind = "amount" | "share";

/** Tooltip content for one data index; values come formatted by the caller. Drawn like the old `.tip`: the
 * title muted, each row "name <b>value</b>", a `muted` row (old `.k`, e.g. a difference) muted. */
export interface ChartTip {
  title: string;
  rows: { name: string; value: string; amount?: boolean; color?: ChartRole; muted?: boolean }[];
}

interface ChartBase {
  /** The accessible name (the chart's title); the component appends a summary of its values. */
  label: string;
  /** Fixed width in px; omit to fill the parent (measured). */
  width?: number;
  layout?: Layout;
}

export interface LineSeries {
  /** Exact, already localized low/latest/high text when values are geometry approximations.
   * Ignored for hidden amounts: the shared privacy summary replaces it. */
  accessibleSummary?: string;
  values: (number | null)[];
  /** main (series colour), bench (muted, dashed), negative (loss tone). Default main. */
  tone?: "main" | "bench" | "negative";
  /** Line colour (default: series 1 for main, muted for bench, negative for negative); the old value chart
   * passes "accent" for the portfolio and "bench" for the benchmark. The tone still sets dash and label. */
  color?: ChartColor;
  /** Fill a fading area under the line. */
  area?: boolean;
  /** Area baseline value (default: the bottom of the plot); 0 for a drawdown filled up to the zero line. */
  areaTo?: number;
  /** Label at the line's last point, stacked with the level labels on the right. */
  endLabel?: string;
  /** Name in the accessible summary (default: endLabel, else "series N"). */
  name?: string;
}

export interface Level {
  y: number;
  kind: "alert" | "rule" | "cost" | "agent";
  label?: string;
  muted?: boolean;
}

export interface LineChartProps extends ChartBase {
  series: LineSeries[];
  levels?: Level[];
  /** Date labels placed by data index. */
  xLabels?: { i: number; text: string }[];
  /** Y axis label formatter; `false` hides the axis labels (the left padding shrinks to 6). */
  yFormat?: ((v: number) => string) | false;
  valueKind?: ValueKind;
  yTicks?: number;
  ymin?: number;
  ymax?: number;
  height?: number;
  padL?: number;
  padR?: number;
  markers?: { i: number; kind: "buy" | "sell"; y?: number }[];
  /** Tooltip for a data index; makes the chart focusable (arrow keys, pointer, touch scrub). */
  tooltip?: (i: number) => ChartTip;
}

export interface AreaLayer {
  key: string;
  name: string;
  color: ChartColor;
  /** One value per point; liabilities are negative and stack downward. */
  values: number[];
}

export interface AreaChartProps extends ChartBase {
  layers: AreaLayer[];
  /** The total line (default: the sum of the layers at each point). */
  totals?: number[];
  /** Exact caller-provided summary when geometry uses approximate floating point values. */
  accessibleSummary?: string;
  xLabels?: { i: number; text: string }[];
  yFormat?: (v: number) => string;
  valueKind?: ValueKind;
  height?: number;
  padL?: number;
  padR?: number;
  tooltip?: (i: number) => ChartTip;
}

export interface BarChartProps extends ChartBase {
  /** Legacy single-series data. Must be empty in grouped mode. */
  values: number[];
  /** Grouped mode: labels defines the category count; every series and line must match it. */
  series?: { name: string; values: number[]; color: SeriesColor }[];
  line?: { name: string; values: number[]; color: SeriesColor };
  accessibleSummary?: string;
  tooltip?: (index: number) => ChartTip;
  /** Category label under each bar (month). */
  labels?: (string | null)[];
  /** A dashed plan line with its label on the left. */
  plan?: number | null;
  planLabel?: string;
  /** Per bar: main (default), plan (planned, not done: drawn at the plan height), muted. */
  kinds?: ("main" | "plan" | "muted" | null | undefined)[];
  /** Value label over each bar (formatted by the caller). */
  valueLabels?: (string | null)[];
  /** Formats a value for the accessible summary (default: a whole number in the UI locale). */
  format?: (v: number) => string;
  valueKind?: ValueKind;
  height?: number;
}

export interface DonutSegment {
  value: number;
  /** A series colour or a named token colour (allocation buckets: "inv-global", "inv-pl", ...). */
  color: ChartColor;
  name: string;
}

export interface DonutProps {
  label: string;
  /** Intent from an actual arc; omitted means a noninteractive chart. */
  onSegmentSelected?: (index: number) => void;
  segments: DonutSegment[];
  size?: number;
  /** Centre text (old `.donut .c`: 15px bold value, 10.5px muted caption); `amount` hides the value in
   * privacy mode. */
  center?: { title: string; caption?: string; amount?: boolean };
  layout?: Layout;
}

export interface SparklineProps {
  values: (number | null | undefined)[];
  /** Overrides the first-vs-last tone. */
  tone?: "positive" | "negative" | "muted";
  /** Accessible name; without it the sparkline is decorative (hidden from assistive tech). */
  label?: string;
  layout?: Layout;
}

/** The mark of a legend item, the old `.legend i` classes: a solid main line, the dashed benchmark, the
 * dashed level lines (alert / rule / agent), the dotted cost line, a colour swatch, a buy / sell dot. */
export type LegendMark =
  | "main"
  | "bench"
  | "alert"
  | "rule"
  | "agent"
  | "cost"
  | "swatch"
  | "buy"
  | "sell";

export interface LegendItem {
  label: string;
  mark: LegendMark;
  /** Colour of a main line (default accent) or a swatch (required for a swatch); other marks ignore it. */
  color?: ChartColor;
  /** The mark on its own line above the label: reproduces the old Home legend, where `.split .main
   * {display: grid}` (index.css:418) also hit the legend's `<i class="main">`. Hidden at <= 900 px like the
   * old `display: contents`. */
  stacked?: boolean;
}

export interface ChartLegendProps {
  items: LegendItem[];
  /** Layout only (margins, e.g. the value chart's 6 px gap above the plot: `mb-1.5`). */
  className?: string;
}

export interface SwatchProps {
  color: ChartColor;
  /** md: 10 px, radius 3 (old `.arow .sw`, allocation rows); sm: 9 px, radius 2 (old `.legend i.sw`). */
  size?: "sm" | "md";
}
