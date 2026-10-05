// In-flight guard (F7 FE2): a double click on a submit button sends one request. Run with `npm test`.
import assert from "node:assert/strict";
import { test } from "node:test";
import { singleFlight } from "../src/inflight.ts";

test("a second run while the first is in flight is skipped; afterwards a new run goes through", async () => {
  const states = [];
  const g = singleFlight((b) => states.push(b));
  let release, calls = 0;
  const first = g.run(() => { calls += 1; return new Promise((r) => { release = r; }); });
  assert.equal(g.busy, true);
  assert.equal(await g.run(async () => { calls += 1; return "second"; }), undefined);
  release("first");
  assert.equal(await first, "first");
  assert.equal(g.busy, false);
  assert.equal(await g.run(async () => { calls += 1; return "third"; }), "third");
  assert.equal(calls, 2);
  assert.deepEqual(states, [true, false, true, false]);
});

test("a failing run releases the guard and rethrows", async () => {
  const g = singleFlight();
  await assert.rejects(g.run(async () => { throw new Error("boom"); }), /boom/);
  assert.equal(g.busy, false);
  assert.equal(await g.run(async () => 1), 1);
});
