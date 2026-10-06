// Asset detail v3 pure logic (design/v3/asset-detail/asset-detail.md 3, 6, 7): the timeline (one fact per row,
// no duplicates), the open rows, the header's lot table and meta line, the note row's relation icon.
import assert from "node:assert/strict";
import { test } from "node:test";
import { assetTimeline, factText, headerMeta, lotRows, openRows } from "../src/modules/investments/v2/logic.ts";
import { noteRowTitle, relationIcon, sourceParts } from "../src/modules/investments/v2/research/logic.ts";
import { staleSignalText, writePositionDecision } from "../src/modules/investments/v2/decisionFlow.ts";
import { isMissingRoute } from "../src/core/missingRoute.ts";

/** Spaces of any kind (the formatters use NBSP / NNBSP) compare as one plain space. */
const sp = (v) => (typeof v === "string" ? v.replace(/[\s\u00a0\u202f]+/g, " ").replace(/ USD\b/g, " $") : v);
const eq = (a, b, m) => assert.equal(sp(a), sp(b), m);
const sig = (over) => ({
  id: 1, rule_id: "r", kind: "loss_from_cost", severity: "action", status: "active", message: "m", instrument_id: 7, instrument_label: "NVRT",
  payload: { unrealized_pct: -0.318 }, first_seen_at: "2026-10-05T07:00:00Z", decisions: [], ...over,
});
const dec = (over) => ({ id: 1, signal_id: null, instrument_id: 7, account_id: null, action: "held", quantity: null, price: null, currency: "USD", reason: null, created_at: "2026-10-05T10:00:00Z", ...over });
const base = { signals: [], decisions: [], theses: [], txns: [], currency: "USD" };
const tl = (o, limit) => assetTimeline({ ...base, ...o }, limit);

test("factText: the Fact1 text without bold", () => {
  eq(factText({ bold: "-31,8 %", post: "od kosztu" }), "-31,8 % od kosztu");
  eq(factText({ pre: "gotówka", bold: "4 %", post: ", maks 5 %" }), "gotówka 4 %, maks 5 %");
  eq(factText({ pre: "Reguła własna", bold: "" }), "Reguła własna");
});

test("assetTimeline: a decision with quantity and price, the reason as sub", () => {
  const rows = tl({ decisions: [dec({ id: 5, action: "bought", quantity: 10, price: 44.8, reason: "transza po dołku" })] });
  assert.equal(rows.length, 1);
  eq(`${rows[0].head} · ${rows[0].fact}`, "Decyzja · dokupuję 10 szt. @ 44,80 $");
  assert.equal(rows[0].sub, "transza po dołku");
  assert.equal(rows[0].dot, "nw");
  eq(tl({ decisions: [dec({ action: "held", reason: "czekam" })] })[0].fact, "bez zmian");
});

test("assetTimeline: acknowledgements name the linked signal by signal_id or signal_ids", () => {
  const s = sig({ id: 3, status: "acknowledged", decisions: [{ action: "held", quantity: null, created_at: "2026-10-05T10:00:00Z" }] });
  const a = tl({ signals: [s], decisions: [dec({ id: 9, signal_id: 3, reason: "acknowledged" })] });
  assert.equal(a.length, 1, "the acknowledged open signal is not a row of its own");
  eq(`${a[0].head} · ${a[0].fact}`, "Potwierdzone · -31,8 % od kosztu");
  assert.equal(a[0].dot, "neu");
  assert.equal(a[0].sub, undefined);
  const b = tl({ signals: [s], decisions: [dec({ id: 9, signal_id: null, signal_ids: [3], reason: "acknowledged" })] });
  eq(b[0].fact, "-31,8 % od kosztu");
  eq(tl({ decisions: [dec({ id: 9, signal_id: 99, reason: "acknowledged" })] })[0].fact, "");
});

