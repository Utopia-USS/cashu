// The platform-free description of a drawn chart: the scene builders (lineScene.ts, barScene.ts, ...) turn
// props + size + privacy into a Scene, and the thin renderers draw it (platform.tsx: DOM <svg> on the desktop,
// platform.native.tsx: react-native-svg on mobile). Colours are token roles, never values: the web renderer
// writes Tailwind classes of the theme, the native renderer resolves the same CSS variables through Uniwind.

/** Colour role of a mark: a token of packages/ui/src/tokens/theme.css. */
export type ChartRole =
  | "series1"
  | "series2"
  | "series3"
  | "series4"
  | "series5"
  | "series6"
  | "series7"
  | "series8"
  | "grid"
  | "text"
  | "muted"
  | "positive"
  | "negative"
  | "warning"
  | "info"
  | "plan"
  | "surface"
  | NamedColor;

/** A categorical series colour, `chart.series1..8` (cashu-ui tokens). */
export type SeriesColor = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

/** A named token colour besides the categorical series: the accent (the old charts' main line, `--nw`), the
 * benchmark grey and the investment bucket palette (old `--inv-*`, index.css), by their theme.css names. */
export type NamedColor =
  | "accent"
  | "bench"
  | "inv-global"
  | "inv-pl"
  | "inv-bonds"
  | "inv-cash"
  | "inv-other"
  | "inv-5"
  | "inv-6"
  | "inv-7";

/** Any colour a series, a donut segment, a legend mark or a swatch takes. */
export type ChartColor = SeriesColor | NamedColor;

export const seriesRole = (c: SeriesColor): ChartRole => `series${c}`;

/** The role of a series / segment colour. */
export const colorRole = (c: ChartColor): ChartRole => (typeof c === "number" ? seriesRole(c) : c);

/** The CSS variable of every role (theme.css). The native renderer resolves these through Uniwind. */
export const ROLE_VAR: Record<ChartRole, string> = {
  series1: "--color-chart-1",
  series2: "--color-chart-2",
  series3: "--color-chart-3",
  series4: "--color-chart-4",
  series5: "--color-chart-5",
  series6: "--color-chart-6",
  series7: "--color-chart-7",
  series8: "--color-chart-8",
  grid: "--color-chart-grid",
  text: "--color-fg",
  muted: "--color-fg-muted",
  positive: "--color-positive",
  negative: "--color-negative",
  warning: "--color-warning",
  info: "--color-info",
  /** A planned, not yet done bar: the old `.bx.plan` chip grey. */
  plan: "--color-chip",
  surface: "--color-surface-raised",
  accent: "--color-accent",
  bench: "--color-bench",
  "inv-global": "--color-inv-global",
  "inv-pl": "--color-inv-pl",
  "inv-bonds": "--color-inv-bonds",
  "inv-cash": "--color-inv-cash",
  "inv-other": "--color-inv-other",
  "inv-5": "--color-inv-5",
  "inv-6": "--color-inv-6",
  "inv-7": "--color-inv-7",
};

interface LineNode {
  k: "line";
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  stroke: ChartRole;
  width?: number;
  dash?: string;
}

interface PathNode {
  k: "path";
  activation?: { index: number; label: string };
  d: string;
  stroke?: ChartRole;
  /** A role, or the id of one of the scene's gradients. */
  fill?: ChartRole | { gradient: string };
  width?: number;
  dash?: string;
  opacity?: number;
  evenOdd?: boolean;
  /** Line cap of a stroked path (default round; the sparkline keeps the old butt caps). */
  cap?: "round" | "butt";
}

interface RectNode {
  k: "rect";
  x: number;
  y: number;
  w: number;
  h: number;
  rx: number;
  fill: ChartRole;
  opacity?: number;
}

interface CircleNode {
  k: "circle";
  cx: number;
  cy: number;
  r: number;
  fill: ChartRole;
  /** A ring in the surface colour separates a marker from the lines under it. */
  ring?: boolean;
}

/** A label: `y` is the text baseline, `anchor` the horizontal alignment at `x`. Numbers use tabular figures. */
export interface TextNode {
  k: "text";
  x: number;
  y: number;
  text: string;
  anchor: "start" | "middle" | "end";
  tone: "muted" | "text";
}

export type SceneNode = LineNode | PathNode | RectNode | CircleNode | TextNode;

/** A vertical fade (userSpaceOnUse): `strong` opacity at y1, transparent at y2. */
export interface Gradient {
  id: string;
  color: ChartRole;
  strong: number;
  y1: number;
  y2: number;
}

export interface Scene {
  width: number;
  height: number;
  gradients: Gradient[];
  nodes: SceneNode[];
}

/** Marks drawn over a scene while a data index is focused (hover, arrow keys, touch scrub). */
export interface Focus {
  /** Crosshair x and the plot's vertical extent. */
  x: number;
  top: number;
  bottom: number;
  dots: { cy: number; fill: ChartRole }[];
  /** Where the tooltip anchors (the highest focused point); it sits above it unless `tipBelow`. */
  tipY: number;
  tipBelow?: boolean;
}

/** What a chart needs to be scrubbed: data length and the plot's horizontal extent, plus the focus marks. */
export interface Scrub {
  n: number;
  x0: number;
  x1: number;
  focus: (i: number) => Focus;
}

/** What a scene builder returns. */
export interface Built {
  scene: Scene;
  /** Null for a static chart (no tooltip or fewer than two points). */
  scrub: Scrub | null;
  /** The accessible name: the label plus a summary of the values (privacy-masked). */
  summary: string;
}
