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

// F7 fix pass F1: the row stays locked after a successful write until the reload shows the new state.
import { stillLocked } from "../src/inflight.ts";
import { signalStateKey } from "../src/modules/investments/v2/logic.ts";

test("post-write lock holds until the signal state changes (decision, snooze), not when the POST answers", async () => {
  const g = singleFlight();
  const open = { status: "active", decisions: [], snoozed: false };
  let lock = null, posts = 0;
  const click = (s) => (stillLocked(lock, signalStateKey(s)) ? undefined : g.run(async () => { posts += 1; lock = signalStateKey(s); }));
  await click(open);
  // the POST answered, the reload has not landed yet: a second click is ignored
  assert.equal(g.busy, false);
  assert.equal(stillLocked(lock, signalStateKey(open)), true);
  assert.equal(await click(open), undefined);
  assert.equal(posts, 1);
  // the reload brings the decision: the key changed, the lock is gone
  const decided = { ...open, status: "acknowledged", decisions: [{ id: 7 }] };
  assert.equal(stillLocked(lock, signalStateKey(decided)), false);
  // snooze changes the key too
  assert.notEqual(signalStateKey({ ...open, snoozed: true, snoozed_until: "2026-10-12" }), signalStateKey(open));
  assert.equal(stillLocked(null, signalStateKey(open)), false);
});
