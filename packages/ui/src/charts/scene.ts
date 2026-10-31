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
  | "surface";

/** A categorical series colour, `chart.series1..8` (cashu-ui tokens). */
export type SeriesColor = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

export const seriesRole = (c: SeriesColor): ChartRole => `series${c}`;

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
  plan: "--color-accent-muted",
  surface: "--color-surface-raised",
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
  d: string;
  stroke?: ChartRole;
  /** A role, or the id of one of the scene's gradients. */
  fill?: ChartRole | { gradient: string };
  width?: number;
  dash?: string;
  opacity?: number;
  evenOdd?: boolean;
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
