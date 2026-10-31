// v2 shared layer: grid ordering (src/grid.ts), run with `npm test`. The chart geometry cases moved with the
// geometry to packages/ui/src/charts/geometry.test.ts.
import assert from "node:assert/strict";
import { test } from "node:test";
import { splitNarrowOrder, twoColumnOrder } from "../src/grid.ts";

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

test("grid: Przegląd after the Majątek merge pairs Majątek with the single before the chart, Kredyty with Subskrypcje (1100)", () => {
  // reading order of the slots (Overview.tsx orders): hero, budget 10, surplus 20, inv summary 30, networth 40,
  // assets 45 (side), loans 50 (side), accounts 70, subs 80
  const r = ordered([
    { id: "hero", span: 3 }, { id: "budget", span: 1 }, { id: "surplus", span: 1 }, { id: "inv", span: 1 },
    { id: "networth", span: 2 }, { id: "assets", span: 1 }, { id: "loans", span: 1 }, { id: "accounts", span: 2 }, { id: "subs", span: 1 },
  ]);
  assert.deepEqual(r.ids, ["hero", "budget", "surplus", "networth", "inv", "assets", "accounts", "loans", "subs"]);
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
