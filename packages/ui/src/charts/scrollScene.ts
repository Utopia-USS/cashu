// Scenes of the scrollable bar + line chart (the old components/ScrollableChart.tsx with the cash flow marks:
// recharts ComposedChart, fixed Y axis column, horizontally scrolling plot). Geometry follows recharts' defaults
// the old chart ran on: `barCategoryGap` 10 %, `barGap` 4px, `monotone` line with r 2 dots, axis tick 6px +
// margin 2px, `#666` axis lines, `minTickGap` 20 with `preserveEnd` label thinning.
import { type Built, type ChartColor, type ChartRole, colorRole, type SceneNode } from "./scene.js";

export const SCROLL = {
  /** Plot height (old `H`). */
  height: 300,
  /** The fixed Y axis column (old `AXIS_W`). */
  axisWidth: 72,
  /** Most a plot may widen to (old `MAX_W`). */
  maxWidth: 24000,
  top: 8,
  bottom: 4,
  right: 16,
  xAxis: 24,
} as const;
const PLOT_H = SCROLL.height - SCROLL.top - SCROLL.bottom - SCROLL.xAxis;
const TICK = 6;
const TICK_MARGIN = 2;
const MIN_TICK_GAP = 20;
/** Average 11px glyph width, for the label thinning (recharts measures the text; close enough here). */
const GLYPH = 6.2;

export interface ScrollSeries {
  name: string;
  values: readonly number[];
  /** A chart colour, or the tone roles of the old income / expense bars (`--pos`, `--neg`). */
  color: ChartColor | "positive" | "negative";
  /** Line only: the r 2 dots at the points (default true; old `dot={false}` = false). */
  dots?: boolean;
}

const roleOf = (c: ScrollSeries["color"]): ChartRole =>
  c === "positive" || c === "negative" ? c : colorRole(c);

/** A continuous time X axis (old recharts `type="number" scale="time"`, domain dataMin..dataMax): the points sit
 * at their dates, the axis shows the time scale's ~5 round dates (d3 `scaleTime().ticks(5)`). */
export interface ScrollTime {
  /** Date of each category (epoch ms, ascending). */
  xs: readonly number[];
  /** Label of an axis tick. */
  tickFormat(ms: number): string;
  /** Least gap between two labels (old `minTickGap`, default 20). */
  minTickGap?: number;
}

export interface ScrollData {
  labels: readonly string[];
  bars: readonly ScrollSeries[];
  line?: ScrollSeries | undefined;
  time?: ScrollTime | undefined;
}

/** Old `niceTicks`: about `count` round ticks covering [min, max]. */
function niceTicks(min: number, max: number, count = 5): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [0, 1];
  if (min === max) return [min, min + 1];
  const rawStep = (max - min) / (count - 1);
  const mag = 10 ** Math.floor(Math.log10(Math.abs(rawStep) || 1));
  const norm = rawStep / mag;
  const step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
  const start = Math.floor(min / step) * step;
  const end = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let v = start; v <= end + step * 0.5; v += step) ticks.push(Math.round(v));
  return ticks;
}

/** The shared ticks of the data (every bar and line value plus zero). */
export function scrollTicks(data: ScrollData): number[] {
  const all = [...data.bars.flatMap((s) => s.values), ...(data.line?.values ?? []), 0];
  return niceTicks(Math.min(...all), Math.max(...all), 5);
}

const yOf = (ticks: readonly number[]) => {
  const lo = ticks[0] ?? 0;
  const span = (ticks.at(-1) ?? 1) - lo || 1;
  return (v: number) => SCROLL.top + (1 - (v - lo) / span) * PLOT_H;
};

/** The fixed axis column: the Y axis line, 6px ticks and right-aligned 11px labels. */
export function scrollAxisScene(ticks: readonly number[], format: (v: number) => string): Built {
  const y = yOf(ticks);
  const x = SCROLL.axisWidth;
  const nodes: SceneNode[] = [
    { k: "line", x1: x, x2: x, y1: SCROLL.top, y2: SCROLL.top + PLOT_H, stroke: "axis" },
  ];
  for (const t of ticks) {
    nodes.push({ k: "line", x1: x - TICK, x2: x, y1: y(t), y2: y(t), stroke: "axis" });
    nodes.push({
      k: "text",
      x: x - TICK - TICK_MARGIN,
      y: y(t) + 3.9,
      text: format(t),
      anchor: "end",
      tone: "muted",
      size: "md",
    });
  }
  return {
    scene: { width: x, height: SCROLL.height, gradients: [], nodes },
    scrub: null,
    summary: "",
  };
}

