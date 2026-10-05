// Investments v2 pure logic (src/modules/investments/v2/logic.ts), run with `npm test`.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  alertConditionText, alertDefaultTitle, alertDistance, alertLevelText, alertNowText, alertPreview, changeSince, cursorOrder, daysSince, gapText,
  groupByMonth, isDigestDay, isImportant, monthlyFlows, nextWeekday, orderAlerts, polarityOf, signalText, splitByPolarity, weekChange,
} from "../src/modules/investments/v2/logic.ts";

const NB = " ";
const sig = (over) => ({
  id: 1, rule_id: "r", kind: "custom", severity: "info", status: "active", message: "m", instrument_id: null, instrument_label: null,
  payload: {}, first_seen_at: "2026-10-01T07:00:00Z", decisions: [], ...over,
});
const alert = (over) => ({
  kind: "price_below", scope: "instrument", params: { level: 140 }, polarity: "positive", severity: "action", title: "CDR poniżej 140,00 zł",
  status: "active", source: "user", last_value: 148.6, cooldown_days: 14, expires_at: null, instrument: { label: "CD Projekt", symbol: "CDR", currency: "PLN" }, ...over,
});

test("polarity: server value wins, else the rule kind default (mirrors DEFAULT_POLARITY)", () => {
  assert.equal(polarityOf({ kind: "allocation_drift", polarity: "positive" }), "positive");
  assert.equal(polarityOf({ kind: "drawdown_from_high" }), "positive");
  assert.equal(polarityOf({ kind: "gain_from_cost" }), "positive");
  assert.equal(polarityOf({ kind: "position_concentration" }), "negative");
  assert.equal(polarityOf({ kind: "contribution_gap" }), "negative");
  assert.equal(polarityOf({ kind: "custom" }), "neutral");
  assert.equal(polarityOf({ kind: "alert:price_below" }), "neutral");
  assert.equal(polarityOf({ kind: "x", polarity: "bogus" }), "neutral");
});

test("polarity split: Szanse left, risks then neutral right; undecided action first, decided sink, newest first", () => {
  const list = [
    sig({ id: 1, polarity: "negative", severity: "info" }),
    sig({ id: 2, polarity: "positive", severity: "info" }),
    sig({ id: 3, polarity: "neutral", severity: "action" }),
    sig({ id: 4, polarity: "negative", severity: "action" }),
    sig({ id: 5, polarity: "positive", severity: "action", decisions: [{ action: "held", quantity: null, created_at: "2026-10-02T10:00:00Z" }] }),
    sig({ id: 6, polarity: "positive", severity: "action" }),
    sig({ id: 7, polarity: "negative", severity: "info", snoozed: true }),
    sig({ id: 8, polarity: "negative", severity: "info" }),
  ];
  const { positive, negative } = splitByPolarity(list);
  assert.deepEqual(positive.map((s) => s.id), [6, 2, 5]);
  assert.deepEqual(negative.map((s) => s.id), [4, 8, 1, 3, 7]);
  assert.deepEqual(cursorOrder(list).map((s) => s.id), [6, 2, 4, 8, 1, 3]);
});

