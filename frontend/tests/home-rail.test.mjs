// The home rail next to the review deck (v2/railLogic.ts): Sygnały = new since the last review and what the review
// put off; Alerty = only the alerts close to their level or fired since the last review, with a tag and the title
// without its ticker.
import assert from "node:assert/strict";
import { test } from "node:test";
import { alertTag, railAlerts, railSignals, stripSubject } from "../src/modules/investments/v2/railLogic.ts";
import { decideItems } from "../src/modules/investments/v2/reviewDeckLogic.ts";

const NOW = Date.parse("2026-11-04T12:00:00Z");
const sig = (over) => ({ id: 1, rule_id: "r", kind: "custom", severity: "info", status: "active", message: "Wiadomość", instrument_id: null, instrument_label: null,
  payload: {}, first_seen_at: "2026-10-01T07:00:00Z", decisions: [], ...over });
const weak = (id, inst, first) => sig({ id, rule_id: "research:news", kind: "research:news", polarity: "negative", instrument_id: inst,
  payload: { relation: "weakens", title: `Teza ${inst} słabnie` }, first_seen_at: first });

test("railSignals: new since the review, put off by it (snoozed or undecided), and the rest left to the deck", () => {
  const REVIEW = "2026-11-02T18:00:00Z";
  const signals = [
    weak(1, 19, "2026-10-28T07:00:00Z"), // seen before the review, still undecided -> put off
    { ...weak(2, 3, "2026-10-28T07:00:00Z"), snoozed: true, snoozed_until: "2026-11-07" }, // snoozed in the review
    sig({ id: 3, rule_id: "dd35", kind: "drawdown_from_high", polarity: "positive", severity: "action", instrument_id: 40,
      payload: { drawdown: 0.354, threshold: 0.35 }, first_seen_at: "2026-11-03T09:00:00Z" }), // new since the review
  ];
  const { items } = decideItems(signals, null, new Map([[19, "Wydawca"], [3, "Uran"], [40, "Złoto"]]), [], { since: REVIEW, now: NOW, includeSnoozed: true });
  const { fresh, left } = railSignals(items, REVIEW);
  assert.deepEqual(fresh.map((d) => d.title), ["Złoto"]);
  assert.deepEqual(left.map((d) => [d.title, d.snoozedUntil ?? null]), [["Wydawca", null], ["Uran", "2026-11-07"]]);
  // Before any review covers them, subjects only wait in the deck: neither new (older than two weeks) nor put off.
  const before = decideItems([weak(1, 19, "2026-10-05T14:17:00Z")], null, undefined, [], { since: "2026-10-05T14:16:00Z", now: NOW, includeSnoozed: true });
  const r = railSignals(before.items, "2026-10-05T14:16:00Z");
  assert.deepEqual([r.fresh.length, r.left.length], [0, 0]);
  // The deck itself never shows a snoozed subject.
  assert.deepEqual(decideItems(signals, null, undefined, [], { since: REVIEW, now: NOW }).items.map((d) => d.instrumentId), [19, 40]);
});

const alert = (over) => ({ id: 1, kind: "drawdown_from_high", scope: "instrument", instrument_id: 7, instrument: { id: 7, label: "GOOGL", symbol: "GOOGL", name: "Alphabet" },
  params: { threshold: 0.3, window_days: 252 }, status: "active", title: "GOOGL: 30% pod rocznym szczytem", last_value: 0.295, last_triggered_at: null, ...over });

test("railAlerts: fired since the review first, then the close ones; far and long-fired alerts stay out", () => {
  const rows = railAlerts([
    alert({ id: 1 }), // 0.5 pp to go: close
    alert({ id: 2, last_value: 0.1, instrument: { id: 8, label: "MSFT", symbol: "MSFT", name: "Microsoft" }, title: "MSFT: 30% pod rocznym szczytem" }), // far
    alert({ id: 3, status: "triggered", last_triggered_at: "2026-11-03T08:00:00Z", instrument: { id: 9, label: "NFLX", symbol: "NFLX", name: "Netflix" }, title: "NFLX: 30% pod rocznym szczytem", tag: "spadek" }),
    alert({ id: 4, status: "triggered", last_triggered_at: "2026-10-05T08:00:00Z" }), // fired before the review: gone
    alert({ id: 5, kind: "sma_cross", params: { window: 200, direction: "up" }, last_value: 1, title: "Przebicie SMA 200" }), // no distance: never close
  ], null, "2026-11-02T18:00:00Z", NOW);
  assert.deepEqual(rows.map((r) => [r.id, r.state, r.tag, r.title]), [
    [3, "met", "spadek", "30% pod rocznym szczytem"],
    [1, "near", "cena", "30% pod rocznym szczytem"],
  ]);
  assert.match(rows[1].extra ?? "", /^brakuje /);
  assert.match(rows[0].extra ?? "", /^od 3\.11$/);
});

