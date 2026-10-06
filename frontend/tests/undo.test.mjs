// Immediate save + server-side undo (F5 R4): one undo per saved change, the 15-minute window, a 409
// from the server read as "too late", a failed request retryable; and the toast stack (several toasts,
// each with its own undo). Run with `npm test`.
import assert from "node:assert/strict";
import { test } from "node:test";
import { canUndo, groupUndoRun, isExpired, makeUndo, UNDO_WINDOW_MS, undoFailure, undoMessage, undoSettled } from "../src/modules/investments/undo.ts";
import { dropToast, MAX_TOASTS, pushToast } from "../src/toasts.ts";

test("an undo runs the server request at most once", async () => {
  let calls = 0;
  const undo = makeUndo(1000, async () => { calls += 1; }, () => 2000);
  assert.equal(undo.state, "ready");
  assert.equal(await undo.undo(), "done");
  assert.equal(await undo.undo(), "already");
  assert.equal(calls, 1);
  assert.equal(undo.state, "done");
});

test("a second click while the request runs does not send another one", async () => {
  let release;
  let calls = 0;
  const undo = makeUndo(0, () => { calls += 1; return new Promise((r) => { release = r; }); }, () => 0);
  const first = undo.undo();
  assert.equal(await undo.undo(), "busy");
  release();
  assert.equal(await first, "done");
  assert.equal(calls, 1);
});

test("after 15 minutes the undo is not sent at all", async () => {
  let calls = 0;
  const undo = makeUndo(0, async () => { calls += 1; }, () => UNDO_WINDOW_MS + 1);
  assert.equal(await undo.undo(), "expired");
  assert.equal(calls, 0);
  assert.match(undoMessage("expired", "decyzja"), /Za późno na cofnięcie: minęło 15 minut/);
});

test("a 409 from the server means too late; other failures can be retried", async () => {
  const late = makeUndo(0, async () => { throw Object.assign(new Error("undo_expired"), { status: 409 }); }, () => 0);
  assert.equal(await late.undo(), "expired");
  assert.equal(late.state, "expired");
  let attempts = 0;
  const flaky = makeUndo(0, async () => { attempts += 1; if (attempts === 1) throw Object.assign(new Error("offline"), { status: 0 }); }, () => 0);
  assert.equal(await flaky.undo(), "failed");
  assert.equal(flaky.state, "ready");
  assert.equal(await flaky.undo(), "done");
  assert.equal(attempts, 2);
  assert.ok(isExpired({ status: 409 }) && !isExpired({ status: 500 }) && !isExpired(null));
  assert.equal(undoMessage("done", "przegląd"), "Cofnięto: przegląd");
  assert.equal(undoMessage("already", "x"), null);
});

test("F7 FE15: a 404 means already undone (no Cofnij again), other 4xx are final, network / 5xx retry", async () => {
  const err = (status) => Object.assign(new Error("x"), { status });
  let calls = 0;
  const gone = makeUndo(0, async () => { calls += 1; throw err(404); }, () => 0);
  assert.equal(await gone.undo(), "gone");
  assert.equal(gone.state, "done");
  assert.equal(await gone.undo(), "already");
  assert.equal(calls, 1);
  assert.equal(undoMessage("gone", "decyzja"), "Już cofnięte: decyzja");
  assert.ok(undoSettled("gone") && undoSettled("done") && !undoSettled("failed") && !undoSettled("refused"));
  const refused = makeUndo(0, async () => { calls += 1; throw err(401); }, () => 0);
  assert.equal(await refused.undo(), "refused");
  assert.equal(await refused.undo(), "refused");
  assert.equal(calls, 2);
  assert.equal(undoMessage("refused", "przegląd"), "Nie da się cofnąć: przegląd");
  assert.deepEqual([404, 410, 400, 403, 422, 408, 429, 500, 503].map((s) => undoFailure(err(s))),
    ["gone", "gone", "refused", "refused", "refused", "retry", "retry", "retry", "retry"]);
  assert.equal(undoFailure(new TypeError("Failed to fetch")), "retry");
  assert.equal(undoFailure(err(409)), "expired");
});

