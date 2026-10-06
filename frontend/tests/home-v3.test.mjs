// Inwestycje home v3 pure logic (design/v3/home-v3/home-v3.md rev 2, F8): signals by subject and scope, the
// facts of the rail rows, freshness, alert states, table markers, the Rachunki view and the new alert kinds.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  accountSnapshot, alertConditionText, alertDefaultTitle, alertDistance, alertFact, alertPreview, alertState, alertStateOf, contributionFacts, cursorOrder,
  groupPlan, groupSignals, railGroups, railRows, rowFlags, signalCurrent, signalFact, signalPlace, signalScope, signalSubject, signalText, splitByScope,
  stateOf, subjectKey, waitingAlerts,
} from "../src/modules/investments/v2/logic.ts";
import { buildParams, draftText } from "../src/modules/investments/v2/alertForm.ts";
import { validate } from "../src/modules/investments/v2/alertForm.ts";
import { splitNarrowOrder } from "../src/grid.ts";

const NB = " ";
/** Spaces of any kind (the formatters use NBSP / NNBSP) compare as one plain space. */
const sp = (v) => (typeof v === "string" ? v.replace(/[\s\u00a0\u202f]+/g, " ") : v);
const eq = (a, b, m) => assert.equal(sp(a), sp(b), m);
const sig = (over) => ({
  id: 1, rule_id: "r", kind: "custom", severity: "info", status: "active", message: "m", instrument_id: null, instrument_label: null,
  payload: {}, first_seen_at: "2026-10-01T07:00:00Z", decisions: [], ...over,
});
const decided = [{ action: "held", quantity: null, created_at: "2026-10-02T10:00:00Z" }];
const alert = (over) => ({
  id: 1, kind: "price_below", scope: "instrument", params: { level: 140 }, polarity: "positive", severity: "action", title: "CDR poniżej 140,00 zł",
  status: "active", source: "user", last_value: 148.6, cooldown_days: 14, expires_at: null, instrument: { label: "CD Projekt", symbol: "CDR", currency: "PLN" }, ...over,
});

test("stateOf: one glyph per subject", () => {
  eq(stateOf([]), null);
  eq(stateOf(["positive", "positive"]), "positive");
  eq(stateOf(["negative", "neutral"]), "negative");
  eq(stateOf(["neutral"]), "neutral");
  eq(stateOf(["positive", "neutral"]), "mixed");
  eq(stateOf(["positive", "negative"]), "mixed");
});

test("subjectKey and signalScope", () => {
  eq(subjectKey(sig({ instrument_id: 57 })), "i:57");
  eq(subjectKey(sig({ kind: "allocation_drift", payload: { bucket_id: "global_equity" } })), "b:global_equity");
  eq(subjectKey(sig({ kind: "contribution_gap" })), "k:contribution_gap");
  const held = new Set(["57"]);
  eq(signalScope(sig({ instrument_id: 57 }), held), "portfolio");
  eq(signalScope(sig({ instrument_id: 58 }), held), "watched");
  eq(signalScope(sig({ instrument_id: null }), held), "portfolio");
  eq(signalScope(sig({ instrument_id: 58 }), new Set()), "watched");
  eq(signalScope(sig({ instrument_id: 58, held: true }), new Set()), "portfolio"); // the server's flag wins
});

test("groupSignals: a good and a bad signal of one instrument are one mixed group; settled groups sink", () => {
  const list = [
    sig({ id: 1, instrument_id: 57, polarity: "positive", first_seen_at: "2026-09-29T07:00:00Z" }),
    sig({ id: 2, instrument_id: 57, polarity: "negative", severity: "action", first_seen_at: "2026-10-04T07:00:00Z" }),
    sig({ id: 3, instrument_id: 57, polarity: "negative", first_seen_at: "2026-10-05T07:00:00Z", decisions: decided }),
    sig({ id: 4, instrument_id: 57, polarity: "negative", first_seen_at: "2026-10-05T07:00:00Z", snoozed: true }),
    sig({ id: 5, instrument_id: 60, polarity: "positive", first_seen_at: "2026-10-06T07:00:00Z", decisions: decided }),
    sig({ id: 6, kind: "contribution_gap", polarity: "negative", first_seen_at: "2026-10-02T07:00:00Z" }),
  ];
  const g = groupSignals(list);
  assert.deepEqual(g.map((x) => x.key), ["i:57", "k:contribution_gap", "i:60"]);
  eq(g[0].state, "mixed");
  eq(g[0].primary.id, 2);
  assert.deepEqual(g[0].live.map((s) => s.id), [2, 1]);
  eq(g[2].settled, true);
  eq(g[2].primary, null);
  assert.deepEqual(groupPlan(g[0]), { primary: g[0].live[0], rest: [g[0].live[1]] });
  eq(groupPlan(g[2]), null);
});

