// Chart geometry: the legacy cases of frontend/tests/v2.test.mjs (chart part) and chart-fade.test.mjs, moved
// with the geometry from @cashu/ui-logic. Same inputs, same expected numbers and paths.
import { describe, expect, it } from "vitest";
import {
  areaFade,
  areaPath,
  bandPath,
  barLayout,
  donutArcs,
  extent,
  fadeOpacity,
  labelIndices,
  linear,
  linePath,
  nearestIndex,
  sparkline,
  stackLabels,
  stackLayers,
  ticks,
} from "./geometry.js";

describe("sparkline", () => {
  it("scales into 72 x 22 with 2 px margins, tone from first vs last, flat and short series", () => {
    const g = sparkline([10, 12, 11, 14]);
    expect(g.tone).toBe("pos");
    expect(g.d.startsWith("M0,")).toBe(true);
    expect(g.last).toEqual([72, 2]); // max at the top margin
    const low = sparkline([14, 10]);
    expect(low.tone).toBe("neg");
    expect(low.last).toEqual([72, 20]); // min at the bottom margin
    const flat = sparkline([5, 5, 5]);
    expect(flat.tone).toBe("flat");
    expect(flat.last).toEqual([72, 11]);
    expect(sparkline([3]).d).toBe("");
    expect(sparkline([null, 4, undefined, 6]).tone).toBe("pos"); // gaps dropped
  });
});

describe("extent and ticks", () => {
  it("pads 6 %, pins ymax / ymin, never collapses", () => {
    expect(extent([0, 100])).toEqual([-6, 106]);
    expect(extent([-8.4, 0], { ymax: 0 }).map((v) => Math.round(v * 1000) / 1000)).toEqual([
      -8.904, 0,
    ]);
    const [lo, hi] = extent([5, 5]);
    expect(lo < 5 && hi > 5).toBe(true);
    expect(extent([])).toEqual([0, 1]);
    expect(ticks(0, 100, 4)).toEqual([0, 25, 50, 75, 100]);
  });

  it("maps a domain linearly and a flat domain to the range start", () => {
    expect(linear(0, 10, 100, 0)(5)).toBe(50);
    expect(linear(3, 3, 7, 9)(100)).toBe(7);
  });
});

describe("paths", () => {
  it("null values break the line, the area closes to the baseline", () => {
    expect(linePath([[0, 1], [1, 2], null, [3, 4]])).toBe("M0,1L1,2M3,4");
    expect(
      areaPath(
        [
          [0, 10],
          [10, 5],
        ],
        20,
      ),
    ).toBe("M0,10L10,5L10,20L0,20Z");
    expect(areaPath([[0, 1]], 5)).toBe("");
  });

  it("closes a band between an upper and a lower edge", () => {
    expect(
      bandPath(
        [
          [0, 1],
          [2, 3],
        ],
        [
          [0, 5],
          [2, 6],
        ],
      ),
    ).toBe("M0,1L2,3L2,6L0,5Z");
    expect(bandPath([[0, 1]], [[0, 2]])).toBe("");
  });
});

describe("stackLabels", () => {
  it("nudges right labels 13 px apart top to bottom; the stack moves up when it overflows", () => {
    const r = stackLabels([
      { y: 100, k: "a" },
      { y: 105, k: "b" },
      { y: 50, k: "c" },
    ]);
    expect(r.map((x) => [x.k, x.ly])).toEqual([
      ["a", 100],
      ["b", 113],
      ["c", 50],
    ]);
    const over = stackLabels([{ y: 195 }, { y: 198 }], 13, 200);
    expect(over.map((x) => x.ly)).toEqual([187, 200]);
  });
});

describe("donutArcs", () => {
  it("draws one arc per positive value, gaps only between segments, a single value as a full ring", () => {
    const arcs = donutArcs([54.1, 24.5, 0, 16.1, 5.3]);
    expect(arcs).toHaveLength(5);
    expect(arcs[2]).toBeNull();
    expect(arcs.filter((d) => d != null).every((d) => d.startsWith("M") && d.endsWith("Z"))).toBe(
      true,
    );
    const ring = donutArcs([10]);
    expect(ring[0]?.match(/M/g)).toHaveLength(2); // outer + inner circle
    expect(donutArcs([0, 0])).toEqual([null, null]);
  });
});

describe("barLayout", () => {
  it("takes 60 % of the slot capped at 22 px, scales to the plan too, zero bars have no height", () => {
    const { boxes, y } = barLayout([2000, 0, 2500], 300, 120, { plan: 2000 });
    expect(boxes).toHaveLength(3);
    expect(boxes[0]?.w).toBe(22);
    expect(boxes[1]?.h).toBe(0);
    expect((boxes[2]?.h ?? 0) > (boxes[0]?.h ?? 0)).toBe(true);
    expect(y(2000) > 14 && y(2000) < 102).toBe(true);
    const narrow = barLayout([1, 1, 1, 1], 40, 100);
    expect(narrow.boxes[0]?.w).toBe(6);
  });
});

describe("indices", () => {
  it("spreads axis label indices and finds the pointer index", () => {
    expect(labelIndices(52, 5)).toEqual([0, 13, 26, 38, 51]);
    expect(labelIndices(1)).toEqual([0]);
    expect(labelIndices(3, 5)).toEqual([0, 1, 2]);
    expect(nearestIndex(50, 11, 0, 100)).toBe(5);
    expect(nearestIndex(-20, 11, 0, 100)).toBe(0);
    expect(nearestIndex(500, 11, 0, 100)).toBe(10);
  });
});

describe("stackLayers", () => {
  it("stacks assets up from 0 and liabilities down, with the axis min / max", () => {
    const { layers, min, max } = stackLayers(
      [
        { cash: 10, home: 50, loan: -30 },
        { cash: 20, home: 50, loan: -25 },
      ],
      ["cash", "home", "loan"],
    );
    expect(layers.map((l) => [l.key, l.lo, l.hi])).toEqual([
      ["cash", [0, 0], [10, 20]],
      ["home", [10, 20], [60, 70]],
      ["loan", [-30, -25], [0, 0]],
    ]);
    expect([min, max]).toEqual([-30, 70]);
  });
});

describe("area fade (F7 PX1)", () => {
  it("the strong end is the flat opacity x 1.6, capped at 0.35", () => {
    expect(fadeOpacity(0.12)).toBe(0.192);
    expect(fadeOpacity(0.8)).toBe(0.35);
    expect(fadeOpacity(0)).toBe(0);
  });

  it("an area down to the plot bottom fades from the plot top to the plot bottom", () => {
    // plot from y=10 (top) to y=208 (bottom); the default baseline is the bottom of the plot
    expect(areaFade(208, 10, 208)).toEqual({ y1: 10, y2: 208 });
    // a baseline in the lower half (e.g. 0 above the axis minimum) still fades top -> baseline
    expect(areaFade(150, 10, 208)).toEqual({ y1: 10, y2: 150 });
  });

  it("an area hung from a line near the top (drawdown up to 0) fades towards that line", () => {
    expect(areaFade(10, 10, 88)).toEqual({ y1: 88, y2: 10 });
  });
});