test("alertTag and stripSubject: the own tag first, else one by kind; only a leading ticker is cut", () => {
  assert.equal(alertTag({ kind: "volume_spike" }), "wolumen");
  assert.equal(alertTag({ kind: "range_breakout", tag: " wybicie " }), "wybicie");
  assert.equal(alertTag({ kind: "nowy_rodzaj" }), "własna");
  assert.equal(stripSubject("NFLX: 30% pod szczytem", "NFLX"), "30% pod szczytem");
  assert.equal(stripSubject("BRK.B - limit udziału", "BRK.B"), "limit udziału");
  assert.equal(stripSubject("Udział ETF globalnego", "GLBA"), "Udział ETF globalnego");
  assert.equal(stripSubject("NFLX:", "NFLX"), "NFLX:");
});

test("railSignals: a subject the review put off stays even without a reason now (snoozed, or new in that review)", () => {
  const REVIEW = "2026-11-02T18:00:00Z";
  const dd = (id, inst, over) => sig({ id, rule_id: `dd${id}`, kind: "drawdown_from_high", polarity: "positive", instrument_id: inst,
    payload: { drawdown: 0.3, threshold: 0.2 }, first_seen_at: "2026-10-30T07:00:00Z", ...over });
  const signals = [dd(1, 40, { snoozed: true, snoozed_until: "2026-11-09" }), dd(2, 41), dd(3, 42, { first_seen_at: "2026-09-01T07:00:00Z" })];
  const opts = { since: REVIEW, now: NOW, includeSnoozed: true, lastReviewAt: REVIEW, limit: Infinity };
  const { items, rest } = decideItems(signals, null, new Map([[40, "A"], [41, "B"], [42, "C"]]), [], opts);
  const { fresh, left } = railSignals(items, REVIEW);
  assert.deepEqual(fresh.length, 0);
  assert.deepEqual(left.map((d) => [d.title, d.snoozedUntil ?? null]), [["A", "2026-11-09"], ["B", null]]);
  assert.equal(rest.review, 1); // C: older than that review's window, an unchanged state
  // the deck itself is unchanged: none of them has a reason there
  assert.equal(decideItems(signals, null, undefined, [], { since: REVIEW, now: NOW }).items.length, 0);
});

test("railSignals: no limit for the rail; a thesis change after the review is new, not put off", () => {
  const REVIEW = "2026-11-02T18:00:00Z";
  const many = Array.from({ length: 8 }, (_, i) => sig({ id: i + 1, rule_id: `r${i}`, kind: "loss_from_cost", polarity: "negative", instrument_id: 100 + i,
    payload: { unrealized_pct: -0.3, threshold: 0.25 }, first_seen_at: "2026-11-03T07:00:00Z" }));
  const all = decideItems(many, null, undefined, [], { since: REVIEW, now: NOW, includeSnoozed: true, lastReviewAt: REVIEW, limit: Infinity });
  assert.equal(railSignals(all.items, REVIEW).fresh.length, 8);
  const research = { theses_changed: [{ instrument_id: 5, label: "ACME", from: "current", to: "weakened" }] };
  const old = [sig({ id: 1, rule_id: "dd", kind: "drawdown_from_high", instrument_id: 5, payload: { drawdown: 0.3, threshold: 0.2 }, first_seen_at: "2026-10-20T07:00:00Z" })];
  const r = railSignals(decideItems(old, research, undefined, [], { since: REVIEW, now: NOW, includeSnoozed: true, lastReviewAt: REVIEW }).items, REVIEW);
  assert.deepEqual([r.fresh.length, r.left.length], [1, 0]);
  const late = [weak(7, 6, "2026-11-03T07:00:00Z")];
  assert.equal(railSignals(decideItems(late, null, undefined, [], { since: REVIEW, now: NOW, includeSnoozed: true, lastReviewAt: REVIEW }).items, REVIEW).fresh.length, 1);
});

test("railAlerts without a digest still shows the alerts fired in the last two weeks; stripSubject keeps names", () => {
  const rows = railAlerts([alert({ id: 3, status: "triggered", last_triggered_at: "2026-11-03T08:00:00Z" })], null, null, NOW);
  assert.equal(rows.length, 1);
  assert.equal(stripSubject("PKO-BP spada", "PKO"), "PKO-BP spada");
  assert.equal(stripSubject("BRK-B: x", "BRK"), "BRK-B: x");
  assert.equal(stripSubject("CDR – premiera", "CDR"), "premiera");
});