test("railGroups / railRows / signalPlace: scope sections, cap 4, a group's second line lands in the rail", () => {
  const held = new Set(["1", "2", "3", "4", "5"]);
  const list = [1, 2, 3, 4, 5].map((i) => sig({ id: i, instrument_id: i, polarity: "positive", first_seen_at: `2026-10-0${i}T07:00:00Z` }))
    .concat([sig({ id: 50, instrument_id: 5, polarity: "negative", first_seen_at: "2026-09-20T07:00:00Z" })])
    .concat([sig({ id: 90, instrument_id: 9, polarity: "negative", first_seen_at: "2026-10-03T07:00:00Z" })]);
  assert.deepEqual(railGroups(list, held, "portfolio").map((g) => g.key), ["i:5", "i:4", "i:3", "i:2"]);
  assert.deepEqual(railGroups(list, held, "watched").map((g) => g.key), ["i:9"]);
  assert.deepEqual(railRows(list, held).map((g) => g.key), ["i:5", "i:4", "i:3", "i:2", "i:9"]);
  eq(signalPlace(50, list, held), "rail"); // the second line of the QUBT-like group
  eq(signalPlace(1, list, held), "dialog"); // fifth subject of Portfel
  eq(signalPlace(90, list, held), "rail");
  eq(signalPlace(77, list, held), "dialog");
});

test("splitByScope and cursorOrder: polarity filter drops lines and empty groups", () => {
  const held = new Set(["57"]);
  const list = [
    sig({ id: 1, instrument_id: 57, polarity: "positive", first_seen_at: "2026-10-01T07:00:00Z" }),
    sig({ id: 2, instrument_id: 57, polarity: "negative", first_seen_at: "2026-10-02T07:00:00Z" }),
    sig({ id: 3, instrument_id: 58, polarity: "neutral", first_seen_at: "2026-10-03T07:00:00Z" }),
    sig({ id: 4, kind: "cash_level", polarity: "negative", first_seen_at: "2026-10-04T07:00:00Z", decisions: decided }),
  ];
  const all = splitByScope(list, held, "all");
  assert.deepEqual(all.portfolio.map((g) => g.key), ["i:57", "k:cash_level"]);
  assert.deepEqual(all.watched.map((g) => g.key), ["i:58"]);
  const pos = splitByScope(list, held, "positive");
  assert.deepEqual(pos.portfolio.map((g) => g.signals.map((s) => s.id)), [[1]]);
  assert.deepEqual(pos.watched, []);
  const neg = splitByScope(list, held, "negative");
  assert.deepEqual(neg.portfolio.map((g) => g.key), ["i:57", "k:cash_level"]);
  assert.deepEqual(cursorOrder(list, held, "all").map((s) => s.id), [2, 1, 3]);
  assert.deepEqual(cursorOrder(list, held, "negative").map((s) => s.id), [2, 3]);
});

test("signalCurrent: the server's flag wins; else compare the run's day with last_seen_at", () => {
  eq(signalCurrent({ kind: "x", current: false, last_seen_at: "2026-10-04T07:00:00Z" }, "2026-10-04T07:00:00Z"), false);
  eq(signalCurrent({ kind: "x", current: true, last_seen_at: "2026-10-01T07:00:00Z" }, "2026-10-04T07:00:00Z"), true);
  eq(signalCurrent({ kind: "x", last_seen_at: "2026-10-04T05:00:00Z" }, "2026-10-04T07:00:00Z"), true);
  eq(signalCurrent({ kind: "x", last_seen_at: "2026-10-01T07:00:00Z" }, "2026-10-04T07:00:00Z"), false);
  eq(signalCurrent({ kind: "research:weakens", last_seen_at: "2026-09-01T07:00:00Z" }, "2026-10-04T07:00:00Z"), true);
  eq(signalCurrent({ kind: "x", last_seen_at: "2026-09-01T07:00:00Z" }, null), true);
});

