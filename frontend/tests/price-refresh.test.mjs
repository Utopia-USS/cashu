// P10: the automatic price refresh rules (src/modules/investments/v2/priceRefreshLogic.ts) and the revalidate
// prefix rule (src/swr.ts). Run with `npm test`.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  nextRefreshAt, PRICE_REFRESH_BUSY_RETRY_MS, PRICE_REFRESH_EVERY_MS, refreshDue, storedNewPrices,
} from "../src/modules/investments/v2/priceRefreshLogic.ts";
import { profileScope } from "../src/core/live.ts";
import { ck, onRevalidate, revalidate, underPrefix } from "../src/swr.ts";

test("price refresh: due on open, never hidden or twice at once, then every 15 minutes", () => {
  const now = 1_000_000;
  assert.equal(refreshDue({ running: false, nextAt: 0 }, now, true), true);
  assert.equal(refreshDue({ running: false, nextAt: 0 }, now, false), false);
  assert.equal(refreshDue({ running: true, nextAt: 0 }, now, true), false);
  assert.equal(refreshDue({ running: false, nextAt: now + 1 }, now, true), false);
  assert.equal(PRICE_REFRESH_EVERY_MS, 15 * 60_000);
  assert.equal(nextRefreshAt("ok", now), now + PRICE_REFRESH_EVERY_MS);
  assert.equal(nextRefreshAt("failed", now), now + PRICE_REFRESH_EVERY_MS);
  assert.equal(nextRefreshAt("error", now), now + PRICE_REFRESH_EVERY_MS);
  assert.equal(nextRefreshAt("busy", now), now + PRICE_REFRESH_BUSY_RETRY_MS);
  assert.equal(refreshDue({ running: false, nextAt: nextRefreshAt("disabled", now) }, now + 1e12, true), false);
});

test("price refresh: only a fresh answer with new quotes or rates re-reads the views", () => {
  assert.equal(storedNewPrices({ cached: false, updated: 2, fx_updated: 0 }), true);
  assert.equal(storedNewPrices({ cached: false, updated: 0, fx_updated: 1 }), true);
  assert.equal(storedNewPrices({ cached: true, updated: 5 }), false);
  assert.equal(storedNewPrices({ cached: false, updated: 0 }), false);
  assert.equal(storedNewPrices(null), false);
});

test("revalidate reaches the keyed views under the prefix only", () => {
  assert.equal(underPrefix(ck("jan", "inv", "overview", ""), ck("jan", "inv")), true);
  assert.equal(underPrefix(ck("jan", "investments"), ck("jan", "inv")), false);
  assert.equal(underPrefix(ck("jan", "budget", "x"), profileScope("jan")), true);
  assert.equal(underPrefix(ck("jana", "budget"), profileScope("jan")), false);
  assert.equal(underPrefix(ck("a/b", "inv"), profileScope("a/b")), true);
  const seen = [];
  const off = onRevalidate((p) => seen.push(p));
  revalidate(ck("jan", "inv"));
  off();
  revalidate(ck("jan", "budget"));
  assert.deepEqual(seen, [ck("jan", "inv")]);
});
