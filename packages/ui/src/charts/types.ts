// Props of the chart components, shared by the web and native renderers (identical props on both platforms).
// Values are plain numbers already in one unit (one currency, or a percentage): a chart never sums currencies.
import type { Layout } from "../layout.js";
import type { ChartRole, SeriesColor } from "./scene.js";

/** What the numbers are. Amounts disappear in privacy mode (axis labels, value labels, tooltips, the
 * accessible summary); shares (percentages, counts) stay, like the legacy incognito mode. */
export type ValueKind = "amount" | "share";

/** Tooltip content for one data index; values come formatted by the caller. */
export interface ChartTip {
  title: string;
  rows: { name: string; value: string; amount?: boolean; color?: ChartRole }[];
}

interface ChartBase {
  /** The accessible name (the chart's title); the component appends a summary of its values. */
  label: string;
  /** Fixed width in px; omit to fill the parent (measured). */
  width?: number;
  layout?: Layout;
}

export interface LineSeries {
  values: (number | null)[];
  /** main (series colour), bench (muted, dashed), negative (loss tone). Default main. */
  tone?: "main" | "bench" | "negative";
  /** Series colour of a main line (default 1). */
  color?: SeriesColor;
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
  color: SeriesColor;
  /** One value per point; liabilities are negative and stack downward. */
  values: number[];
}

export interface AreaChartProps extends ChartBase {
  layers: AreaLayer[];
  /** The total line (default: the sum of the layers at each point). */
  totals?: number[];
  xLabels?: { i: number; text: string }[];
  yFormat?: (v: number) => string;
  valueKind?: ValueKind;
  height?: number;
  padL?: number;
  padR?: number;
  tooltip?: (i: number) => ChartTip;
}

export interface BarChartProps extends ChartBase {
  values: number[];
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
  color: SeriesColor;
  name: string;
}

export interface DonutProps {
  label: string;
  segments: DonutSegment[];
  size?: number;
  /** Centre text: a headline value and a caption; `amount` hides the value in privacy mode. */
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
