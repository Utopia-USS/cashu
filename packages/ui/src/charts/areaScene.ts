// Stacked area scene (the legacy frontend StackedChart): assets stacked up from 0, liabilities down, the
// total as the one line. Several layers keep solid fills (they encode the categories); a single layer
// fades like a line's area.

import { S } from "./charts.strings.js";
import {
  areaFade,
  bandPath,
  extent,
  fadeOpacity,
  linear,
  linePath,
  type Pt,
  stackLayers,
  ticks,
} from "./geometry.js";
import { MIN_WIDTH } from "./lineScene.js";
import type { Built, Gradient, SceneNode, Scrub } from "./scene.js";
import { seriesRole } from "./scene.js";
import type { AreaChartProps } from "./types.js";
import { chartSummary, hides, seriesSummary, wholeNumber } from "./values.js";

/** The strong end of a single layer's fade: the legacy flat fill (.8) x 1.6, capped (F7 PX1). */
const STACK_FADE = fadeOpacity(0.8);
const PAD_T = 10;
const PAD_B = 22;

export function areaScene(p: AreaChartProps, width: number, privacy: boolean): Built {
  const { layers: input, xLabels = [] } = p;
  const hidden = hides(p.valueKind, privacy);
  const n = Math.max(0, ...input.map((l) => l.values.length));
  const rows = Array.from({ length: n }, (_, i) =>
    Object.fromEntries(input.map((l) => [l.key, l.values[i] ?? 0])),
  );
  const totals = p.totals ?? rows.map((r) => Object.values(r).reduce((a, v) => a + v, 0));
  const w = Math.max(width, MIN_WIDTH);
  const h = p.height ?? 230;
  const padL = p.padL ?? 60;
  const padR = p.padR ?? 16;
  const { layers, min, max } = stackLayers(
    rows,
    input.map((l) => l.key),
  );
  const [lo, hi] = extent([min, max, ...totals]);
  const X = linear(0, Math.max(1, n - 1), padL, w - padR);
  const Y = linear(lo, hi, h - PAD_B, PAD_T);
  const nodes: SceneNode[] = [];
  const gradients: Gradient[] = [];
  const fmt = p.yFormat ?? wholeNumber;

  for (const v of ticks(lo, hi, 4)) {
    nodes.push({ k: "line", x1: padL, x2: w - padR, y1: Y(v), y2: Y(v), stroke: "grid", width: 1 });
    if (!hidden) {
      nodes.push({
        k: "text",
        x: padL - 8,
        y: Y(v) + 3.5,
        text: fmt(v),
        anchor: "end",
        tone: "muted",
      });
    }
  }
  for (const xl of xLabels) {
    nodes.push({
      k: "text",
      x: X(xl.i),
      y: h - 6,
      text: xl.text,
      anchor: xl.i === 0 ? "start" : xl.i === n - 1 ? "end" : "middle",
      tone: "muted",
    });
  }
  if (n >= 2) {
    layers.forEach((l, k) => {
      const role = seriesRole(input[k]?.color ?? 1);
      const d = bandPath(
        l.hi.map((v, i): Pt => [X(i), Y(v)]),
        l.lo.map((v, i): Pt => [X(i), Y(v)]),
      );
      if (layers.length === 1) {
        gradients.push({
          id: "s",
          color: role,
          strong: STACK_FADE,
          ...areaFade(Y(Math.max(lo, Math.min(hi, 0))), PAD_T, h - PAD_B),
        });
        nodes.push({ k: "path", d, fill: { gradient: "s" } });
      } else {
        nodes.push({ k: "path", d, fill: role, opacity: 0.8 });
      }
    });
    nodes.push({
      k: "path",
      d: linePath(totals.map((v, i): Pt => [X(i), Y(v)])),
      stroke: "text",
      width: 1.75,
    });
  }

  const summary =
    !hidden && p.accessibleSummary !== undefined
      ? chartSummary(p.label, [p.accessibleSummary], xLabels)
      : chartSummary(
          p.label,
          [
            ...input.map((l) => seriesSummary(l.name, l.values, fmt, hidden)),
            input.length > 1 ? seriesSummary(S.total, totals, fmt, hidden) : null,
          ],
          xLabels,
        );
  const scrub: Scrub | null =
    p.tooltip && n >= 2
      ? {
          n,
          x0: padL,
          x1: w - padR,
          focus: (i) => ({
            x: X(i),
            top: PAD_T,
            bottom: h - PAD_B,
            dots: [{ cy: Y(totals[i] ?? 0), fill: "text" }],
            tipY: PAD_T,
            tipBelow: true,
          }),
        }
      : null;
  return { scene: { width: w, height: h, gradients, nodes }, scrub, summary };
}
