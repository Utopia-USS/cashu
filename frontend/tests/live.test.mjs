// P10 live data, pure part (src/core/live.ts) and the cache patches (src/swr.ts). Run with `npm test`.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createBatcher, fresh, invalidations, LIVE_DEBOUNCE_MS, LIVE_POLL_MS, listPatches, parseSse, profileScope, reconnectDelay, removeId, runStateOf, upsert,
} from "../src/core/live.ts";
import { ck, onPatched, patchCache, swr } from "../src/swr.ts";

const ev = (over) => ({ id: 1, entity: "note", op: "add", ref: "7", profile: "jan", payload: null, ...over });
const inv = (...p) => ck("jan", "inv", ...p);

test("SSE frames: events, ids, multi-line data, comments, a split chunk", () => {
  const a = parseSse("retry: 3000\n\nevent: hello\ndata: {\"last_id\":4}\n\n: keepalive\n\nid: 5\nevent: change\ndata: {\"id\":5}\n\nid: 6\nevent: cha");
  assert.deepEqual(a.frames, [
    { event: "hello", data: "{\"last_id\":4}", id: null },
    { event: "change", data: "{\"id\":5}", id: "5" },
  ]);
  const b = parseSse(a.rest + "nge\ndata: {\"id\":6}\n\n");
  assert.deepEqual(b.frames, [{ event: "change", data: "{\"id\":6}", id: "6" }]);
  assert.equal(b.rest, "");
  assert.deepEqual(parseSse("data: a\ndata: b\n\n").frames, [{ event: "message", data: "a\nb", id: null }]);
});

test("timing constants, reconnect backoff, run state", () => {
  assert.equal(LIVE_POLL_MS, 60_000);
  assert.equal(LIVE_DEBOUNCE_MS, 500);
  assert.deepEqual([1, 2, 3, 4, 9].map(reconnectDelay), [3000, 6000, 12000, 24000, 30000]);
  assert.deepEqual(runStateOf(ev({ entity: "run", op: "add" })), { running: true, status: null });
  assert.deepEqual(runStateOf(ev({ entity: "run", op: "update", payload: { status: "partial" } })), { running: false, status: "partial" });
  assert.equal(runStateOf(ev()), null);
});

test("fresh: once each, in id order, after the last seen id", () => {
  const list = [ev({ id: 9 }), ev({ id: 7 }), ev({ id: 8 })];
  assert.deepEqual(fresh(list, 7).map((e) => e.id), [8, 9]);
  assert.deepEqual(fresh(list, null).map((e) => e.id), [7, 8, 9]);
});

test("batcher: a burst lands once, 500 ms after its first event", () => {
  const timers = []; const flushed = [];
  const fake = { set: (f, ms) => { timers.push({ f, ms }); return timers.length; }, clear: () => {} };
  const b = createBatcher((items) => flushed.push(items), 500, fake);
  b.push(1); b.push(2, 3); b.push(4);
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, 500);
  timers[0].f();
  assert.deepEqual(flushed, [[1, 2, 3, 4]]);
  b.push(5); b.flushNow();
  assert.deepEqual(flushed, [[1, 2, 3, 4], [5]]);
});

test("reducers: upsert in place, add front or back, drop when the list's filter says so", () => {
  const list = [{ id: 1, v: "a" }, { id: 2, v: "b" }];
  assert.deepEqual(upsert(list, { id: 2, v: "B" }, true), [{ id: 1, v: "a" }, { id: 2, v: "B" }]);
  assert.deepEqual(upsert(list, { id: 3, v: "c" }, true), [...list, { id: 3, v: "c" }]);
  assert.deepEqual(upsert(list, { id: 3, v: "c" }, true, true), [{ id: 3, v: "c" }, ...list]);
  assert.deepEqual(upsert(list, { id: 1, v: "a" }, false), [{ id: 2, v: "b" }]);
  assert.equal(upsert(list, { id: 9 }, false), undefined);
  assert.deepEqual(removeId(list, 1), [{ id: 2, v: "b" }]);
  assert.equal(removeId(list, 9), undefined);
  assert.equal(upsert(null, { id: 1 }, true), undefined);
});

