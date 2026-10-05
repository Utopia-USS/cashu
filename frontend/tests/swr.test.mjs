// Stale-while-revalidate cache of useAsync (F7 PX2, src/swr.ts), run with `npm test`.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ck, createCache, scopeOf, swrDone, swrFail, swrInit, swrStart, swrView } from "../src/swr.ts";

test("keys start with the profile slug (their scope); parts are encoded and null-safe", () => {
  assert.equal(ck("jan", "series", "monthly", "total"), "jan/series/monthly/total");
  assert.equal(ck("a/b", "x", null, undefined, 7, true), "a%2Fb/x///7/true");
  assert.equal(scopeOf(ck("jan", "loans")), "jan");
  assert.equal(scopeOf(ck("a/b", "x")), "a%2Fb");
  assert.notEqual(ck("jan", "loans"), ck("ola", "loans"));
});

test("hit and miss; null answers are not stored", () => {
  const c = createCache();
  const k = ck("jan", "loans");
  assert.equal(c.get(k), undefined);
  assert.equal(c.put(k, [1, 2], c.begin()), true);
  assert.deepEqual(c.get(k), { data: [1, 2] });
  assert.deepEqual(c.peek(k), { data: [1, 2] });
  assert.equal(c.put(ck("jan", "x"), null, c.begin()), false);
  assert.equal(c.get(ck("jan", "x")), undefined);
  // a falsy but real answer is stored
  assert.equal(c.put(ck("jan", "n"), 0, c.begin()), true);
  assert.deepEqual(c.get(ck("jan", "n")), { data: 0 });
});

test("LRU: the least recently used entry goes first; get refreshes recency, peek does not", () => {
  const c = createCache(3);
  for (const n of ["a", "b", "c"]) c.put(ck("jan", n), n, c.begin());
  c.get(ck("jan", "a")); // a is now the newest
  c.peek(ck("jan", "b")); // no effect on the order
  c.put(ck("jan", "d"), "d", c.begin());
  assert.equal(c.size, 3);
  assert.equal(c.get(ck("jan", "b")), undefined);
  assert.deepEqual(["a", "c", "d"].map((n) => c.get(ck("jan", n))?.data), ["a", "c", "d"]);
});

test("profile switch clears everything; another profile's key is never served or stored", () => {
  const c = createCache();
  c.setScope("jan");
  c.put(ck("jan", "loans"), ["jan's"], c.begin());
  c.setScope("jan"); // same profile: nothing happens
  assert.deepEqual(c.get(ck("jan", "loans")), { data: ["jan's"] });
  assert.equal(c.put(ck("ola", "loans"), ["ola's"], c.begin()), false);
  c.setScope("ola");
  assert.equal(c.size, 0);
  assert.equal(c.get(ck("jan", "loans")), undefined);
  assert.equal(c.peek(ck("jan", "loans")), undefined);
});

test("a fetch started before a clear or an invalidate never stores its older answer", () => {
  const c = createCache();
  const k = ck("jan", "summary");
  const before = c.begin();
  c.clear(); // 401, or the shell's refresh after a write
  assert.equal(c.put(k, "old", before), false);
  assert.equal(c.put(k, "new", c.begin()), true);
  const inflight = c.begin();
  c.invalidate(ck("jan", "summary"));
  assert.equal(c.get(k), undefined);
  assert.equal(c.put(k, "old", inflight), false);
});

test("a slower older fetch does not overwrite a newer answer of the same key", () => {
  const c = createCache();
  const k = ck("jan", "x");
  const t1 = c.begin(), t2 = c.begin();
  c.put(k, "second", t2);
  assert.equal(c.put(k, "first", t1), false);
  assert.deepEqual(c.get(k), { data: "second" });
});

test("invalidate drops the prefix and the keys under it, not a sibling with a longer name", () => {
  const c = createCache();
  for (const k of [ck("jan", "budget"), ck("jan", "budget", "m", 1), ck("jan", "budgetx"), ck("jan", "loans")]) c.put(k, 1, c.begin());
  assert.equal(c.invalidate(ck("jan", "budget")), 2);
  assert.ok(c.get(ck("jan", "budgetx")));
  assert.ok(c.get(ck("jan", "loans")));
});

test("hook state: a mount with cached data shows it without a loader, refreshes and swaps the answer", () => {
  const c = createCache();
  const k = ck("jan", "loans");
  assert.deepEqual(swrView(c, swrInit(c, k), k), { data: null, error: null, loading: true, refreshing: false });
  c.put(k, "cached", c.begin());
  let st = swrStart(c, swrInit(c, k), k);
  assert.deepEqual(swrView(c, st, k), { data: "cached", error: null, loading: false, refreshing: true });
  st = swrDone(k, "fresh");
  assert.deepEqual(swrView(c, st, k), { data: "fresh", error: null, loading: false, refreshing: false });
});

