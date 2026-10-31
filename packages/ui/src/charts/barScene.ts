// Bar chart scene (the legacy frontend Bars): monthly bars with a dashed plan line (label on the left),
// category labels under the bars and value labels over them.
import { S } from "./charts.strings.js";
import { barLayout } from "./geometry.js";
import { MIN_WIDTH } from "./lineScene.js";
import type { Built, ChartRole, SceneNode } from "./scene.js";
import type { BarChartProps } from "./types.js";
import { hides, wholeNumber } from "./values.js";

const KIND: Record<"main" | "plan" | "muted", { fill: ChartRole; opacity?: number }> = {
  main: { fill: "series1" },
  plan: { fill: "plan" },
  muted: { fill: "muted", opacity: 0.55 },
};

/** "Wpłaty: sie 2 000, wrz 500, paź brak" (F7 FE14): a screen reader gets the numbers, not only the title;
 * in privacy mode an amount is spoken as "hidden". */
function barsSummary(p: BarChartProps, privacy: boolean): string {
  const hidden = hides(p.valueKind, privacy);
  const fmt = p.format ?? wholeNumber;
  const parts = p.values.map((v, i) => {
    const name = p.labels?.[i] ?? String(i + 1);
    const given = p.valueLabels?.[i];
    const value = !v && given == null ? S.none : hidden ? S.hidden : (given ?? fmt(v));
    return `${name} ${value}`;
  });
  return parts.length ? `${p.label}: ${parts.join(", ")}` : `${p.label}: ${S.noData}`;
}

export function barScene(p: BarChartProps, width: number, privacy: boolean): Built {
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
    if (value != null && b.h > 0 && !hidden) {
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