test("list patches follow each cached list's own filter", () => {
  const day = "2026-10-09";
  const note = { id: 7, instrument_id: 3, segment: "energy", dismissed_at: null, expires_at: "2026-12-01" };
  const apply = (e, key, data) => { for (const p of listPatches("jan", e, day)) if (p.match(key)) data = p.apply(key, data) ?? data; return data; };
  const add = ev({ payload: { item: note } });
  assert.deepEqual(apply(add, inv("research", "notes", "default"), []), [note]);
  assert.deepEqual(apply(add, inv("research", "instrument", 3), []), [note]);
  assert.deepEqual(apply(add, inv("research", "instrument", 4), []), []);
  assert.deepEqual(apply(add, inv("research", "topic", "energy"), []), [note]);
  const gone = { ...note, dismissed_at: "2026-10-09T10:00:00" };
  const dismiss = ev({ op: "update", payload: { item: gone } });
  assert.deepEqual(apply(dismiss, inv("research", "notes", "default"), [note]), []); // the strip hides dismissed
  assert.deepEqual(apply(dismiss, inv("research", "notes", "all"), [note]), [gone]);
  const old = { ...note, expires_at: "2026-10-01" };
  assert.deepEqual(apply(ev({ op: "update", payload: { item: old } }), inv("research", "notes", "live"), [note]), []);
  // proposals: only pending investments kinds stay in the pending list
  const prop = { id: 4, status: "pending", kind: "strategy" };
  const pk = inv("proposals", "pending");
  assert.deepEqual(apply(ev({ entity: "proposal", ref: "4", payload: { item: prop } }), pk, []), [prop]);
  assert.deepEqual(apply(ev({ entity: "proposal", ref: "4", op: "update", payload: { item: { ...prop, status: "approved" } } }), pk, [prop]), []);
  // watchlist / alerts: remove by ref
  const w = inv("watchlist");
  assert.deepEqual(apply(ev({ entity: "watchlist", op: "remove", ref: "5" }), w, [{ id: 5 }, { id: 6 }]), [{ id: 6 }]);
  assert.deepEqual(listPatches("jan", ev({ entity: "watchlist", ref: null })), []);
});

test("targeted invalidation map", () => {
  const research = (...p) => inv("research", ...p);
  assert.ok(invalidations("jan", ev({ entity: "topic_thesis" })).includes(research("topic-thesis")));
  assert.ok(invalidations("jan", ev({ entity: "segment_assignment" })).includes(research("segments")));
  const prices = invalidations("jan", ev({ entity: "prices", ref: null }));
  for (const k of [inv("overview"), inv("positions"), research("segments"), ck("jan", "networth"), ck("jan", "summary")]) assert.ok(prices.includes(k), k);
  assert.ok(!prices.includes(inv("signals")));
  assert.deepEqual(invalidations("jan", ev({ entity: "run", op: "add" })), []);
  assert.ok(invalidations("jan", ev({ entity: "run", op: "update" })).includes(inv()));
  // a list row with a ref is patched, not re-read; a bulk change (no ref) re-reads the list
  assert.ok(!invalidations("jan", ev({ entity: "watchlist" })).includes(inv("watchlist")));
  assert.ok(invalidations("jan", ev({ entity: "watchlist", ref: null })).includes(inv("watchlist")));
  assert.deepEqual(invalidations("jan", ev({ entity: "unknown" })), [profileScope("jan")]);
  assert.ok(invalidations("jan", ev({ entity: "signal" })).includes(inv("signals")));
});

test("patchCache replaces the cached list and tells the mounted views; an older fetch never overwrites it", () => {
  swr.setScope("jan");
  const k = inv("watchlist");
  const ticket = swr.begin(); // a fetch started before the push
  assert.equal(swr.put(k, [{ id: 1 }], swr.begin()), true);
  const seen = [];
  const off = onPatched((key, data) => seen.push([key, data]));
  const changed = patchCache((key) => key === k, (_key, data) => upsert(data, { id: 2 }, true));
  off();
  assert.deepEqual(changed, [k]);
  assert.deepEqual(seen, [[k, [{ id: 1 }, { id: 2 }]]]);
  assert.equal(swr.put(k, [{ id: 1 }], ticket), false);
  assert.deepEqual(swr.peek(k).data, [{ id: 1 }, { id: 2 }]);
  assert.deepEqual(patchCache((key) => key === k, () => undefined), []);
});
