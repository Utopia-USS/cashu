// F6 frontend integration (FE-INT), run with `npm test`: request error codes -> Polish labels, the review
// strip auto-open rule, the month's planned deposit, the decision journal, the alert delete undo through the
// restore endpoint, allocation drift neutral by default.
import assert from "node:assert/strict";
import { test } from "node:test";
import { describeError, errorText, LABELS } from "../src/core/messages.ts";
import { journalEntries, journalStats, planForMonth, polarityOf, reviewAutoOpen } from "../src/modules/investments/v2/logic.ts";
import { alertDeleteUndo, isMissingEndpoint, offerUndo, recreateInput, restoreOrRecreate } from "../src/modules/investments/v2/undoFlow.ts";

const apiError = (status, message, code = null) => Object.assign(new Error(message), { status, code });

test("error codes: the Polish label of X-Finanse-Error-Code, the English detail kept; unknown codes stay English", () => {
  const d = describeError(apiError(409, "XTB.WA is already on the watchlist", "watchlist_conflict"));
  assert.deepEqual(d, { text: "Ten instrument już jest na liście obserwowanych", detail: "XTB.WA is already on the watchlist", translated: true });
  assert.equal(errorText(apiError(409, "too late", "undo_expired")), "Za późno na cofnięcie: minęło 15 minut");
  // proposal codes ride the same header (agent_api `_code`)
  assert.equal(errorText(apiError(409, "proposal 4 is not pending", "not_pending")), LABELS["proposal.error.not_pending"]);
  assert.deepEqual(describeError(apiError(422, "level must be > 0", "something_new")), { text: "level must be > 0", detail: null, translated: false });
  assert.equal(errorText(apiError(500, "boom")), "boom");
  const net = new TypeError("Failed to fetch");
  assert.equal(errorText(net), "Brak połączenia z aplikacją (serwer finanse nie odpowiada)");
  assert.equal(errorText("plain string"), "plain string");
});

test("every error label is plain Polish without the em dash", () => {
  for (const [k, v] of Object.entries(LABELS)) {
    if (!k.startsWith("error.")) continue;
    assert.equal(typeof v, "string");
    assert.ok(!v.includes(String.fromCharCode(0x2014)), k);
  }
});

test("review strip opens by itself on the digest weekday while due, unless toggled this visit or light", () => {
  const base = { due: true, light: false, hasData: true, today: "2026-10-04", weekday: "sunday", explicit: null }; // 4.10.2026 is a Sunday
  assert.equal(reviewAutoOpen(base), true);
  assert.equal(reviewAutoOpen({ ...base, today: "2026-10-05" }), false); // Monday: on click only
  assert.equal(reviewAutoOpen({ ...base, weekday: "monday", today: "2026-10-05" }), true);
  assert.equal(reviewAutoOpen({ ...base, due: false }), false); // marked done
  assert.equal(reviewAutoOpen({ ...base, explicit: "0" }), false); // closed in this visit
  assert.equal(reviewAutoOpen({ ...base, explicit: "1" }), false); // already open (no second start)
  assert.equal(reviewAutoOpen({ ...base, light: true }), false);
  assert.equal(reviewAutoOpen({ ...base, hasData: false }), false);
});

test("planned deposit of a month: planned first (newest), else booked, never cancelled or other months", () => {
  const p = (id, planned_date, status) => ({ id, planned_date, status, amount: 1000 });
  assert.equal(planForMonth(null, "2026-10"), null);
  assert.equal(planForMonth([p(1, "2026-09-10", "planned")], "2026-10"), null);
  assert.equal(planForMonth([p(1, "2026-10-10", "cancelled")], "2026-10"), null);
  assert.equal(planForMonth([p(1, "2026-10-10", "booked"), p(2, "2026-10-12", "planned"), p(3, "2026-10-15", "planned")], "2026-10").id, 3);
  assert.equal(planForMonth([p(1, "2026-10-10", "booked"), p(4, "2026-10-01", "cancelled")], "2026-10").id, 1);
});

const sig = (o) => ({ id: 1, instrument_id: 306, status: "active", first_seen_at: "2026-09-29T07:00:00Z", closed_at: null, decisions: [], ...o });
const dec = (o) => ({ id: 10, signal_id: 1, instrument_id: 306, action: "held", created_at: "2026-09-30T18:00:00Z", ...o });