test("signal copy: plain words, no rule ids", () => {
  const dip = signalText(sig({ kind: "drawdown_from_high", rule_id: "dip_review", payload: { name: "CD Projekt", symbol: "CDR", drawdown: 0.188, threshold: 0.15, window_days: 252 } }));
  assert.equal(dip.title, "CD Projekt");
  assert.equal(dip.sym, "CDR");
  assert.equal(dip.lead, "transza spadkowa ·");
  assert.equal(dip.bold, `-18,8${NB}%`);
  assert.equal(dip.tail, `od szczytu 52 tyg. · próg -15${NB}%`);
  assert.ok(!JSON.stringify(dip).includes("dip_review"));
  const conc = signalText(sig({ kind: "position_concentration", payload: { name: "PKN Orlen", symbol: "PKN", weight: 0.133, max_weight: 0.1 } }), { total: 186401, base: "PLN" });
  assert.equal(conc.title, "Koncentracja: PKN Orlen");
  assert.ok(conc.tail.includes("maks 10") && conc.tail.includes("nad limitem"));
  const below = signalText(sig({ kind: "allocation_drift", payload: { bucket_id: "global_equity", target: 0.6, drift_pp: -5.9, absolute_band_pp: 5 } }));
  assert.equal(below.title, "Akcje globalne poniżej celu");
  assert.equal(below.bold, `-5,9${NB}pp`);
  const out = signalText(sig({ kind: "allocation_drift", payload: { bucket_id: "pl_equity", target: 0.15, drift_pp: 9.5, absolute_band_pp: 5, relative_band: 0.5 } }));
  assert.equal(out.title, "Akcje PL poza pasmem");
  const al = signalText(sig({ kind: "alert:price_below", instrument_label: "iShares MSCI EM IMI", payload: { alert_kind: "price_below", symbol: "EIMI", level: "30", close: "29.45", currency: "EUR" } }));
  assert.equal(al.title, "iShares MSCI EM IMI");
  assert.equal(al.lead, "cena poniżej");
  assert.ok(al.bold.startsWith("30,00") && al.tail.includes("29,45"));
  const gap = signalText(sig({ kind: "contribution_gap", payload: { last_deposit: "2026-08-10", day_of_month: 10, grace_days: 10 } }));
  assert.equal(gap.bold, "10.08");
  assert.equal(gap.tail, "· plan: co miesiąc do 10. (+10 dni)");
});

test("alert distance: percent of the price for levels, pp for weights / drawdown / change; bar fill closes in", () => {
  const d = alertDistance(alert({}));
  assert.equal(d.text, `5,8${NB}%`);
  assert.equal(d.pp, false);
  assert.ok(d.fill > 0.7 && d.fill < 0.72);
  const w = alertDistance(alert({ kind: "weight_below", params: { threshold: 0.04 }, last_value: 0.053 }));
  assert.equal(w.text, `1,3${NB}pp`);
  assert.ok(w.fill > 0.59 && w.fill < 0.62);
  const ch = alertDistance(alert({ kind: "change_pct", params: { threshold: 0.1, direction: "down", window_days: 30 }, last_value: -0.07 }));
  assert.equal(ch.text, `3,0${NB}pp`);
  assert.equal(alertDistance(alert({ kind: "change_pct", params: { threshold: 0.1, direction: "down" }, last_value: -0.124 })).text, `0,0${NB}pp`);
  assert.equal(alertDistance(alert({ kind: "custom", params: { expression: "x" } })), null);
  assert.equal(alertDistance(alert({ last_value: null })), null);
});

test("alert texts: condition, level, now, default title, preview sentence", () => {
  assert.equal(alertConditionText(alert({})), "cena poniżej poziomu");
  assert.equal(alertConditionText(alert({ kind: "weight_above", scope: "bucket" })), "waga koszyka powyżej");
  assert.equal(alertLevelText(alert({})), `140,00${NB}zł`);
  assert.equal(alertNowText(alert({ kind: "change_pct", last_value: -0.124 })), `-12,4${NB}%`);
  assert.equal(alertDefaultTitle("price_below", { level: 140 }, "CDR", "PLN"), `CDR poniżej 140,00${NB}zł`);
  assert.equal(alertDefaultTitle("change_pct", { threshold: 0.1, direction: "down", window_days: 30 }, "KGHM"), `KGHM -10${NB}% w 30 sesji`);
  const p = alertPreview({ kind: "price_below", params: { level: 140 }, subject: "CDR", currency: "PLN", now: 148.6, polarity: "positive", severity: "action", cooldown: 14 });
  assert.equal(p, `Zadziała, gdy cena CDR spadnie poniżej 140,00${NB}zł (teraz 148,60${NB}zł). Powiadomienie od razu, sygnał w „Szanse", pauza 14 dni po wyzwoleniu.`);
  assert.ok(alertPreview({ kind: "weight_above", params: { threshold: 0.25 }, subject: "Akcje PL", polarity: "negative", severity: "info", cooldown: null }).includes("w podsumowaniu tygodnia"));
  assert.ok(!p.includes("\u2014"));
  assert.deepEqual(orderAlerts([{ id: 1, status: "muted" }, { id: 2, status: "active" }, { id: 3, status: "triggered" }, { id: 4, status: "active" }]).map((a) => a.id), [3, 4, 2, 1]);
});

