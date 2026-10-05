// v2 shared layer: grid ordering (src/grid.ts) and chart geometry (src/chart.ts), run with `npm test`.
import assert from "node:assert/strict";
import { test } from "node:test";
import { splitNarrowOrder, twoColumnOrder } from "../src/grid.ts";
import { areaPath, barLayout, donutArcs, extent, labelIndices, linePath, nearestIndex, sparkline, stackLabels, ticks } from "../src/chart.ts";

const ordered = (slots) => {
  const { order, alone } = twoColumnOrder(slots);
  return { ids: [...order.entries()].sort((a, b) => a[1] - b[1]).map(([id]) => id), alone: [...alone] };
};

test("grid: two-column order of the investments home matches the 1100 mock", () => {
  // 3-col reading order: [signals 2, alerts 1] [value 2, alloc 1] [assets 2, watch 1] [dd, contrib, accts]
  const r = ordered([
    { id: "hero", span: 3 }, { id: "signals", span: 2 }, { id: "alerts", span: 1 }, { id: "value", span: 2 }, { id: "alloc", span: 1 },
    { id: "assets", span: 2 }, { id: "watch", span: 1 }, { id: "dd", span: 1 }, { id: "contrib", span: 1 }, { id: "accts", span: 1 },
  ]);
  assert.deepEqual(r.ids, ["hero", "signals", "value", "alerts", "alloc", "assets", "watch", "dd", "contrib", "accts"]);
  assert.deepEqual(r.alone, []);
});

test("split: below 900 px Sygnały and Alerty first, then the main column, then Obserwowane (signals-rail.md 1)", () => {
  const o = splitNarrowOrder(["value", "alloc", "assets"], ["signals", "alerts", "watch"]);
  assert.deepEqual([...o.entries()].sort((a, b) => a[1] - b[1]).map(([id]) => id), ["signals", "alerts", "value", "alloc", "assets", "watch"]);
  assert.equal(o.get("signals"), 1);
  assert.equal(o.get("watch"), 6);
  // a shorter rail keeps its widgets on top; an empty one leaves the main order
  assert.deepEqual([...splitNarrowOrder(["a", "b"], ["r"]).entries()], [["r", 1], ["a", 2], ["b", 3]]);
  assert.deepEqual([...splitNarrowOrder(["a"], []).entries()], [["a", 1]]);
});

test("split: the home grid around the split cell keeps the two-column pairing", () => {
  const r = ordered([{ id: "hero", span: 3 }, { id: "research", span: 3, defer: true }, { id: "split", span: 3 }, { id: "dd", span: 1 }, { id: "contrib", span: 1 }, { id: "accounts", span: 1 }]);
  assert.deepEqual(r.ids, ["hero", "research", "split", "dd", "contrib", "accounts"]);
  assert.deepEqual(r.alone, ["accounts"]);
});

test("grid: singles pair up in reading order, a leftover single spans the row, wide ones keep order", () => {
  const r = ordered([{ id: "a", span: 1 }, { id: "w1", span: 2 }, { id: "b", span: 1 }, { id: "c", span: 1 }, { id: "w2", span: 3 }, { id: "d", span: 1 }]);
  assert.deepEqual(r.ids, ["w1", "a", "b", "w2", "c", "d"]);
  assert.deepEqual(r.alone, []);
  const odd = ordered([{ id: "a", span: 1 }, { id: "w", span: 2 }, { id: "b", span: 1 }, { id: "c", span: 1 }]);
  assert.deepEqual(odd.ids, ["w", "a", "b", "c"]);
  assert.deepEqual(odd.alone, ["c"]);
  assert.deepEqual(ordered([]).ids, []);
});

test("sparkline: scaled into 72 x 22 with 2 px margins, tone from first vs last, flat and short series", () => {
  const g = sparkline([10, 12, 11, 14]);
  assert.equal(g.tone, "pos");
  assert.ok(g.d.startsWith("M0,"));
  assert.deepEqual(g.last, [72, 2]); // max at the top margin
  const low = sparkline([14, 10]);
  assert.equal(low.tone, "neg");
  assert.deepEqual(low.last, [72, 20]); // min at the bottom margin
  const flat = sparkline([5, 5, 5]);
  assert.equal(flat.tone, "flat");
  assert.deepEqual(flat.last, [72, 11]);
  assert.equal(sparkline([3]).d, "");
  assert.equal(sparkline([null, 4, undefined, 6]).tone, "pos"); // gaps dropped
});

test("extent pads 6 %, pins ymax / ymin, never collapses", () => {
  assert.deepEqual(extent([0, 100]), [-6, 106]);
  assert.deepEqual(extent([-8.4, 0], { ymax: 0 }).map((v) => Math.round(v * 1000) / 1000), [-8.904, 0]);
  const [lo, hi] = extent([5, 5]);
  assert.ok(lo < 5 && hi > 5);
  assert.deepEqual(extent([]), [0, 1]);
  assert.deepEqual(ticks(0, 100, 4), [0, 25, 50, 75, 100]);
});

test("paths: null values break the line, area closes to the baseline", () => {
  assert.equal(linePath([[0, 1], [1, 2], null, [3, 4]]), "M0,1L1,2M3,4");
  assert.equal(areaPath([[0, 10], [10, 5]], 20), "M0,10L10,5L10,20L0,20Z");
  assert.equal(areaPath([[0, 1]], 5), "");
});

test("right labels: nudged 13 px apart top to bottom, the stack moves up when it overflows", () => {
  const r = stackLabels([{ y: 100, k: "a" }, { y: 105, k: "b" }, { y: 50, k: "c" }]);
  assert.deepEqual(r.map((x) => [x.k, x.ly]), [["a", 100], ["b", 113], ["c", 50]]);
  const over = stackLabels([{ y: 195 }, { y: 198 }], 13, 200);
  assert.deepEqual(over.map((x) => x.ly), [187, 200]);
});

test("donut: one arc per positive value, gaps only between segments, a single value is a full ring", () => {
  const arcs = donutArcs([54.1, 24.5, 0, 16.1, 5.3]);
  assert.equal(arcs.length, 5);
  assert.equal(arcs[2], null);
  assert.ok(arcs.filter(Boolean).every((d) => d.startsWith("M") && d.endsWith("Z")));
  const ring = donutArcs([10]);
  assert.equal((ring[0].match(/M/g) || []).length, 2); // outer + inner circle
  assert.deepEqual(donutArcs([0, 0]), [null, null]);
});

test("bars: 60 % of the slot capped at 22 px, scale includes the plan, zero bars have no height", () => {
  const { boxes, y } = barLayout([2000, 0, 2500], 300, 120, { plan: 2000 });
  assert.equal(boxes.length, 3);
  assert.equal(boxes[0].w, 22);
  assert.equal(boxes[1].h, 0);
  assert.ok(boxes[2].h > boxes[0].h);
  assert.ok(y(2000) > 14 && y(2000) < 102);
  const narrow = barLayout([1, 1, 1, 1], 40, 100);
  assert.equal(narrow.boxes[0].w, 6);
});

test("axis label indices and pointer index", () => {
  assert.deepEqual(labelIndices(52, 5), [0, 13, 26, 38, 51]);
  assert.deepEqual(labelIndices(1), [0]);
  assert.deepEqual(labelIndices(3, 5), [0, 1, 2]);
  assert.equal(nearestIndex(50, 11, 0, 100), 5);
  assert.equal(nearestIndex(-20, 11, 0, 100), 0);
  assert.equal(nearestIndex(500, 11, 0, 100), 10);
});