test("journal: decisions with their signal, signals as they appeared, expiries without a decision; filters", () => {
  const signals = [
    sig({ id: 1, decisions: [dec({})] }),
    sig({ id: 2, instrument_id: 305, status: "expired", first_seen_at: "2026-08-01T07:00:00Z", closed_at: "2026-08-20T07:00:00Z" }),
    sig({ id: 3, instrument_id: null, status: "resolved", first_seen_at: "2026-07-01T07:00:00Z", closed_at: "2026-07-05T07:00:00Z", decisions: [dec({ id: 11, signal_id: 3 })] }),
  ];
  const decisions = [dec({}), dec({ id: 12, signal_id: null, instrument_id: 305, action: "bought", created_at: "2026-10-02T10:00:00Z" })];
  const all = journalEntries(signals, decisions, "all");
  assert.deepEqual(all.map((e) => `${e.type}:${e.decision?.id ?? e.signal?.id}`), ["decision:12", "decision:10", "signal:1", "expired:2", "signal:2", "signal:3"]);
  assert.equal(all[1].signal.id, 1); // the decision carries the signal it answers
  assert.deepEqual(journalEntries(signals, decisions, "decisions").map((e) => e.decision.id), [12, 10]);
  assert.deepEqual(journalEntries(signals, decisions, "signals").map((e) => e.type), ["signal", "expired", "signal", "signal"]);
  // resolved with a decision: no "resolved without a decision" row
  assert.ok(!all.some((e) => e.type === "resolved"));
  assert.deepEqual(journalEntries(signals, decisions, "all", "305").map((e) => `${e.type}:${e.decision?.id ?? e.signal?.id}`), ["decision:12", "expired:2", "signal:2"]);
});

test("journal stats: decisions by action, decided vs expired, median days to the first decision", () => {
  const signals = [
    sig({ id: 1, first_seen_at: "2026-09-01T00:00:00Z", decisions: [dec({ created_at: "2026-09-03T00:00:00Z" })] }),
    sig({ id: 2, first_seen_at: "2026-09-10T00:00:00Z", decisions: [dec({ created_at: "2026-09-14T00:00:00Z" })] }),
    sig({ id: 3, status: "expired", first_seen_at: "2026-06-01T00:00:00Z" }),
    sig({ id: 4, first_seen_at: "2025-12-01T00:00:00Z" }),
  ];
  const decisions = [dec({ action: "held", created_at: "2026-09-03T00:00:00Z" }), dec({ id: 2, action: "bought", created_at: "2026-09-14T00:00:00Z" }), dec({ id: 3, action: "held", created_at: "2025-11-01T00:00:00Z" })];
  const s = journalStats(signals, decisions, "2026");
  assert.deepEqual(s, { decisions: 2, byAction: { held: 1, bought: 1 }, signals: 3, decided: 2, expired: 1, medianDays: 3 });
  assert.equal(journalStats([], [], "2026").medianDays, null);
});

test("alert delete undo: restore keeps the id; a server without the endpoint re-creates; 409 = too late", async () => {
  assert.equal(isMissingEndpoint(apiError(404, "Not Found")), true);
  assert.equal(isMissingEndpoint(apiError(405, "Method Not Allowed")), true);
  assert.equal(isMissingEndpoint(apiError(404, "alert 3 not found", "not_found")), false);
  const calls = [];
  assert.equal(await restoreOrRecreate(async () => calls.push("restore"), async () => calls.push("recreate")), "restored");
  assert.equal(await restoreOrRecreate(async () => { throw apiError(404, "Not Found"); }, async () => calls.push("recreate")), "recreated");
  assert.deepEqual(calls, ["restore", "recreate"]);
  await assert.rejects(restoreOrRecreate(async () => { throw apiError(500, "boom"); }, async () => calls.push("never")));
  assert.ok(!calls.includes("never"));

  let now = 1000;
  const expired = alertDeleteUndo(async () => { throw apiError(409, "too late", "undo_expired"); }, async () => null, () => now);
  assert.equal(await expired.undo(), "expired");
  const late = alertDeleteUndo(async () => null, async () => null, () => now);
  now += 16 * 60 * 1000;
  assert.equal(await late.undo(), "expired"); // the window is checked before any request
  const a = { id: 5, kind: "price_below", title: "CDR poniżej 140", params: { level: 140 }, instrument_id: 306, scope: "instrument", polarity: "positive", severity: "action", note: null, cooldown_days: 14, expires_at: null, source: "agent", status: "active" };
  assert.deepEqual(Object.keys(recreateInput(a)).sort(), ["cooldown_days", "expires_at", "instrument_id", "kind", "note", "params", "polarity", "scope", "severity", "title"]);
});