test("week change from 30-day closes: last vs the newest close at least 7 days older", () => {
  const closes = [
    { date: "2026-09-21", close: 100 }, { date: "2026-09-25", close: 102 }, { date: "2026-09-26", close: 104 },
    { date: "2026-09-29", close: 103 }, { date: "2026-10-02", close: 106 }, { date: "2026-10-03", close: 107.12 },
  ];
  assert.ok(Math.abs(weekChange(closes) - (107.12 / 104 - 1)) < 1e-12);
  assert.equal(weekChange([{ date: "2026-10-02", close: 1 }, { date: "2026-10-03", close: 2 }]), null);
  assert.equal(weekChange(null), null);
});

test("re-entry: days, gap text, events grouped by month, important filter", () => {
  assert.equal(daysSince("2026-07-19T10:00:00Z", "2026-10-04T09:00:00Z"), 77);
  assert.equal(gapText(77), "Wracasz po 11 tygodniach");
  assert.equal(gapText(120), "Wracasz po 4 miesiącach");
  assert.equal(gapText(9), "Wracasz po 9 dniach");
  const ev = [
    { type: "deposit", at: "2026-08-10T00:00:00Z", date: "2026-08-10" },
    { type: "alert_triggered", at: "2026-10-03T07:00:00Z", date: "2026-10-03" },
    { type: "decision", at: "2026-09-14T20:00:00Z", date: "2026-09-14" },
    { type: "import", at: "2025-12-01T10:00:00Z", date: "2025-12-01" },
  ];
  const g = groupByMonth(ev, "2026-10-04");
  assert.deepEqual(g.map((x) => x.label), ["Październik", "Wrzesień", "Sierpień", "Grudzień 2025"]);
  assert.equal(ev.filter(isImportant).length, 3); // the decision is "Wszystko" only
});

test("performance: change since a date (TWR ratio, money, benchmark), monthly deposits, review weekdays", () => {
  const pts = [
    { date: "2026-07-01", value: 100, twr: 0, benchmark: 0, simulated_value: 100, flow: 0, drawdown: 0 },
    { date: "2026-07-19", value: 110, twr: 0.1, benchmark: 0.05, simulated_value: 105, flow: 0, drawdown: 0 },
    { date: "2026-08-10", value: 2120, twr: 0.12, benchmark: 0.06, simulated_value: 2106, flow: 2000, drawdown: 0 },
    { date: "2026-10-04", value: 2220, twr: 0.21, benchmark: 0.0815, simulated_value: 2150, flow: 0, drawdown: 0 },
  ];
  const c = changeSince(pts, "2026-07-19");
  assert.equal(c.from, "2026-07-19");
  assert.ok(Math.abs(c.pct - 0.1) < 1e-9);
  assert.ok(Math.abs(c.bench - 0.03) < 1e-9);
  assert.equal(c.money, 2110);
  const m = monthlyFlows([{ date: "2026-08-10", flow: 2000 }, { date: "2026-09-10", flow: 500 }, { date: "2026-09-12", flow: -100 }, { date: "2025-01-01", flow: 9 }], "2026-10-04", 3);
  assert.deepEqual(m.map((x) => [x.label, x.value]), [["sie", 2000], ["wrz", 500], ["paź", 0]]);
  assert.equal(nextWeekday("2026-10-04", "sunday"), "2026-10-11");
  assert.equal(nextWeekday("2026-10-01", "sunday"), "2026-10-04");
  assert.equal(isDigestDay("2026-10-04", "sunday"), true);
  assert.equal(isDigestDay("2026-10-05", "sunday"), false);
});
