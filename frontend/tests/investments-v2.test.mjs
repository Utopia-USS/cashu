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
  assert.equal(c.money, 110); // 2 110 value change minus the 2 000 deposit (F7 FE6)
  const m = monthlyFlows([{ date: "2026-08-10", flow: 2000 }, { date: "2026-09-10", flow: 500 }, { date: "2026-09-12", flow: -100 }, { date: "2025-01-01", flow: 9 }], "2026-10-04", 3);
  assert.deepEqual(m.map((x) => [x.label, x.value]), [["sie", 2000], ["wrz", 500], ["paź", 0]]);
  assert.equal(nextWeekday("2026-10-04", "sunday"), "2026-10-11");
  assert.equal(nextWeekday("2026-10-01", "sunday"), "2026-10-04");
  assert.equal(isDigestDay("2026-10-04", "sunday"), true);
  assert.equal(isDigestDay("2026-10-05", "sunday"), false);
});

test("F7 FE5: surplus card uses the transfer after the cushion top-up; pp a contribution closes; plan months", async () => {
  const { contributionPp, planMonthsSoFar, surplusFlow } = await import("../src/modules/investments/v2/logic.ts");
  // surplus 3 000, cushion top-up 2 000 -> 1 000 for investing; plan 2 000 -> 1 000 short, primary 1 000.
  assert.deepEqual(surplusFlow({ surplus: 3000, cushion_top_up: 2000, suggested_transfer: 1000 }, 2000), { available: 1000, topUp: 2000, stays: -1000, primary: 1000 });
  assert.deepEqual(surplusFlow({ surplus: 3000, cushion_top_up: 0, suggested_transfer: 3000 }, 2000), { available: 3000, topUp: 0, stays: 1000, primary: 2000 });
  assert.equal(surplusFlow({ surplus: -200, cushion_top_up: 0, suggested_transfer: 0 }, 2000).primary, null);
  assert.equal(surplusFlow({ surplus: 500, cushion_top_up: 0, suggested_transfer: 500 }, null).stays, null);
  // portfolio 100 000, bucket at 55 %, contribution 2 000: +0,88 pp (not 2,0 pp)
  assert.ok(Math.abs(contributionPp(2000, 100000, 0.55) - 0.882) < 0.001);
  assert.equal(contributionPp(0, 100000, 0.5), 0);
  assert.equal(planMonthsSoFar(null, "2026-10-05"), 10);
  assert.equal(planMonthsSoFar("2026-07-03", "2026-10-05"), 4);
  assert.equal(planMonthsSoFar("2025-11-03", "2026-10-05"), 10);
});

test("F7 FE6: the change since a date is the market move (deposits in between removed)", async () => {
  const { changeSince } = await import("../src/modules/investments/v2/logic.ts");
  const pt = (date, value, flow, twr) => ({ date, value, flow, twr, benchmark: null, simulated_value: null, drawdown: null });
  const pts = [pt("2026-09-01", 100000, 0, 0), pt("2026-09-15", 103000, 2000, 0.01), pt("2026-10-01", 106400, 3000, 0.014)];
  const r = changeSince(pts, "2026-09-01");
  assert.equal(r.money, 1400);
  assert.ok(Math.abs(r.pct - 0.014) < 1e-9);
});

test("F7 FE6: asset average cost over all accounts; the minimal hero compares like with like", async () => {
  const { averageCost, heroBenchmark } = await import("../src/modules/investments/v2/logic.ts");
  const pos = { quantity: 20, cost: 2400, accounts: [
    { quantity: 10, average_cost: 100, cost_currency: "PLN" }, { quantity: 10, average_cost: 140, cost_currency: "PLN" }] };
  assert.deepEqual(averageCost(pos, "PLN"), { value: 120, currency: "PLN" });
  const mixed = { quantity: 20, cost: 2400, accounts: [
    { quantity: 10, average_cost: 25, cost_currency: "EUR" }, { quantity: 10, average_cost: 140, cost_currency: "PLN" }] };
  assert.deepEqual(averageCost(mixed, "PLN"), { value: 120, currency: "PLN" });
  assert.equal(averageCost({ quantity: 0, cost: null, accounts: [] }, "PLN"), null);
  const b = { status: "ok", id: "MSCI ACWI", twr: 0.098, simulation: { pnl: 300 } };
  assert.deepEqual(heroBenchmark(b, 10000), { value: 0.03, label: "MSCI ACWI, te same wpłaty" });
  assert.deepEqual(heroBenchmark({ ...b, simulation: null }, 10000), { value: 0.098, label: "MSCI ACWI, TWR" });
  assert.equal(heroBenchmark({ ...b, status: "no_prices" }, 10000), null);
});

test("F7 FE8: a watchlist row without a week of closes shows the session move as 1 d., not tydz.", async () => {
  const { watchMove } = await import("../src/modules/investments/v2/logic.ts");
  const closes = [{ date: "2026-09-25", close: 100 }, { date: "2026-10-02", close: 110 }];
  assert.deepEqual(watchMove(closes, 0.01), { value: 0.10000000000000009, label: "tydz." });
  assert.deepEqual(watchMove([{ date: "2026-10-01", close: 100 }, { date: "2026-10-02", close: 101 }], 0.014), { value: 0.014, label: "1 d." });
  assert.equal(watchMove(null, null), null);
});