test("offerUndo: one toast with Cofnij, onDone after the undo, a failed undo offers Cofnij again", async () => {
  const toasts = [];
  const toast = (text, ms, action) => toasts.push({ text, action });
  let fail = true, done = 0;
  const u = alertDeleteUndo(async () => { if (fail) throw apiError(500, "boom"); }, async () => null);
  offerUndo(toast, "Usunięto alert", u, "usunięcie alertu", () => { done += 1; });
  assert.equal(toasts[0].text, "Usunięto alert");
  toasts[0].action.onClick();
  await new Promise((r) => setTimeout(r, 0));
  assert.match(toasts[1].text, /Nie udało się cofnąć/);
  fail = false;
  toasts[1].action.onClick();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(toasts[2].text, "Cofnięto: usunięcie alertu");
  assert.equal(done, 1);
});

test("F7 FE3/FE15: a re-created alert says so; a 404 on the restore stops offering Cofnij", async () => {
  const toasts = [];
  const toast = (text, ms, action) => toasts.push({ text, action });
  let recreated = false;
  const u = alertDeleteUndo(async () => { throw apiError(404, "Not Found"); }, async () => { recreated = true; });
  offerUndo(toast, "Usunięto alert", u, "usunięcie alertu", () => {}, 10000, () => (recreated ? "wraca jako nowy alert" : null));
  toasts[0].action.onClick();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(toasts[1].text, "Cofnięto: usunięcie alertu · wraca jako nowy alert");
  const t2 = [];
  const gone = alertDeleteUndo(async () => { throw apiError(404, "alert not found", "not_found"); }, async () => {});
  offerUndo((text, ms, action) => t2.push({ text, action }), "Usunięto alert", gone, "usunięcie alertu", () => {});
  t2[0].action.onClick();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(t2[1].text, "Już cofnięte: usunięcie alertu");
  assert.equal(t2[1].action, undefined);
});

test("owner decision 1: allocation drift is neutral unless the server says otherwise", () => {
  assert.equal(polarityOf({ kind: "allocation_drift" }), "neutral");
  assert.equal(polarityOf({ kind: "allocation_drift", polarity: "negative" }), "negative");
});

test("notification link ?signal=<id>: open -> the widget, closed -> asset drawer or journal, anything else -> home", async () => {
  const { signalLinkTarget } = await import("../src/modules/investments/v2/logic.ts");
  const open = [{ id: 7, instrument_id: 306, status: "active" }, { id: 8, instrument_id: null, status: "acknowledged" }];
  const all = [...open, { id: 3, instrument_id: 305, status: "expired" }, { id: 4, instrument_id: null, status: "resolved" }, { id: 9, instrument_id: 301, status: "active" }];
  assert.deepEqual(signalLinkTarget("7", open, all), { kind: "open", id: 7 });
  assert.deepEqual(signalLinkTarget("8", open, []), { kind: "open", id: 8 });
  assert.deepEqual(signalLinkTarget("9", open, all), { kind: "open", id: 9 }); // open but filtered out of the list (account filter)
  assert.deepEqual(signalLinkTarget("3", open, all), { kind: "asset", id: 3, instrumentId: 305, status: "expired" });
  assert.deepEqual(signalLinkTarget("4", open, all), { kind: "journal", id: 4, status: "resolved" });
  for (const bad of [null, "", "abc", "0", "-3", "3.5", "12; DROP", "999"]) assert.equal(signalLinkTarget(bad, open, all), null, String(bad));
});

test("alert signal facts and watchlist warnings from their codes (F6 BE message_code / warning_codes)", async () => {
  const { label, describeIssue } = await import("../src/core/messages.ts");
  const nb = (s) => s.replace(/ | /g, " ");
  assert.equal(nb(label("alert.price_below", { title: "CDR", label: "CDR", close: "138.2", level: "140", currency: "PLN" })), "cena 138,20 zł poniżej 140,00 zł");
  assert.equal(nb(label("alert.change_pct", { window_days: 30, change: 0.124, direction: "down", threshold: 0.1 })), "-12,4 % w 30 sesji (próg 10 %)");
  assert.equal(nb(label("alert.sma_cross", { close: "486.1", window_days: 200, direction: "below", currency: "EUR" })), "cena 486,10 € poniżej SMA 200");
  assert.equal(nb(label("alert.weight_above", { weight: 0.312, threshold: 0.3 })), "udział 31,2 % powyżej 30 %");
  assert.equal(label("alert.price_below", { level: "140" }), null); // missing params: the caller keeps the title only
  assert.equal(describeIssue({ code: "watchlist.guessed_price_symbol", params: { price_symbol: "CSPX.L" }, message: "x" }).text, "symbol ceny zgadnięty (CSPX.L): sprawdź, czy przyjdą notowania");
  assert.equal(describeIssue({ code: "watchlist.unknown", params: {}, message: "English" }).text, "English");
});
