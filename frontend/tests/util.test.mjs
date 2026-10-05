// Pure helpers of the SPA (no React, no DOM), run with `npm test` (node --test;
// Node >= 23.6 strips the TypeScript types itself, no extra dependency).
import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeSegment, resolveView, serialSaver } from "../src/core/util.ts";

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

test("F7 FE11: whole money never shows -0 and rounds instead of cutting decimals", async () => {
  const { cur0s, round0 } = await import("../src/format.ts");
  const { money0 } = await import("../src/modules/investments/labels.ts");
  const nb = (s) => s.replace(/\s/g, " ");
  assert.equal(nb(cur0s(-0.4)), "0 zł");
  assert.equal(nb(cur0s(582986.99)), "582 987 zł");
  assert.equal(nb(money0(-0.3)), "0 zł");
  assert.equal(nb(money0(-0.3, "PLN", true)), "0 zł");
  assert.equal(nb(money0(-12.6)), "-13 zł");
  assert.ok(Object.is(round0(-0.2), 0));
});

test("resolveView: a tab route of a module that lives on Przegląd focuses its widget there (F7 merge)", () => {
  const TABS = { budget: ["expenses", "flows", "subs"], loans: ["list"], assets: [], investments: ["portfolio"] };
  const tabsOf = (id) => TABS[id] ?? ["main"];
  const on = [{ id: "budget" }, { id: "loans" }, { id: "assets" }];
  const OV = { kind: "tab", tab: "overview" };
  assert.deepEqual(resolveView(OV, on, tabsOf), OV);
  assert.deepEqual(resolveView({ kind: "tab", tab: "overview", sub: "assets" }, on, tabsOf), { kind: "tab", tab: "overview", sub: "assets" });
  assert.deepEqual(resolveView({ kind: "settings", section: "agent" }, on, tabsOf), { kind: "settings", section: "agent" });
  assert.deepEqual(resolveView({ kind: "setup", module: "assets" }, on, tabsOf), { kind: "setup", module: "assets" });
  assert.deepEqual(resolveView({ kind: "setup", module: "investments" }, on, tabsOf), OV); // module off
  assert.deepEqual(resolveView({ kind: "tab", tab: "assets.list" }, on, tabsOf), { kind: "tab", tab: "overview", sub: "assets" });
  assert.deepEqual(resolveView({ kind: "tab", tab: "assets.anything", sub: "x" }, on, tabsOf), { kind: "tab", tab: "overview", sub: "assets" });
  assert.deepEqual(resolveView({ kind: "tab", tab: "assets.list" }, [{ id: "budget" }], tabsOf), OV); // assets off
  assert.deepEqual(resolveView({ kind: "tab", tab: "loans.nope" }, on, tabsOf), OV);
  assert.deepEqual(resolveView({ kind: "tab", tab: "loans.list" }, on, tabsOf), { kind: "tab", tab: "loans.list" });
  assert.deepEqual(resolveView({ kind: "tab", tab: "investments.portfolio", sub: "alerts" }, on, tabsOf), OV); // investments off
});
