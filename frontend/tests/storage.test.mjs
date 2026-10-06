// Browser storage keys after the rename (src/core/storage.ts): a `finanse.*` key (legacy name) is read
// once, moved to its `cashu.*` key and removed. Run with `npm test`.
import assert from "node:assert/strict";
import { test } from "node:test";
import { legacyKey, readStored } from "../src/core/storage.ts";

function memory(entries = {}) {
  const m = new Map(Object.entries(entries));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), m };
}

test("the new key wins and the old one is left alone", () => {
  const s = memory({ "cashu.theme": "dark", "finanse.theme": "light" });
  assert.equal(readStored(s, "cashu.theme"), "dark");
  assert.equal(s.m.get("finanse.theme"), "light");
});

test("an old key is moved to the new key once", () => {
  const s = memory({ "finanse.profile": "jan" });
  assert.equal(readStored(s, "cashu.profile"), "jan");
  assert.equal(s.m.get("cashu.profile"), "jan");
  assert.equal(s.m.has("finanse.profile"), false);
  assert.equal(readStored(s, "cashu.profile"), "jan");
});

test("missing keys, foreign keys and broken storage", () => {
  assert.equal(readStored(memory(), "cashu.x"), null);
  assert.equal(readStored(memory({ "finanse.x": "1" }), "other.x"), null);
  assert.equal(readStored(null, "cashu.x"), null);
  const broken = { getItem: () => { throw new Error("denied"); }, setItem() {}, removeItem() {} };
  assert.equal(readStored(broken, "cashu.x"), null);
  assert.equal(legacyKey("cashu.inv.a.jan"), "finanse.inv.a.jan");
  assert.equal(legacyKey("x"), null);
});