test("toasts stack: a new toast never removes another one's undo", () => {
  const undo = (id) => ({ id, text: `Zapisano ${id}`, action: { label: "Cofnij", onClick: () => {} } });
  let list = [];
  list = pushToast(list, undo(1));
  list = pushToast(list, undo(2));
  assert.deepEqual(list.map((t) => t.id), [1, 2]);
  list = pushToast(list, { id: 3, text: "Skopiowano" });
  list = pushToast(list, undo(4));
  assert.equal(list.length, MAX_TOASTS);
  // over the limit the oldest toast without an action goes first
  list = pushToast(list, undo(5));
  assert.deepEqual(list.map((t) => t.id), [1, 2, 4, 5]);
  // all with an action: the oldest goes
  list = pushToast(list, undo(6));
  assert.deepEqual(list.map((t) => t.id), [2, 4, 5, 6]);
  assert.deepEqual(dropToast(list, 4).map((t) => t.id), [2, 5, 6]);
});

test("the undo link shows only for a saved decision inside the window", () => {
  const saved = Date.parse("2026-10-05T03:13:11.439831+00:00");
  const d = { id: 7, created_at: "2026-10-05T03:13:11.439831+00:00" };
  assert.ok(canUndo(d, saved + 60_000));
  assert.ok(!canUndo(d, saved + UNDO_WINDOW_MS + 1));
  assert.ok(!canUndo({ id: -7, created_at: d.created_at }, saved)); // a decision still being saved
  assert.ok(!canUndo({ id: 7, created_at: null }, saved));
});

test("F7 FE14: toast timers pause while the owner is on the stack and resume with the time left", async () => {
  const { toastTimers } = await import("../src/toasts.ts");
  let t = 0;
  const pending = new Map();
  let seq = 0;
  const schedule = (fn, ms) => { const h = ++seq; pending.set(h, { fn, at: t + ms }); return h; };
  const cancel = (h) => pending.delete(h);
  const advance = (ms) => { t += ms; for (const [h, p] of [...pending]) if (p.at <= t) { pending.delete(h); p.fn(); } };
  const expired = [];
  const timers = toastTimers((id) => expired.push(id), schedule, cancel, () => t);
  timers.start(1, 10000);
  advance(4000);
  timers.pause();
  advance(60000); // the owner reads the toast for a minute
  assert.deepEqual(expired, []);
  assert.equal(timers.left(1), 6000);
  timers.resume();
  advance(5999);
  assert.deepEqual(expired, []);
  advance(1);
  assert.deepEqual(expired, [1]);
  timers.start(2, 1000);
  timers.stop(2);
  advance(5000);
  assert.deepEqual(expired, [1]);
});

test("a group undo retry deletes only what is left (F8 review FE-3)", async () => {
  const deleted = [];
  let failOnce = true;
  const del = async (id) => {
    if (deleted.includes(id)) throw Object.assign(new Error("not found"), { status: 404 });
    if (id === 2 && failOnce) { failOnce = false; throw Object.assign(new Error("offline"), { status: 503 }); }
    deleted.push(id);
  };
  const undo = makeUndo(1000, groupUndoRun([1, 2, 3], del), () => 2000);
  assert.equal(await undo.undo(), "failed");
  assert.deepEqual(deleted, [1]);
  assert.equal(await undo.undo(), "done");
  assert.deepEqual(deleted, [1, 2, 3]);
});

test("a group undo treats an id already gone as undone and stops on a final refusal", async () => {
  const seen = [];
  const run = groupUndoRun([7, 8], async (id) => { seen.push(id); if (id === 7) throw Object.assign(new Error("gone"), { status: 410 }); });
  await run();
  assert.deepEqual(seen, [7, 8]);
  const refused = groupUndoRun([1, 2], async (id) => { if (id === 1) throw Object.assign(new Error("no"), { status: 403 }); });
  await assert.rejects(refused(), (e) => e.status === 403);
});