test("assetTimeline: a fan-out acknowledgement of the same minute folds into the decision", () => {
  const s1 = sig({ id: 1, decisions: [{ action: "bought", quantity: 10, created_at: "2026-10-05T10:00:10Z" }] });
  const s2 = sig({ id: 2, kind: "drawdown_from_high", payload: { drawdown: 0.264, window_days: 252 }, decisions: [{ action: "held", quantity: null, created_at: "2026-10-05T10:00:11Z" }] });
  const rows = tl({
    signals: [s1, s2],
    decisions: [
      dec({ id: 10, signal_id: 1, action: "bought", quantity: 10, price: null, reason: "plan", created_at: "2026-10-05T10:00:10Z" }),
      dec({ id: 11, signal_id: 2, action: "held", reason: "decyzja: dokupuję 10 szt.", created_at: "2026-10-05T10:00:11Z" }),
    ],
  });
  assert.equal(rows.length, 1);
  eq(`${rows[0].head} · ${rows[0].fact}`, "Decyzja · dokupuję 10 szt.");
  assert.match(sp(rows[0].title), /-26,4 % od szczytu 52 tyg\./);
  assert.equal(rows[0].title.split("\n")[0], "plan");
  // a lone fan-out acknowledgement (no decision that minute) reads as an acknowledgement, without a sub
  const lone = tl({ signals: [s2], decisions: [dec({ id: 11, signal_id: 2, reason: "decyzja: bez zmian" })] });
  eq(`${lone[0].head} · ${lone[0].fact}`, "Potwierdzone · -26,4 % od szczytu 52 tyg.");
});

test("assetTimeline: open signals are not rows; closed ones are, with wygasł when expired", () => {
  const rows = tl({
    signals: [
      sig({ id: 1, status: "active" }),
      sig({ id: 2, status: "resolved", first_seen_at: "2026-08-20T07:00:00Z", payload: { unrealized_pct: -0.214 } }),
      sig({ id: 3, status: "expired", first_seen_at: "2026-08-10T07:00:00Z", payload: { unrealized_pct: -0.2 } }),
      sig({ id: 4, status: "resolved", kind: "research:weakens", polarity: "negative", payload: { title: "Novarent: II kw.", relation: "weakens" }, first_seen_at: "2026-08-01T07:00:00Z" }),
    ],
  });
  assert.deepEqual(rows.map((r) => r.key), ["s:2", "s:3", "s:4"]);
  eq(`${rows[0].head} · ${rows[0].fact}`, "Ryzyko · -21,4 % od kosztu");
  assert.equal(rows[0].tail, undefined);
  assert.equal(rows[1].tail, "wygasł");
  assert.equal(rows[0].dot, "neu");
  assert.equal(rows[2].head, "Ryzyko", "closed research signals are history");
});

test("assetTimeline: review, buys, newest first, limit", () => {
  const rows = tl({
    theses: [{ reviewed_at: "2026-09-15T08:00:00Z" }, { reviewed_at: "2026-09-15T08:00:00Z" }, { reviewed_at: null }],
    txns: [
      { id: 1, type: "buy", trade_date: "2024-11-04", quantity: 20, price: 71.2, currency: "USD" },
      { id: 2, type: "buy", trade_date: "2025-03-12", quantity: 15, price: 58.4, currency: "USD" },
      { id: 3, type: "dividend", trade_date: "2025-06-01", quantity: null, price: null, currency: "USD" },
    ],
    decisions: [dec({ id: 4, action: "held", reason: "czekam", created_at: "2026-09-02T10:00:00Z" })],
  });
  assert.deepEqual(rows.map((r) => r.head), ["Przegląd tezy", "Decyzja", "Kupno", "Kupno"]);
  eq(rows[2].fact, "15 @ 58,40 $");
  assert.equal(rows[0].fact, "");
  assert.equal(tl({ txns: Array.from({ length: 20 }, (_, i) => ({ id: i, type: "buy", trade_date: `2025-01-${String(i + 1).padStart(2, "0")}`, quantity: 1, price: 1, currency: "USD" })) }).length, 12);
  assert.equal(tl({ txns: [{ id: 1, type: "sell", trade_date: "2025-01-01", quantity: 1, price: 1, currency: "USD" }] }, 5)[0].head, "Sprzedaż");
});

test("openRows: undecided only, snoozed out, byTime order", () => {
  const rows = openRows([
    sig({ id: 1, first_seen_at: "2026-10-01T07:00:00Z" }),
    sig({ id: 2, first_seen_at: "2026-10-05T07:00:00Z" }),
    sig({ id: 3, status: "acknowledged", decisions: [{ action: "held", quantity: null, created_at: "2026-10-05T10:00:00Z" }] }),
    sig({ id: 4, snoozed: true }),
    sig({ id: 5, status: "resolved" }),
    sig({ id: 6, status: "acknowledged", first_seen_at: "2026-10-03T07:00:00Z" }),
  ]);
  assert.deepEqual(rows.map((s) => s.id), [2, 6, 1]);
});