/** d3 `curveMonotoneX` through the points (the old recharts `type="monotone"` line). */
function monotonePath(points: readonly (readonly [number, number])[]): string {
  const n = points.length;
  const p = (i: number) => points[i] ?? [0, 0];
  if (n === 0) return "";
  const [x0, y0] = p(0);
  if (n === 1) return `M${x0},${y0}`;
  if (n === 2) return `M${x0},${y0}L${p(1)[0]},${p(1)[1]}`;
  const sign = (v: number) => (v < 0 ? -1 : 1);
  const slope3 = (i: number) => {
    const [xa, ya] = p(i - 1);
    const [xb, yb] = p(i);
    const [xc, yc] = p(i + 1);
    const h0 = xb - xa;
    const h1 = xc - xb;
    const s0 = (yb - ya) / (h0 || (h1 < 0 ? -0 : 0));
    const s1 = (yc - yb) / (h1 || (h0 < 0 ? -0 : 0));
    const q = (s0 * h1 + s1 * h0) / (h0 + h1);
    return (sign(s0) + sign(s1)) * Math.min(Math.abs(s0), Math.abs(s1), 0.5 * Math.abs(q)) || 0;
  };
  const slope2 = (i: number, j: number, t: number) => {
    const h = p(j)[0] - p(i)[0];
    return h ? ((3 * (p(j)[1] - p(i)[1])) / h - t) / 2 : t;
  };
  const m: number[] = [];
  for (let i = 1; i < n - 1; i++) m[i] = slope3(i);
  m[0] = slope2(0, 1, m[1] ?? 0);
  m[n - 1] = slope2(n - 2, n - 1, m[n - 2] ?? 0);
  let d = `M${x0},${y0}`;
  for (let i = 0; i < n - 1; i++) {
    const [xa, ya] = p(i);
    const [xb, yb] = p(i + 1);
    const dx = (xb - xa) / 3;
    d += `C${xa + dx},${ya + dx * (m[i] ?? 0)},${xb - dx},${yb - dx * (m[i + 1] ?? 0)},${xb},${yb}`;
  }
  return d;
}

/** Which category labels fit (recharts `preserveEnd` with `minTickGap`, default 20): the last always, then
 * backwards every label that keeps the gap to the one after it. */
function visibleLabels(
  centres: readonly number[],
  labels: readonly string[],
  gap = MIN_TICK_GAP,
): boolean[] {
  const shown = labels.map(() => false);
  let end = Number.POSITIVE_INFINITY;
  for (let i = labels.length - 1; i >= 0; i--) {
    const half = ((labels[i]?.length ?? 0) * GLYPH) / 2;
    const c = centres[i] ?? 0;
    if (c + half <= end && c - half >= 0) {
      shown[i] = true;
      end = c - half - gap;
    } else if (i === labels.length - 1) {
      shown[i] = true;
      end = c - half - gap;
    }
  }
  return shown;
}

const DAY = 86400000;
/** d3-time intervals from a day up (the ones a date series of loans or months reaches): [unit, step, duration]. */
const TIME_INTERVALS: readonly (readonly ["day" | "week" | "month" | "year", number, number])[] = [
  ["day", 1, DAY],
  ["day", 2, 2 * DAY],
  ["week", 1, 7 * DAY],
  ["month", 1, 30 * DAY],
  ["month", 3, 90 * DAY],
  ["year", 1, 365 * DAY],
];

/** d3-array `tickStep` (positive direction). */
function tickStep(start: number, stop: number, count: number): number {
  const step0 = Math.abs(stop - start) / Math.max(0, count);
  let step1 = 10 ** Math.floor(Math.log10(step0));
  const error = step0 / step1;
  if (error >= Math.sqrt(50)) step1 *= 10;
  else if (error >= Math.sqrt(10)) step1 *= 5;
  else if (error >= Math.sqrt(2)) step1 *= 2;
  return step1;
}

