// Sparkline scene (72 x 22, the legacy frontend Spark): the line in the first-vs-last tone and a dot on the
// last value; fewer than two values draw nothing.
import { sparkline } from "./geometry.js";
import type { Built, ChartRole } from "./scene.js";
import type { SparklineProps } from "./types.js";

export const SPARK_W = 72;
export const SPARK_H = 22;

const TONE: Record<"pos" | "neg" | "flat", ChartRole> = {
  pos: "positive",
  neg: "negative",
  flat: "muted",
};
const OVERRIDE: Record<NonNullable<SparklineProps["tone"]>, ChartRole> = {
  positive: "positive",
  negative: "negative",
  muted: "muted",
};

export function sparkScene(p: SparklineProps): Built {
  const g = sparkline(p.values, SPARK_W, SPARK_H);
  const stroke = p.tone ? OVERRIDE[p.tone] : TONE[g.tone];
  return {
    scene: {
      width: SPARK_W,
      height: SPARK_H,
      gradients: [],
      nodes: g.d
        ? [
            { k: "path", d: g.d, stroke, width: 1.5 },
            ...(g.last
              ? [
                  {
                    k: "circle" as const,
                    cx: g.last[0],
                    cy: g.last[1],
                    r: 2,
                    fill: "text" as const,
                  },
                ]
              : []),
          ]
        : [],
    },
    scrub: null,
    summary: p.label ?? "",
  };
}