test("lotRows: sorted by date, multi across accounts, result %", () => {
  const lot = (over) => ({ account_id: 1, open_date: "2025-03-12", quantity: 10, unit_cost: 50, currency: "USD", open_txn_id: null, result: -100, ...over });
  const r = lotRows([lot({}), lot({ open_date: "2024-11-04", account_id: 2 })]);
  assert.deepEqual(r.rows.map((l) => l.open_date), ["2024-11-04", "2025-03-12"]);
  assert.equal(r.multi, true);
  assert.equal(r.rows[0].resultPct, -0.2);
  assert.equal(lotRows([lot({}), lot({})]).multi, false);
  assert.equal(lotRows([lot({ unit_cost: null })]).rows[0].resultPct, null);
});

test("headerMeta: lots, transactions, dividends, fees", () => {
  const m = (o) => headerMeta({ lots: 2, txns: 4, dividends: {}, fees: 9.8, currency: "USD", ...o });
  const lots = (o) => m(o)[0];
  assert.deepEqual(lots({ lots: 1 }), { kind: "lots", text: "1 lot", toggle: false });
  assert.deepEqual(lots({ lots: 2 }), { kind: "lots", text: "2 loty", toggle: true });
  assert.deepEqual(lots({ lots: 5 }), { kind: "lots", text: "5 lotów", toggle: true });
  assert.deepEqual(lots({ lots: 0 }), { kind: "lots", text: "brak lotów", toggle: false });
  eq(m({ txns: 1 })[1].text, "1 transakcja");
  eq(m({ txns: 4 })[1].text, "4 transakcje");
  eq(m({ txns: 5 })[1].text, "5 transakcji");
  eq(m({ txns: null })[1].text, "transakcje");
  eq(m({})[2].value, "0,00 $");
  eq(m({ dividends: { USD: 12.4, PLN: 0, EUR: 1 } })[2].value, "12,40 $, 1,00 €");
  eq(m({})[3].value, "9,80 $");
});

test("relationIcon: the effect on the thesis", () => {
  assert.deepEqual(relationIcon("supports"), { cls: "sup", glyph: "+", label: "wzmacnia tezę" });
  assert.deepEqual(relationIcon("weakens"), { cls: "weak", glyph: "−", label: "osłabia tezę" });
  assert.deepEqual(relationIcon("invalidates"), { cls: "inv", glyph: "−", label: "podważa tezę" });
  for (const r of ["neutral", "none", "whatever", null]) assert.deepEqual(relationIcon(r), { cls: "neu", glyph: "~", label: "nie dotyczy tezy" });
});

test("noteRowTitle and sourceParts", () => {
  eq(noteRowTitle({ kind: "earnings", observed_at: "2026-07-29T08:00:00Z", dismissed_at: null, expires_at: null }, "2026-10-06"), "wyniki · 29.07");
  eq(noteRowTitle({ kind: "community", observed_at: "2026-07-29T08:00:00Z", dismissed_at: "2026-10-05T08:00:00Z", expires_at: null }, "2026-10-06"), "społeczność · 29.07 · odrzucona 5.10");
  eq(noteRowTitle({ kind: "news", observed_at: "2026-07-29T08:00:00Z", dismissed_at: null, expires_at: "2026-09-01" }, "2026-10-06"), "wiadomość · 29.07 · wygasła 1.09");
  assert.deepEqual(sourceParts({ url: "https://x.example/a", publisher: "Bloomberg", published_at: "2026-02-04" }), { who: "Bloomberg", date: "4.02" });
  assert.deepEqual(sourceParts({ url: "https://www.example.com/a" }), { who: "example.com", date: null });
});