test("F7 FE17: the re-entry baseline stays pending until Wszystko jasne; the last visit does not move meanwhile", async () => {
  const { reentryBaseline } = await import("../src/modules/investments/v2/logic.ts");
  const now = "2026-10-05T08:00:00Z";
  // six weeks away: the old visit becomes the pending baseline, leaving must not advance it
  assert.deepEqual(reentryBaseline(null, "2026-08-20T18:00:00Z", now), { baseline: "2026-08-20T18:00:00Z", store: true, advance: false });
  // the app was closed and reopened in the evening: the pending baseline is still there
  assert.deepEqual(reentryBaseline("2026-08-20T18:00:00Z", "2026-08-20T18:00:00Z", "2026-10-05T19:00:00Z"), { baseline: "2026-08-20T18:00:00Z", store: false, advance: false });
  // a recent visit: no banner, leaving records the visit
  assert.deepEqual(reentryBaseline(null, "2026-10-01T18:00:00Z", now), { baseline: null, store: false, advance: true });
  assert.deepEqual(reentryBaseline(null, null, now), { baseline: null, store: false, advance: true });
});

test("F7 FE13: performance caveats read in Polish; a stale benchmark tail is flagged", async () => {
  const { perfNotes } = await import("../src/modules/investments/v2/logic.ts");
  const perf = {
    data_quality: { notes: [{ code: "incomplete_days", params: { days: 2 }, message: "2 days" }, { code: "implied_funding", params: {}, message: "x" }] },
    benchmark: { status: "ok", covers_range_end: false, last_priced: "2026-09-30" },
  };
  assert.deepEqual(perfNotes(perf), [
    "niepełna wycena: 2 dni",
    "ujemna gotówka liczona jako wpłata: sprawdź, czy w historii nie brakuje wpłaty",
    "benchmark: ceny tylko do 30.09.2026, bez porównania",
  ]);
  const withNote = { data_quality: { notes: [{ code: "benchmark_stale", params: { last_date: "2026-09-30" }, message: "x" }] }, benchmark: { status: "ok", covers_range_end: false, last_priced: "2026-09-30" } };
  assert.equal(perfNotes(withNote).length, 1);
  assert.deepEqual(perfNotes({ data_quality: null, benchmark: { status: "ok", covers_range_end: true } }), []);
  assert.deepEqual(perfNotes(null), []);
});

// ---- F7 fix pass ---------------------------------------------------------------------------------------
import { digestValueLine } from "../src/modules/investments/v2/logic.ts";

test("F2 digest value line: market_change null with change set is a value change, not the market move", () => {
  const base = { then: 100000, change: 42300, change_pct: 0.011, contributions: 2000 };
  const unvalued = digestValueLine({ ...base, market_change: null, market_change_pct: null, transfers: null }, 0.003);
  assert.equal(unvalued.kind, "value");
  assert.equal(unvalued.amount, 42300);
  assert.equal(unvalued.pct, null);
  assert.equal(unvalued.contributions, null);
  assert.equal(unvalued.transfersUnvalued, true);
  const valued = digestValueLine({ ...base, market_change: 300, market_change_pct: 0.003, transfers: 40000 }, 0.004);
  assert.deepEqual([valued.kind, valued.amount, valued.pct, valued.contributions, valued.transfersUnvalued], ["market", 300, 0.003, 2000, false]);
  // older server: no market_change key at all -> `change` as the market line, as before
  const old = digestValueLine({ then: 1, change: 500, change_pct: 0.01 }, null);
  assert.deepEqual([old.kind, old.amount, old.pct, old.transfersUnvalued], ["market", 500, 0.01, false]);
  // no starting value: nothing to show, transfers row not flagged
  const none = digestValueLine({ then: null, change: null, change_pct: null, market_change: null, transfers: null }, null);
  assert.deepEqual([none.kind, none.transfersUnvalued], ["none", false]);
});

test("F4 stale benchmark: no comparison figure on the heroes, a short label with the last priced day", async () => {
  const { heroBenchmark, staleBenchmark } = await import("../src/modules/investments/v2/logic.ts");
  const b = { status: "ok", id: "MSCI ACWI", twr: 0.061, simulation: { pnl: 400 }, covers_range_end: false, last_priced: "2026-09-12" };
  assert.equal(heroBenchmark(b, 10000), null);
  assert.deepEqual(staleBenchmark(b), { label: "benchmark nieaktualny", title: "MSCI ACWI: ceny do 12.09" });
  assert.equal(staleBenchmark({ ...b, id: "my_mix" }).title, "my_mix: ceny do 12.09");
  assert.equal(staleBenchmark({ ...b, covers_range_end: true }), null);
  assert.equal(staleBenchmark({ ...b, covers_range_end: undefined }), null);
  assert.equal(staleBenchmark({ ...b, status: "missing" }), null);
  assert.deepEqual(heroBenchmark({ ...b, covers_range_end: true }, 10000), { value: 0.04, label: "MSCI ACWI, te same wpłaty" });
});
