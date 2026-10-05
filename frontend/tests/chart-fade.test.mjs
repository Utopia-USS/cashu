// Area gradient of the line / stacked charts (F7 PX1), run with `npm test`.
import assert from "node:assert/strict";
import { test } from "node:test";
import { areaFade, fadeOpacity } from "../src/chart.ts";

test("the strong end is the flat opacity x 1.6, capped at 0.35", () => {
  assert.equal(fadeOpacity(0.12), 0.192);
  assert.equal(fadeOpacity(0.8), 0.35);
  assert.equal(fadeOpacity(0), 0);
});

test("an area down to the plot bottom fades from the plot top to the plot bottom", () => {
  // plot from y=10 (top) to y=208 (bottom); the default baseline is the bottom of the plot
  assert.deepEqual(areaFade(208, 10, 208), { y1: 10, y2: 208 });
  // a baseline in the lower half (e.g. 0 above the axis minimum) still fades top -> baseline
  assert.deepEqual(areaFade(150, 10, 208), { y1: 10, y2: 150 });
});

test("an area hung from a line near the top (drawdown up to 0) fades towards that line", () => {
  assert.deepEqual(areaFade(10, 10, 88), { y1: 88, y2: 10 });
});