test("assetTimeline: fan-out folding across a minute boundary, the same tag wins", () => {
  const s2 = sig({ id: 2, kind: "drawdown_from_high", payload: { drawdown: 0.264, window_days: 252 } });
  const ack = dec({ id: 11, signal_id: 2, reason: "decyzja: bez zmian", created_at: "2026-10-05T12:01:00.200Z" });
  // 12:00:59.8 and 12:01:00.2: different floor minutes, still one act
  const rows = tl({ signals: [s2], decisions: [dec({ id: 10, action: "held", reason: "plan", created_at: "2026-10-05T12:00:59.800Z" }), ack] });
  assert.deepEqual(rows.map((r) => r.key), ["d:10"]);
  // two decisions within 60 s: the one whose tag matches takes the acknowledgement, even when farther
  const two = tl({ signals: [s2], decisions: [
    dec({ id: 20, action: "bought", quantity: 5, reason: "inna", created_at: "2026-10-05T12:01:00.100Z" }),
    dec({ id: 21, action: "held", reason: "plan", created_at: "2026-10-05T12:00:30.000Z" }), ack] });
  assert.deepEqual(two.map((r) => r.key).sort(), ["d:20", "d:21"]);
  assert.match(sp(two.find((r) => r.key === "d:21").title), /-26,4 % od szczytu/);
  assert.doesNotMatch(sp(two.find((r) => r.key === "d:20").title ?? ""), /od szczytu/);
  // more than 60 s apart: an acknowledgement of its own
  const far = tl({ signals: [s2], decisions: [dec({ id: 10, action: "held", reason: "plan", created_at: "2026-10-05T11:59:59.000Z" }), ack] });
  assert.deepEqual(far.map((r) => r.key), ["a:11", "d:10"]);
});

const ok = (id) => async () => ({ decision: { id } });
const fail = (e) => async () => { throw e; };
const NF = Object.assign(new Error("Not Found"), { status: 404, code: null });

test("writePositionDecision: the position endpoint, one id", async () => {
  const out = await writePositionDecision({ legacy: false, post: ok(7), fanOut: [ok(1)], isMissingRoute });
  assert.deepEqual(out, { kind: "saved", ids: [7], legacy: false });
});

test("writePositionDecision: missing route falls back to the fan-out", async () => {
  const out = await writePositionDecision({ legacy: false, post: fail(NF), fanOut: [ok(1), ok(2), ok(3)], isMissingRoute });
  assert.deepEqual(out, { kind: "saved", ids: [1, 2, 3], legacy: true });
  // known legacy: the endpoint is not tried again
  let tried = false;
  const again = await writePositionDecision({ legacy: true, post: async () => { tried = true; return { decision: { id: 9 } }; }, fanOut: [ok(4)], isMissingRoute });
  assert.equal(tried, false);
  assert.deepEqual(again, { kind: "saved", ids: [4], legacy: true });
});

test("writePositionDecision: missing route without signals needs a signal", async () => {
  assert.deepEqual(await writePositionDecision({ legacy: false, post: fail(NF), fanOut: [], isMissingRoute }), { kind: "needs-signal", legacy: true });
});

test("writePositionDecision: a specific 404 is a failure, not a missing route", async () => {
  const e = Object.assign(new Error("No signal 12"), { status: 404, code: null });
  const out = await writePositionDecision({ legacy: false, post: fail(e), fanOut: [ok(1)], isMissingRoute });
  assert.equal(out.kind, "failed");
  assert.equal(out.legacy, false);
  assert.equal(out.error, e);
});

test("writePositionDecision: a fan-out failing midway keeps the saved ids", async () => {
  const e = Object.assign(new Error("boom"), { status: 500 });
  const out = await writePositionDecision({ legacy: true, post: ok(0), fanOut: [ok(1), fail(e), ok(3)], isMissingRoute });
  assert.deepEqual(out, { kind: "partial", ids: [1], error: e, legacy: true });
  const first = await writePositionDecision({ legacy: true, post: ok(0), fanOut: [fail(e), ok(3)], isMissingRoute });
  assert.deepEqual(first, { kind: "failed", error: e, legacy: true });
});

test("staleSignalText: 409 closed, 422 other instrument, else null", () => {
  assert.equal(staleSignalText({ status: 409, message: "Signal 12 is resolved" }), "Sygnał już zamknięty");
  assert.equal(staleSignalText({ status: 422, message: "Signal 12 is not about instrument 7" }), "Sygnał dotyczy innego instrumentu");
  assert.equal(staleSignalText({ status: 422, message: "quantity must be positive" }), null);
  assert.equal(staleSignalText(new Error("x")), null);
});
