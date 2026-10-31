// Line chart scene (the legacy frontend LineChart, design/v2/v2.js): grid and y axis, date labels, level
// lines, lines with fading areas, trade markers, end and level labels stacked on the right with leaders.

import { S } from "./charts.strings.js";
import {
  areaFade,
  areaPath,
  extent,
  fadeOpacity,
  linear,
  linePath,
  type Pt,
  stackLabels,
  ticks,
} from "./geometry.js";
import type { Built, ChartRole, Gradient, SceneNode, Scrub } from "./scene.js";
import { seriesRole } from "./scene.js";
import type { Level, LineChartProps, LineSeries } from "./types.js";
import { chartSummary, hides, seriesSummary, wholeNumber } from "./values.js";

/** The strong end of a line's area fade: the legacy flat fill (.12) x 1.6 (F7 PX1). */
export const AREA_FADE = fadeOpacity(0.12);
const PAD_T = 10;
const PAD_B = 22;
/** Minimum drawing width: narrower containers get a horizontally clipped chart, never a collapsed one. */
export const MIN_WIDTH = 120;

const LEVEL: Record<Level["kind"], { stroke: ChartRole; dash: string }> = {
  alert: { stroke: "warning", dash: "3 3" },
  rule: { stroke: "muted", dash: "3 3" },
  cost: { stroke: "muted", dash: "1 3" },
  agent: { stroke: "info", dash: "3 3" },
};

function lineRole(s: LineSeries): ChartRole {
  if (s.tone === "bench") return "muted";
  if (s.tone === "negative") return "negative";
  return seriesRole(s.color ?? 1);
}

const lastIndex = (s: LineSeries): number => {
  for (let i = s.values.length - 1; i >= 0; i--) if (s.values[i] != null) return i;
  return -1;
};

