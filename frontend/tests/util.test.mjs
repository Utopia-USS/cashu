// Pure helpers of the SPA (no React, no DOM), run with `npm test` (node --test;
// Node >= 23.6 strips the TypeScript types itself, no extra dependency).
import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeSegment, serialSaver } from "../src/core/util.ts";

/** A save function whose calls resolve only when the test says so. */
function controlledSave() {
  const calls = [];
  const save = (value) => new Promise((resolve, reject) => calls.push({ value, resolve, reject }));
  return { calls, save };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

test("R-05: one save at a time, the latest requested value is always sent last", async () => {
  const { calls, save } = controlledSave();
  const idle = [];
  const saver = serialSaver(save, (err) => idle.push(err));
  saver.push(["budget", "loans"]);           // enable loans
  saver.push(["budget", "loans", "assets"]); // enable assets before the first save returns
  saver.push(["budget", "assets"]);          // and disable loans again, still in flight
  assert.equal(calls.length, 1);
  assert.equal(saver.busy, true);
  calls[0].resolve();
  await tick();
  assert.deepEqual(calls.map((c) => c.value), [["budget", "loans"], ["budget", "assets"]]);
  calls[1].resolve();
  await tick();
  assert.equal(calls.length, 2);
  assert.equal(saver.busy, false);
  assert.deepEqual(idle, [null]);
});

test("R-05: no toggle is lost when it arrives while the saver reports idle work", async () => {
  const { calls, save } = controlledSave();
  let once = true;
  const saver = serialSaver(save, () => { if (once) { once = false; saver.push(["late"]); } });
  saver.push(["first"]);
  calls[0].resolve();
  await tick();
  assert.deepEqual(calls.map((c) => c.value), [["first"], ["late"]]);
});

test("R-05: a failed save drops what is pending and reports the error", async () => {
  const { calls, save } = controlledSave();
  const idle = [];
  const saver = serialSaver(save, (err) => idle.push(err));
  saver.push(["a"]);
  saver.push(["b"]);
  calls[0].reject(new Error("boom"));
  await tick();
  assert.equal(calls.length, 1);
  assert.equal(idle.length, 1);
  assert.equal(idle[0].message, "boom");
  assert.equal(saver.busy, false);
});

test("R-09: a malformed hash segment does not throw", () => {
  assert.equal(decodeSegment("jan"), "jan");
  assert.equal(decodeSegment("jakub%20%C5%82"), "jakub ł");
  assert.equal(decodeSegment("%zz"), null);
  assert.equal(decodeSegment("%E0%A4%A"), null);
});