/** d3 `scaleTime().domain([start, stop]).ticks(count)` in local time, from day intervals up. */
export function timeTicks(start: number, stop: number, count = 5): number[] {
  if (!(stop > start)) return [start];
  const target = (stop - start) / count;
  let pick = TIME_INTERVALS.findIndex(([, , d]) => d > target);
  let unit: "day" | "week" | "month" | "year";
  let step: number;
  if (pick === -1) {
    unit = "year";
    step = Math.max(1, Math.floor(tickStep(start / (365 * DAY), stop / (365 * DAY), count)));
  } else {
    if (pick > 0) {
      const lo = TIME_INTERVALS[pick - 1];
      const hi = TIME_INTERVALS[pick];
      if (lo && hi && target / lo[2] < hi[2] / target) pick -= 1;
    }
    const chosen = TIME_INTERVALS[pick] ?? TIME_INTERVALS[0];
    unit = chosen?.[0] ?? "day";
    step = chosen?.[1] ?? 1;
  }
  const d = new Date(start);
  d.setHours(0, 0, 0, 0);
  if (unit === "week") d.setDate(d.getDate() - d.getDay());
  if (unit === "month" || unit === "year") d.setDate(1);
  if (unit === "year") d.setMonth(0);
  const out: number[] = [];
  for (let guard = 0; guard < 10000 && d.getTime() <= stop; guard++) {
    const keep =
      unit === "day"
        ? step === 1 || (d.getDate() - 1) % step === 0
        : unit === "month"
          ? d.getMonth() % step === 0
          : unit === "year"
            ? d.getFullYear() % step === 0
            : true;
    if (keep && d.getTime() >= start) out.push(d.getTime());
    if (unit === "day") d.setDate(d.getDate() + 1);
    else if (unit === "week") d.setDate(d.getDate() + 7);
    else if (unit === "month") d.setMonth(d.getMonth() + 1);
    else d.setFullYear(d.getFullYear() + 1);
  }
  return out;
}

/** The scrolling plot at `width` px: grid rules, the X axis, grouped bars and the line with its dots. */
export function scrollPlotScene(
  data: ScrollData,
  width: number,
  ticks: readonly number[],
  summary: string,
  interactive: boolean,
): Built {
  const n = data.labels.length;
  const plotW = Math.max(1, width - SCROLL.right);
  const y = yOf(ticks);
  const base = SCROLL.top + PLOT_H;
  const band = n ? plotW / n : plotW;
  const time = data.time;
  const t0 = time?.xs[0] ?? 0;
  const tSpan = (time?.xs.at(-1) ?? 0) - t0;
  const tx = (ms: number) => (tSpan > 0 ? ((ms - t0) / tSpan) * plotW : plotW / 2);
  const cx = (i: number) => (time ? tx(time.xs[i] ?? t0) : band * (i + 0.5));
  const k = data.bars.length;
  const offset = band * 0.1;
  const size = k ? Math.max(1, (band - 2 * offset - (k - 1) * 4) / k) : 0;
  const nodes: SceneNode[] = ticks.map((t) => ({
    k: "line",
    x1: 0,
    x2: plotW,
    y1: y(t),
    y2: y(t),
    stroke: "rule",
  }));
  nodes.push({ k: "line", x1: 0, x2: plotW, y1: base, y2: base, stroke: "axis" });
  const axis = time
    ? timeTicks(t0, t0 + tSpan).map((ms) => ({ x: tx(ms), label: time.tickFormat(ms) }))
    : data.labels.map((label, i) => ({ x: cx(i), label }));
  const shown = visibleLabels(
    axis.map((a) => a.x),
    axis.map((a) => a.label),
    time?.minTickGap,
  );
  axis.forEach(({ x, label }, i) => {
    if (!shown[i]) return;
    nodes.push({ k: "line", x1: x, x2: x, y1: base, y2: base + TICK, stroke: "axis" });
    nodes.push({
      k: "text",
      x,
      y: base + TICK + TICK_MARGIN + 7.8,
      text: label,
      anchor: "middle",
      tone: "muted",
      size: "md",
    });
  });
  const zero = y(0);
  for (let i = 0; i < n; i++) {
    data.bars.forEach((s, j) => {
      const v = s.values[i] ?? 0;
      const top = Math.min(zero, y(v));
      const h = Math.abs(y(v) - zero);
      if (h > 0)
        nodes.push({
          k: "rect",
          x: i * band + offset + j * (size + 4),
          y: top,
          w: size,
          h,
          rx: 0,
          fill: roleOf(s.color),
        });
    });
  }
  const line = data.line;
  if (line) {
    const role = roleOf(line.color);
    const pts = data.labels.map((_, i) => [cx(i), y(line.values[i] ?? 0)] as const);
    nodes.push({ k: "path", d: monotonePath(pts), stroke: role, width: 2 });
    if (line.dots !== false)
      for (const [px, py] of pts)
        nodes.push({
          k: "circle",
          cx: px,
          cy: py,
          r: 2,
          fill: "paper",
          stroke: role,
          strokeWidth: 2,
        });
  }
  return {
    scene: { width, height: SCROLL.height, gradients: [], nodes },
    summary,
    scrub:
      interactive && n > 0
        ? {
            n,
            x0: cx(0),
            x1: cx(n - 1),
            focus: (i) => ({
              x: cx(i),
              top: SCROLL.top,
              bottom: base,
              tipY: SCROLL.top,
              tipBelow: true,
              dots: line ? [{ cy: y(line.values[i] ?? 0), fill: roleOf(line.color) }] : [],
            }),
          }
        : null,
  };
}
