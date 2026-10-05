// Alert edit round trip (F7 FE4 / FE12): untouched values are not rewritten, "bez pauzy" stays, the expiry
// keeps its instant unless the select changed, the kind of a weight alert never flips. Run with `npm test`.
import assert from "node:assert/strict";
import { test } from "node:test";
import { alertPatch, buildParams, draftText, expiryChoice, expiryValue, formKind, levelText, percentText } from "../src/modules/investments/v2/alertForm.ts";

const agentAlert = {
  kind: "price_below", title: "XYZ poniżej 4,32 zł", params: { level: 4.3175 }, polarity: "positive", severity: "info",
  note: "poziom agenta", cooldown_days: null, expires_at: "2026-12-31T15:30:00Z", scope: "instrument",
};

const unchanged = (a, over = {}) => {
  const t = draftText(a.params);
  const initialParams = buildParams(a.kind, a.scope, t);
  return { title: a.title, params: initialParams, initialParams, polarity: a.polarity, severity: a.severity, note: a.note, cooldown_days: a.cooldown_days, expiry: expiryChoice(a.expires_at), ...over };
};

test("levels and thresholds show every stored digit", () => {
  assert.equal(levelText(4.3175), "4,3175");
  assert.equal(levelText(0.0123), "0,0123");
  assert.equal(levelText(123.4567), "123,4567");
  assert.equal(levelText(140), "140,00");
  assert.equal(levelText(null), "");
  assert.equal(percentText(0.0625), "6,25");
  assert.equal(percentText(0.3), "30");
  assert.equal(percentText(0.07), "7");
  assert.deepEqual(buildParams("drawdown_from_high", "instrument", draftText({ window_days: 252, threshold: 0.0625 })), { window_days: 252, threshold: 0.0625 });
  assert.deepEqual(buildParams("price_below", "instrument", draftText({ level: 0.0123 })), { level: 0.0123 });
});

test("editing only the note sends only the note: level, cooldown null and expiry stay as stored", () => {
  const patch = alertPatch(agentAlert, unchanged(agentAlert, { note: "literówka poprawiona" }));
  assert.deepEqual(patch, { note: "literówka poprawiona" });
  assert.deepEqual(alertPatch(agentAlert, unchanged(agentAlert)), {});
});

test("a changed level is sent; untouched params keep their stored value", () => {
  const a = { ...agentAlert, kind: "drawdown_from_high", params: { window_days: 252, threshold: 0.0625, extra: "kept" } };
  const t = draftText(a.params);
  const initialParams = buildParams(a.kind, a.scope, t);
  const params = buildParams(a.kind, a.scope, { ...t, windowDays: "120" });
  const patch = alertPatch(a, { ...unchanged(a), params, initialParams });
  assert.deepEqual(patch.params, { window_days: 120, threshold: 0.0625, extra: "kept" });
});

test("cooldown and expiry are sent only when changed; a new expiry carries its UTC offset (23:59 local)", () => {
  assert.deepEqual(alertPatch(agentAlert, unchanged(agentAlert, { cooldown_days: 14 })), { cooldown_days: 14 });
  const prev = process.env.TZ;
  process.env.TZ = "Europe/Warsaw";
  try {
    assert.equal(expiryChoice("2026-12-31T23:30:00Z"), "2027-01-01");
    const p = alertPatch(agentAlert, unchanged(agentAlert, { expiry: "2027-03-31" }));
    assert.deepEqual(p, { expires_at: "2027-03-31T21:59:00.000Z" });
    assert.equal(expiryValue("2026-12-31"), "2026-12-31T22:59:00.000Z");
  } finally { if (prev === undefined) delete process.env.TZ; else process.env.TZ = prev; }
  assert.deepEqual(alertPatch(agentAlert, unchanged(agentAlert, { expiry: "" })), { expires_at: null });
});

test("FE12: an edited weight alert keeps its kind whatever the direction seg says", () => {
  assert.equal(formKind("weight", false, "weight_above"), "weight_above");
  assert.equal(formKind("weight", true, "weight_below"), "weight_below");
  assert.equal(formKind("weight", false, null), "weight_below");
  assert.equal(formKind("price_above", false, null), "price_above");
});