test("hook state: a failed refresh keeps the data and sets the error; a reload keeps the data visible", () => {
  const c = createCache();
  const k = ck("jan", "loans");
  c.put(k, "cached", c.begin());
  let st = swrStart(c, swrInit(c, k), k);
  st = swrFail(c, st, k, "Nie udało się");
  assert.deepEqual(swrView(c, st, k), { data: "cached", error: "Nie udało się", loading: false, refreshing: false });
  st = swrStart(c, st, k); // reload(): same key
  assert.deepEqual(swrView(c, st, k), { data: "cached", error: null, loading: false, refreshing: true });
  // a first load that fails: no data, the error, no loader
  const k2 = ck("jan", "other");
  const st2 = swrFail(c, swrStart(c, swrInit(c, k2), k2), k2, "boom");
  assert.deepEqual(swrView(c, st2, k2), { data: null, error: "boom", loading: false, refreshing: false });
});

test("hook state: a key change shows the new key's cache, else nothing (a loader), never the previous key's numbers", () => {
  const c = createCache();
  const jan = ck("jan", "budget", "monthclose", "2026-09"), janOct = ck("jan", "budget", "monthclose", "2026-10");
  const st = swrDone(jan, "september");
  // nothing cached for October: no September numbers under the October label, a loader until the answer
  assert.deepEqual(swrView(c, st, janOct), { data: null, error: null, loading: true, refreshing: false });
  assert.equal(swrStart(c, st, janOct).data, null);
  // October cached: shown at once, refreshed in the background
  c.put(janOct, "october", c.begin());
  assert.deepEqual(swrView(c, st, janOct), { data: "october", error: null, loading: false, refreshing: true });
  assert.equal(swrStart(c, st, janOct).data, "october");
  // the error of the previous key does not follow a key change
  assert.equal(swrView(c, swrFail(c, st, jan, "x"), janOct).error, null);
});

test("hook state, keepPrevious (opt-in): the previous key's data stays until the answer, only within one profile", () => {
  const c = createCache();
  const jan = ck("jan", "series", "monthly"), janW = ck("jan", "series", "weekly"), ola = ck("ola", "series", "monthly");
  const st = swrDone(jan, "jan monthly");
  assert.deepEqual(swrView(c, st, janW, true), { data: "jan monthly", error: null, loading: false, refreshing: true });
  assert.equal(swrStart(c, st, janW, true).data, "jan monthly");
  assert.equal(swrFail(c, swrStart(c, st, janW, true), janW, "boom", true).data, "jan monthly");
  // a cache entry of the new key still wins
  c.put(janW, "jan weekly", c.begin());
  assert.equal(swrView(c, st, janW, true).data, "jan weekly");
  // another profile: never, even with keepPrevious
  assert.deepEqual(swrView(c, st, ola, true), { data: null, error: null, loading: true, refreshing: false });
  assert.equal(swrStart(c, st, ola, true).data, null);
});

test("hook state without a key keeps the old useAsync behaviour", () => {
  const c = createCache();
  let st = swrInit(c, undefined);
  assert.deepEqual(swrView(c, st, undefined), { data: null, error: null, loading: true, refreshing: false });
  st = swrDone(undefined, 1);
  st = swrStart(c, st, undefined); // deps change / reload: data stays, loading again
  assert.deepEqual(swrView(c, st, undefined), { data: 1, error: null, loading: true, refreshing: true });
  st = swrFail(c, st, undefined, "e");
  assert.deepEqual(swrView(c, st, undefined), { data: 1, error: "e", loading: false, refreshing: false });
});

// ---- request dedupe below the cache (F7 FIX2 B4) ----------------------------------------------------------
import { clearCache, createDedupe, dedupe, invalidate as invalidateApp } from "../src/swr.ts";

test("dedupe: one promise per key within the ttl; a failed one is dropped; the ttl ends it", async () => {
  let t = 0;
  const c = createCache();
  const d = createDedupe(c, 4000, () => t);
  let loads = 0;
  const load = () => { loads += 1; return Promise.resolve(loads); };
  const a = d.get("jan:PLN", load), b = d.get("jan:PLN", load);
  assert.equal(a, b);
  assert.equal(loads, 1);
  t = 4001;
  assert.notEqual(d.get("jan:PLN", load), a);
  assert.equal(loads, 2);
  const failing = d.get("x", () => Promise.reject(new Error("boom")));
  await assert.rejects(failing);
  assert.notEqual(d.get("x", load), failing);
  d.clear();
  d.get("jan:PLN", load);
  assert.equal(loads, 4);
});

test("dedupe: a promise begun before a cache clear or an invalidate is never handed out after it", () => {
  const c = createCache();
  const d = createDedupe(c);
  let loads = 0;
  const load = () => { loads += 1; return new Promise(() => {}); };
  const before = d.get("jan:PLN", load);
  c.clear(); // ctx.refresh after a write, a profile switch, a 401
  const afterClear = d.get("jan:PLN", load);
  assert.notEqual(afterClear, before);
  c.invalidate(ck("jan", "budget"));
  assert.notEqual(d.get("jan:PLN", load), afterClear);
  c.setScope("ola");
  d.get("jan:PLN", load);
  assert.equal(loads, 4);
});

test("dedupe of the app cache: clearCache and invalidate reset it", () => {
  const d = dedupe();
  let loads = 0;
  const load = () => { loads += 1; return new Promise(() => {}); };
  const p = d.get("k", load);
  assert.equal(d.get("k", load), p);
  clearCache();
  const q = d.get("k", load);
  assert.notEqual(q, p);
  invalidateApp(ck("jan", "inv"));
  assert.notEqual(d.get("k", load), q);
  assert.equal(loads, 3);
});
