// Bar chart scene (the legacy frontend Bars): monthly bars with a dashed plan line (label on the left),
// category labels under the bars and value labels over them.
import { S } from "./charts.strings.js";
import { barLayout } from "./geometry.js";
import { MIN_WIDTH } from "./lineScene.js";
import { type Built, type ChartRole, type SceneNode, seriesRole } from "./scene.js";
import type { BarChartProps } from "./types.js";
import { hides, isBanana, wholeNumber } from "./values.js";

const KIND: Record<"main" | "plan" | "muted", { fill: ChartRole; opacity?: number }> = {
  main: { fill: "series1" },
  plan: { fill: "plan" },
  // The old `.bx.mutedbar`: the benchmark grey at .55.
  muted: { fill: "bench", opacity: 0.55 },
};

/** "Wpłaty: sie 2 000, wrz 500, paź brak" (F7 FE14): a screen reader gets the numbers, not only the title;
 * in privacy mode an amount is spoken as "hidden". */
function barsSummary(p: BarChartProps, privacy: boolean): string {
  const hidden = hides(p.valueKind, privacy);
  const fmt = p.format ?? wholeNumber;
  const parts = p.values.map((v, i) => {
    const name = p.labels?.[i] ?? String(i + 1);
    const given = p.valueLabels?.[i];
    const shown = given ?? fmt(v);
    const value = !v && given == null ? S.none : hidden && !isBanana(shown) ? S.hidden : shown;
    return `${name} ${value}`;
  });
  return parts.length ? `${p.label}: ${parts.join(", ")}` : `${p.label}: ${S.noData}`;
}

export function barScene(p: BarChartProps, width: number, privacy: boolean): Built {
  if (p.series !== undefined) return groupedScene(p, width, privacy);
  const hidden = hides(p.valueKind, privacy);
  const w = Math.max(width, MIN_WIDTH);
  const h = p.height ?? 120;
  const plan = p.plan ?? null;
  const { boxes, y } = barLayout(
    p.values.map((v, i) => (p.kinds?.[i] === "plan" && plan ? plan : v)),
    w,
    h,
    { plan },
  );
  const nodes: SceneNode[] = [
    { k: "line", x1: 0, x2: w, y1: y(0), y2: y(0), stroke: "grid", width: 1 },
  ];
  boxes.forEach((b, i) => {
    const kind = KIND[p.kinds?.[i] ?? "main"];
    if (b.h > 0) nodes.push({ k: "rect", x: b.x, y: b.y, w: b.w, h: b.h, rx: 3, ...kind });
    const label = p.labels?.[i];
    if (label != null) {
      nodes.push({ k: "text", x: b.cx, y: h - 4, text: label, anchor: "middle", tone: "muted" });
    }
    const value = p.valueLabels?.[i];
    if (value != null && b.h > 0 && (!hidden || isBanana(value))) {
      nodes.push({ k: "text", x: b.cx, y: b.y - 4, text: value, anchor: "middle", tone: "text" });
    }
  });
  if (plan) {
    nodes.push({
      k: "line",
      x1: 0,
      x2: w,
      y1: y(plan),
      y2: y(plan),
      stroke: "muted",
      dash: "3 3",
      width: 1,
    });
    nodes.push({
      k: "text",
      x: 2,
      y: y(plan) - 4,
      text: p.planLabel ?? S.plan,
      anchor: "start",
      tone: "muted",
    });
  }
  return {
    scene: { width: w, height: h, gradients: [], nodes },
    scrub: null,
    summary: barsSummary(p, privacy),
  };
}

/** Grouped categories share one zero-inclusive domain; labels are the only length authority. */
function groupedScene(p: BarChartProps, width: number, privacy: boolean): Built {
  const n = p.labels?.length ?? 0;
  const series = p.series ?? [];
  if (
    p.values.length !== 0 ||
    series.length === 0 ||
    series.some((row) => row.values.length !== n) ||
    (p.line && p.line.values.length !== n)
  )
    throw new RangeError("invalid grouped chart lengths");
  const all = [...series.flatMap((row) => row.values), ...(p.line?.values ?? [])];
  if (all.some((value) => !Number.isFinite(value)))
    throw new RangeError("invalid grouped chart value");
  const w = Math.max(width, MIN_WIDTH),
    h = p.height ?? 120;
  const top = 12,
    bottom = h - 24;
  const lo = Math.min(0, ...all),
    hi = Math.max(0, ...all);
  const span = hi - lo || 1;
  const y = (value: number) => bottom - ((value - lo) / span) * (bottom - top);
  const step = n ? w / n : w;
  const groupWidth = step * 0.75,
    barWidth = groupWidth / series.length;
  const cx = (index: number) => step * (index + 0.5);
  const nodes: SceneNode[] = [{ k: "line", x1: 0, x2: w, y1: y(0), y2: y(0), stroke: "grid" }];
  for (let index = 0; index < n; index++) {
    series.forEach((row, position) => {
      const value = row.values[index] ?? 0;
      nodes.push({
        k: "rect",
        x: cx(index) - groupWidth / 2 + position * barWidth,
        y: Math.min(y(0), y(value)),
        w: barWidth * 0.9,
        h: Math.abs(y(value) - y(0)),
        rx: 2,
        fill: seriesRole(row.color),
      });
    });
    nodes.push({
      k: "text",
      x: cx(index),
      y: h - 4,
      text: p.labels?.[index] ?? "",
      anchor: "middle",
      tone: "muted",
    });
  }
  if (p.line)
    nodes.push({
      k: "path",
      d: p.line.values
        .map((value, index) => `${index ? "L" : "M"}${cx(index)},${y(value)}`)
        .join(" "),
      stroke: seriesRole(p.line.color),
      width: 2,
    });
  const hidden = hides(p.valueKind, privacy);
  const summary =
    n === 0
      ? `${p.label}: ${S.noData}`
      : hidden
        ? `${p.label}: ${S.hidden}`
        : (p.accessibleSummary ??
          `${p.label}: ${p.labels?.map((label, i) => `${label}: ${[...series, ...(p.line ? [p.line] : [])].map((row) => `${row.name} ${(p.format ?? wholeNumber)(row.values[i] ?? 0)}`).join(", ")}`).join("; ")}`);
  return {
    scene: { width: w, height: h, gradients: [], nodes },
    summary,
    scrub:
      n > 0
        ? {
            n,
            x0: cx(0),
            x1: cx(n - 1),
            focus: (index) => ({
              x: cx(index),
              top,
              bottom,
              tipY: top,
              dots: p.line
                ? [{ cy: y(p.line.values[index] ?? 0), fill: seriesRole(p.line.color) }]
                : [],
            }),
          }
        : null,
  };
}