test("signalFact: one bold value per signal, no threshold, no · chain", () => {
  const f = (s) => { const x = signalFact(s); return `${x.pre ? `${x.pre} ` : ""}${x.bold}${x.post ? (/^[,.]/.test(x.post) ? x.post : ` ${x.post}`) : ""}`; };
  const cases = [
    [sig({ kind: "alert:price_below", payload: { alert_kind: "price_below", close: "74.57", level: "75", currency: "PLN" } }), `cena 74,57${NB}zł poniżej 75,00${NB}zł`],
    [sig({ kind: "alert:change_pct", payload: { alert_kind: "change_pct", change: -0.142, window_days: 30 } }), `-14,2${NB}% w 30 sesji`],
    [sig({ kind: "drawdown_from_high", payload: { drawdown: 0.224, window_days: 252 } }), `-22,4${NB}% od szczytu 52 tyg.`],
    [sig({ kind: "alert:drawdown_from_high", payload: { alert_kind: "drawdown_from_high", drawdown: 0.112, window_days: 90 } }), `-11,2${NB}% od szczytu 90 sesji`],
    [sig({ kind: "gain_from_cost", payload: { unrealized_pct: 0.321 } }), `+32,1${NB}% od kosztu`],
    [sig({ kind: "position_concentration", payload: { weight: 0.111, max_weight: 0.1 } }), `11,1${NB}% portfela, maks 10${NB}%`],
    [sig({ kind: "allocation_drift", payload: { drift_pp: -3, target: 0.6 } }), `-3,0${NB}pp do celu 60${NB}%`],
    [sig({ kind: "allocation_drift", payload: { drift_pp: 6.2, target: 0.15 } }), `+6,2${NB}pp nad celem 15${NB}%`],
    [sig({ kind: "contribution_gap", payload: { last_deposit: "2026-09-10" } }), "ostatnia wpłata 10.09"],
    [sig({ kind: "contribution_gap", payload: {} }), "brak wpłat"],
    [sig({ kind: "cash_level", payload: { cash_weight: 0.053, min_weight: 0.03 } }), `gotówka 5,3${NB}%, min 3${NB}%`],
    [sig({ kind: "tagged_weight", payload: { weight: 0.12, max_weight: 0.1 } }), `12,0${NB}% portfela, maks 10${NB}%`],
    [sig({ kind: "alert:new_high", payload: { alert_kind: "new_high", close: "44.60", currency: "EUR", direction: "low" } }), `nowy dołek 44,60${NB}€`],
    [sig({ kind: "alert:sma_cross", payload: { alert_kind: "sma_cross", close: "486.10", currency: "PLN", window_days: 200, direction: "below" } }), `486,10${NB}zł pod SMA 200`],
    [sig({ kind: "alert:weight_above", payload: { alert_kind: "weight_above", weight: 0.11, threshold: 0.1 } }), `11,0${NB}% portfela, powyżej 10${NB}%`],
    [sig({ kind: "alert:range_breakout", payload: { alert_kind: "range_breakout", breakout_pct: 0.062, range_high: "11.20", range_low: "10.50", currency: "USD" } }), `wybicie +6,2${NB}% nad 11,20${NB}USD`],
    [sig({ kind: "alert:volume_spike", payload: { alert_kind: "volume_spike", ratio: 3.4 } }), "wolumen 3,4x średniej"],
  ];
  for (const [s, want] of cases) {
    const got = f(s).replace(/[$]/g, "USD");
    assert.ok(got === want || got.replace(/\s/g, " ") === want.replace(/\s/g, " "), `${s.kind}: ${got} != ${want}`);
    assert.ok(!got.includes(" · "), `${s.kind}: no · chain`);
  }
});