export function lineScene(p: LineChartProps, width: number, privacy: boolean): Built {
  const { series, levels = [], xLabels = [], markers = [] } = p;
  const hidden = hides(p.valueKind, privacy);
  const n = Math.max(0, ...series.map((s) => s.values.length));
  const w = Math.max(width, MIN_WIDTH);
  const h = p.height ?? 230;
  const padR = p.padR ?? 64;
  const left = p.yFormat === false ? 6 : (p.padL ?? 56);
  const all = series
    .flatMap((s) => s.values.filter((v): v is number => v != null))
    .concat(levels.map((l) => l.y));
  const [lo, hi] = extent(all, { ymin: p.ymin, ymax: p.ymax });
  const X = linear(0, Math.max(1, n - 1), left, w - padR);
  const Y = linear(lo, hi, h - PAD_B, PAD_T);
  const right = w - padR + 6;
  const nodes: SceneNode[] = [];
  const gradients: Gradient[] = [];

  const fmt = p.yFormat === false ? null : (p.yFormat ?? wholeNumber);
  for (const v of ticks(lo, hi, p.yTicks ?? 4)) {
    nodes.push({ k: "line", x1: left, x2: right, y1: Y(v), y2: Y(v), stroke: "grid", width: 1 });
    // Privacy mode hides the amount axis: the grid stays, the numbers go.
    if (fmt && !hidden) {
      nodes.push({
        k: "text",
        x: left - 8,
        y: Y(v) + 3.5,
        text: fmt(v),
        anchor: "end",
        tone: "muted",
      });
    }
  }
  xLabels.forEach((xl, k) => {
    nodes.push({
      k: "text",
      x: X(xl.i),
      y: h - 6,
      text: xl.text,
      anchor: k === 0 && xl.i === 0 ? "start" : xl.i === n - 1 ? "end" : "middle",
      tone: "muted",
    });
  });
  for (const l of levels) {
    const { stroke, dash } = LEVEL[l.kind];
    nodes.push({ k: "line", x1: left, x2: right, y1: Y(l.y), y2: Y(l.y), stroke, dash, width: 1 });
  }
  series.forEach((s, k) => {
    const role = lineRole(s);
    const pts = s.values.map((v, i) => (v == null ? null : ([X(i), Y(v)] as Pt)));
    const solid = pts.filter((pt): pt is Pt => pt != null);
    if (s.area && solid.length > 1) {
      const baseY = Y(Math.max(lo, Math.min(hi, s.areaTo ?? lo)));
      const id = `a${k}`;
      gradients.push({ id, color: role, strong: AREA_FADE, ...areaFade(baseY, PAD_T, h - PAD_B) });
      nodes.push({ k: "path", d: areaPath(solid, baseY), fill: { gradient: id } });
    }
    nodes.push({
      k: "path",
      d: linePath(pts),
      stroke: role,
      width: 2,
      ...(s.tone === "bench" ? { dash: "4 4" } : {}),
    });
  });
  for (const m of markers) {
    const v = m.y ?? series[0]?.values[m.i];
    if (v == null) continue;
    const fill: ChartRole = m.kind === "buy" ? "positive" : "negative";
    nodes.push({ k: "circle", cx: X(m.i), cy: Y(v), r: 4, fill, ring: true });
  }

  type EndItem = { kind: "end"; s: LineSeries; i: number; y: number };
  type LevelItem = { kind: "level"; l: Level; y: number };
  const ends: EndItem[] = [];
  for (const s of series) {
    const i = lastIndex(s);
    const v = s.values[i];
    if (s.endLabel && v != null) ends.push({ kind: "end", s, i, y: Y(v) });
  }
  const levelItems: LevelItem[] = levels
    .filter((l) => l.label)
    .map((l) => ({ kind: "level", l, y: Y(l.y) }));
  for (const it of stackLabels<EndItem | LevelItem>([...ends, ...levelItems], 13, h - PAD_B)) {
    const leader = Math.abs(it.ly - it.y) > 1;
    if (it.kind === "end") {
      const x = X(it.i);
      nodes.push({ k: "circle", cx: x, cy: it.y, r: 3.5, fill: lineRole(it.s), ring: true });
      if (leader) {
        nodes.push({
          k: "line",
          x1: x + 4,
          y1: it.y,
          x2: x + 9,
          y2: it.ly,
          stroke: "muted",
          width: 1,
        });
      }
      nodes.push({
        k: "text",
        x: x + 11,
        y: it.ly + 3.5,
        text: it.s.endLabel ?? "",
        anchor: "start",
        tone: it.s.tone === "bench" ? "muted" : "text",
      });
    } else {
      if (leader) {
        nodes.push({
          k: "line",
          x1: right,
          y1: it.y,
          x2: right + 6,
          y2: it.ly,
          stroke: "muted",
          width: 1,
        });
      }
      nodes.push({
        k: "text",
        x: right + 9,
        y: it.ly + 3.5,
        text: it.l.label ?? "",
        anchor: "start",
        tone: it.l.muted ? "muted" : "text",
      });
    }
  }

  const sayFmt = p.yFormat === false || p.yFormat == null ? wholeNumber : p.yFormat;
  const summary = chartSummary(
    p.label,
    series.map((s, k) =>
      seriesSummary(s.name ?? s.endLabel ?? S.series(k + 1), s.values, sayFmt, hidden),
    ),
    xLabels,
  );
  const scrub: Scrub | null =
    p.tooltip && n >= 2
      ? {
          n,
          x0: left,
          x1: w - padR,
          focus: (i) => {
            const dots = series.flatMap((s) => {
              const v = s.values[i];
              return v == null ? [] : [{ cy: Y(v), fill: lineRole(s) }];
            });
            return {
              x: X(i),
              top: PAD_T,
              bottom: h - PAD_B,
              dots,
              tipY: dots.length ? Math.min(...dots.map((d) => d.cy)) : PAD_T,
            };
          },
        }
      : null;
  return { scene: { width: w, height: h, gradients, nodes }, scrub, summary };
}