test("signalSubject: ticker for instruments, bucket label for a drift, short title for portfolio rules", () => {
  const insts = new Map([[57, { symbol: "QUBT", name: "Quantum Computing", label: "Quantum Computing" }], [66, { symbol: "KGH.WA", name: "KGHM", label: "KGHM" }]]);
  eq(signalSubject(sig({ instrument_id: 57 }), insts), "QUBT");
  eq(signalSubject(sig({ instrument_id: 66, kind: "position_concentration" }), insts), "KGH");
  eq(signalSubject(sig({ kind: "allocation_drift", payload: { bucket_id: "global_equity" } })), "Akcje globalne");
  eq(signalSubject(sig({ kind: "contribution_gap" })), "Brak wpłaty");
  eq(signalSubject(sig({ kind: "cash_level", payload: { direction: "below_min" } })), "Za mało gotówki");
  eq(signalSubject(sig({ kind: "tagged_weight", payload: {} })), signalText(sig({ kind: "tagged_weight", payload: {} })).title);
});

test("alertState: near / far / met, thresholds overridable", () => {
  eq(alertState(alert({ params: { level: 100 }, last_value: 104 })), "near");
  eq(alertState(alert({ params: { level: 100 }, last_value: 106.5 })), "far");
  eq(alertState(alert({ status: "triggered" })), "met");
  eq(alertState(alert({ kind: "weight_above", params: { threshold: 0.1 }, last_value: 0.085 })), "near");
  eq(alertState(alert({ kind: "drawdown_from_high", params: { threshold: 0.1 }, last_value: 0.075 })), "far");
  eq(alertState(alert({ kind: "sma_cross", params: { window_days: 200 }, last_value: 486 })), "far");
  eq(alertState(alert({ kind: "volume_spike", params: { multiple: 2.5 }, last_value: 1.8 })), "near");
  eq(alertState(alert({ kind: "volume_spike", params: { multiple: 2.5 }, last_value: 1.2 })), "far");
  eq(alertState(alert({ kind: "range_breakout", params: {}, last_value: 11.0, state: { range_low: 10.5, range_high: 11.2 } })), "near");
  // F8 review FE-6: a range wider than max_range_pct cannot fire; direction picks the edge; near = last quarter
  eq(alertState(alert({ kind: "range_breakout", params: {}, last_value: 10.87, state: { range_low: 9, range_high: 11.2 } })), "far");
  eq(alertState(alert({ kind: "range_breakout", params: { direction: "up" }, last_value: 10.55, state: { range_low: 10.5, range_high: 11.2 } })), "far");
  eq(alertState(alert({ kind: "range_breakout", params: { direction: "down" }, last_value: 10.55, state: { range_low: 10.5, range_high: 11.2 } })), "near");
  eq(alertState(alert({ kind: "range_breakout", params: {}, last_value: 10.8, state: { range_low: 10.5, range_high: 11.2 } })), "far");
  eq(alertState(alert({ params: { level: 100 }, last_value: 106.5 }), { pricePct: 8 }), "near");
  eq(alertState(alert({ kind: "drawdown_from_high", params: { threshold: 0.1 }, last_value: 0.075 }), { pp: 3 }), "near");
});

test("alertFact, alertStateOf, waitingAlerts", () => {
  eq(alertFact(alert()), `5,8${NB}% do 140,00${NB}zł · teraz 148,60${NB}zł`);
  eq(alertFact(alert({ status: "triggered", last_triggered_at: "2026-10-02T07:02:00+02:00" })), `poniżej 140,00${NB}zł od 2.10`);
  eq(alertFact(alert({ kind: "sma_cross", params: { window_days: 200, direction: "below" }, last_value: 486.1 })), `teraz 486,10${NB}zł`);
  eq(alertFact(alert({ kind: "weight_above", params: { threshold: 0.03 }, last_value: 0.053, instrument: null })), `2,3${NB}pp do 3${NB}% · teraz 5,3${NB}%`);
  eq(alertStateOf([]), null);
  eq(alertStateOf([alert({ last_value: 200 }), alert({ status: "muted" })]), "far");
  eq(alertStateOf([alert({ last_value: 200 }), alert({ last_value: 141 })]), "near");
  eq(alertStateOf([alert({ last_value: 141 }), alert({ status: "triggered" })]), "met");
  const list = [
    alert({ id: 1, last_value: 200 }), alert({ id: 2, last_value: 142 }), alert({ id: 3, kind: "sma_cross", params: {}, last_value: 1 }),
    alert({ id: 4, status: "triggered" }), alert({ id: 5, status: "snoozed" }), alert({ id: 6, kind: "custom", params: {}, last_value: null }),
  ];
  assert.deepEqual(waitingAlerts(list).map((a) => a.id), [2, 1, 6, 3]);
});

test("rowFlags: one mixed glyph, the bell only with a live alert, the page only with unread notes", () => {
  const sigs = [sig({ id: 1, instrument_id: 7, polarity: "positive" }), sig({ id: 2, instrument_id: 7, polarity: "negative" }), sig({ id: 3, instrument_id: 8, polarity: "negative", decisions: decided })];
  const alerts = [alert({ id: 1, instrument_id: 7 }), alert({ id: 2, instrument_id: 8, status: "muted" })];
  assert.deepEqual({ ...rowFlags(7, sigs, alerts, 2), alert: rowFlags(7, sigs, alerts, 2).alert?.id }, { state: "mixed", alert: 1, notes: 2 });
  assert.deepEqual(rowFlags("8", sigs, alerts, 0), { state: null, alert: null, notes: 0 });
});

test("accountSnapshot: fresh, none, stale with an import (warn), stale without one", () => {
  const imp = { at: "2026-10-05T10:00:00Z" };
  assert.deepEqual(accountSnapshot({ snapshot_date: "2026-10-04", last_import: imp }, "2026-10-06"), { cell: "4.10", title: "snapshot 4.10 · import 5.10", warn: false });
  assert.deepEqual(accountSnapshot({ snapshot_date: null, last_import: imp }, "2026-10-06"), { cell: "brak", title: "bez snapshotu · import 5.10", warn: false });
  assert.deepEqual(accountSnapshot({ snapshot_date: "2026-09-15", last_import: imp }, "2026-10-06"), { cell: "15.09", title: "snapshot 15.09 · import 5.10 · starszy niż 14 dni", warn: true });
  eq(accountSnapshot({ snapshot_date: "2026-09-15", last_import: null }, "2026-10-06").warn, false);
});

test("contributionFacts: plan since January, missed months without the current one until it has a deposit", () => {
  const months = Array.from({ length: 12 }, (_, i) => ({ value: [1, 3, 5].includes(i) ? 0 : 1000 }));
  months[11].value = 0;
  const r = contributionFacts({ months, deposits: 8000, plan: { amount: 1000 }, firstDeposit: "2025-03-10", today: "2026-10-06" });
  eq(r.planYtd, 10000);
  eq(r.missed, 2); // Jan..Sep counted (October has no deposit yet): two empty months
  eq(contributionFacts({ months, deposits: null, plan: null, firstDeposit: null, today: "2026-10-06" }).planYtd, null);
});

test("new kinds: titles, conditions, preview, distance, form params, validation", () => {
  eq(alertDefaultTitle("range_breakout", { window_days: 30 }, "QUBT"), "QUBT: wybicie z konsolidacji 30 sesji");
  eq(alertDefaultTitle("volume_spike", { multiple: 2.5 }, "QUBT"), "QUBT: wolumen 2,5x średniej");
  eq(alertConditionText({ kind: "range_breakout", scope: "instrument", params: { window_days: 30, max_range_pct: 0.08 } }), `wybicie z zakresu 30 sesji (zakres do 8${NB}%)`);
  eq(alertConditionText({ kind: "volume_spike", scope: "instrument", params: { window_days: 20, multiple: 2.5 } }), "wolumen 2,5x średniej z 20 sesji");
  assert.match(sp(alertPreview({ kind: "range_breakout", params: { window_days: 30, max_range_pct: 0.08, direction: "up" }, subject: "QUBT", polarity: "positive", severity: "info", cooldown: null })),
    /^Zadziała, gdy kurs QUBT wyjdzie w górę poza zakres ostatnich 30 sesji, o ile ten zakres był węższy niż 8 %\. /);
  assert.match(sp(alertPreview({ kind: "volume_spike", params: { window_days: 20, multiple: 2.5 }, subject: "QUBT", polarity: "neutral", severity: "info", cooldown: 7 })),
    /^Zadziała, gdy wolumen QUBT przekroczy 2,5x średnią z 20 sesji\. .*pauza 7 dni po spełnieniu\.$/);
  const v = alertDistance(alert({ kind: "volume_spike", params: { multiple: 2.5 }, last_value: 1.2 }));
  eq(v.text, "1,3x");
  assert.ok(Math.abs(v.fill - 0.48) < 1e-9);
  const b = alertDistance(alert({ kind: "range_breakout", params: {}, last_value: 64.5, state: { range_low: 61.2, range_high: 66 } }));
  eq(b.level, `66,00${NB}zł`);
  const bUp = alertDistance(alert({ kind: "range_breakout", params: { direction: "up" }, last_value: 61.5, state: { range_low: 61.2, range_high: 66 } }));
  eq(bUp.level, `66,00${NB}zł`);
  eq(alertDistance(alert({ kind: "range_breakout", params: { max_range_pct: 0.05 }, last_value: 64.5, state: { range_low: 61.2, range_high: 66 } })), null);
  // the form: 8 % shown, 0.08 sent (F8 BE C3); stored params come back as the same texts
  const t = { ...draftText({}), windowDays: "30", rangePct: "8", direction: "up" };
  assert.deepEqual(buildParams("range_breakout", "instrument", t), { window_days: 30, max_range_pct: 0.08, direction: "up" });
  eq(draftText({ max_range_pct: 0.08 }).rangePct, "8");
  assert.deepEqual(buildParams("volume_spike", "instrument", { ...draftText({}), windowDays: "20", multiple: "2,5" }), { window_days: 20, multiple: 2.5 });
  const inst = { id: 1, label: "Q", symbol: "Q", venue: null, currency: "USD", price: 1, held: true };
  assert.deepEqual(validate("range_breakout", "instrument", { window_days: 30, max_range_pct: 0.08, direction: "any" }, inst, ""), []);
  eq(validate("range_breakout", "instrument", { window_days: 5, max_range_pct: 0.4 }, inst, "").length, 2);
  assert.deepEqual(validate("volume_spike", "instrument", { window_days: 20, multiple: 2.5 }, inst, ""), []);
  eq(validate("volume_spike", "instrument", { window_days: 3, multiple: 1.2 }, inst, "").length, 2);
});

test("split: below 900 px Sygnały and Alerty first, then Wartość, Alokacja, Aktywa (home v3)", () => {
  const o = splitNarrowOrder(["value", "alloc", "assets"], ["signals", "alerts"]);
  assert.deepEqual(["signals", "alerts", "value", "alloc", "assets"].map((id) => o.get(id)), [1, 2, 3, 4, 5]);
});

test("signalText: the new alert kinds carry their value (F8 review FE-5, BE-7)", () => {
  const brk = signalText(sig({ kind: "alert:range_breakout", instrument_id: 5, payload: { alert_kind: "range_breakout", window_days: 30, breakout_pct: 0.062, range_high: "11.20", range_low: "10.50", currency: "USD" } }), { names: new Map([[5, "QUBT"]]) });
  eq([brk.lead, brk.bold, brk.tail].join(" "), `wybicie z konsolidacji 30 sesji · +6,2${NB}% nad 11,20${NB}USD`);
  const down = signalText(sig({ kind: "alert:range_breakout", payload: { alert_kind: "range_breakout", window_days: 30, breakout_pct: -0.0002, range_high: "11.20", range_low: "10.50", currency: "USD" } }));
  eq([down.bold, down.tail].join(" "), `tuż pod 10,50${NB}USD`);
  const vol = signalText(sig({ kind: "alert:volume_spike", payload: { alert_kind: "volume_spike", window_days: 20, ratio: 3.4, close: "12.10", currency: "USD" } }));
  eq([vol.lead, vol.bold, vol.tail].join(" "), `wolumen 3,4x średniej 20 sesji · teraz 12,10${NB}USD`);
});
