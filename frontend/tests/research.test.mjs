// Research layer pure logic (src/modules/investments/v2/research/logic.ts) and its place in the home grid
// (src/grid.ts `defer`), run with `npm test`.
import assert from "node:assert/strict";
import { test } from "node:test";
import { twoColumnOrder } from "../src/grid.ts";
import {
  acceptedAt, candidateCriteria, candidateReturn, chipsFromFields, countsText, isRestorable, latestTitle, normDirection, noteSubject, signalWord, watchItemId, criterionText, direction, directionChange, expiryText, fieldChips, freshness, healthOf,
  HEALTH_CLS, HEALTH_LABEL, isResearchKind, nextSaturday, normHealth, noteWhen, orderTheses, relationCounts,
  researchCommand, researchSignalText, runTag, safeUrl, scheduleSteps, workspacePath, sentiment8w, sentimentBars, showStrip, signalNoteId, sourceText, thesisHealth,
  weekLabels, weekScore, weekStarts, windowStart,
} from "../src/modules/investments/v2/research/logic.ts";

const note = (over) => ({
  id: 1, instrument_id: 306, theme: null, kind: "news", polarity: "negative", strength: 2, thesis_relation: "none", title: "t", summary: "",
  sources: [{ url: "https://example.org/a", publisher: "Parkiet", published_at: "2026-10-02" }], observed_at: "2026-10-03T06:50:00+02:00",
  expires_at: "2026-11-02T06:50:00+01:00", created_by: "agent", dismissed_at: null, ...over,
});

// ---- sentiment ----------------------------------------------------------------------------------------

test("sentiment score: sum(sign * strength) / (3 * notes); community capped at 1; dismissed left out; empty = null", () => {
  assert.equal(weekScore([]), null);
  assert.equal(weekScore([note({ polarity: "positive", strength: 3 })]), 1);
  assert.equal(weekScore([note({ polarity: "negative", strength: 3 })]), -1);
  // 3 (pos s3) - 1 (neg s1) + 0 (neutral) over 3 notes -> 2 / 9
  assert.equal(weekScore([note({ polarity: "positive", strength: 3 }), note({ polarity: "negative", strength: 1 }), note({ polarity: "neutral", strength: 3 })]), 0.222);
  // community strength 3 counts as 1: (-1) / (3 * 1)
  assert.equal(weekScore([note({ kind: "community", polarity: "negative", strength: 3 })]), -0.333);
  // a dismissed note does not count, so the week is empty
  assert.equal(weekScore([note({ dismissed_at: "2026-10-04T10:00:00Z" })]), null);
  // strength outside 1-3 is clamped
  assert.equal(weekScore([note({ polarity: "positive", strength: 7 })]), 1);
});

test("sentiment 8 weeks: ISO weeks ending with the current one, oldest first; labels every other week", () => {
  const weeks = weekStarts("2026-10-03");
  assert.deepEqual(weeks, ["2026-08-10", "2026-08-17", "2026-08-24", "2026-08-31", "2026-09-07", "2026-09-14", "2026-09-21", "2026-09-28"]);
  assert.deepEqual(weekLabels(weeks), ["10.08", "", "24.08", "", "7.09", "", "21.09", ""]);
  const vals = sentiment8w([
    note({ observed_at: "2026-10-03T06:50:00+02:00", polarity: "negative", strength: 3 }),
    note({ observed_at: "2026-09-28T09:00:00+02:00", polarity: "negative", strength: 1 }),
    note({ observed_at: "2026-08-12T09:00:00+02:00", polarity: "positive", strength: 2 }),
    note({ observed_at: "2026-07-01T09:00:00+02:00", polarity: "positive", strength: 3 }), // before the window
  ], "2026-10-03");
  assert.equal(vals.length, 8);
  assert.equal(vals[0], 0.667);
  assert.deepEqual(vals.slice(1, 7), [null, null, null, null, null, null]);
  assert.equal(vals[7], -0.667);
});

test("sentiment bars: empty week = 2 px tick on the baseline, positive rises, negative falls, values clamped", () => {
  const { mid, bars } = sentimentBars([0.5, null, -1, 0, 3], 50, 18);
  assert.equal(mid, 9.5);
  assert.equal(bars.length, 5);
  assert.deepEqual([bars[1].cls, bars[1].h, bars[1].y], ["none", 2, 8.5]);
  assert.equal(bars[0].cls, "pos");
  assert.ok(bars[0].y + bars[0].h <= mid + 1e-9 && bars[0].h > 2);
  assert.equal(bars[2].cls, "neg");
  assert.equal(bars[2].y, mid);
  assert.equal(bars[2].h, mid - 2);
  assert.equal(bars[3].cls, "none"); // balanced week: a bar of minimum height, not "no data"
  assert.equal(bars[3].h, 2);
  assert.equal(bars[4].h, mid - 2); // 3 -> clamped to 1
  // the large chart keeps a band for the date labels
  const lg = sentimentBars([1], 300, 72, 13);
  assert.equal(lg.mid, 30.5);
  assert.ok(lg.bw <= 14);
});

test("theme direction: last 4 weeks vs the previous 4, more than 1.0 apart; change wording", () => {
  assert.equal(direction([0.2, 0.3, null, 0, -0.2, -0.3, -0.5, -0.8]), "down");
  assert.equal(direction([0.1, 0.3, 0.2, 0.4, null, 0.5, 0.3, 0.6]), "flat"); // +0.4 only
  assert.equal(direction([-0.4, -0.3, null, null, 0.3, 0.4, 0.2, 0.5]), "up");
  assert.equal(direction([null, null, null, null, null, null, null, null]), "flat");
  assert.equal(directionChange("up", "down"), "z rośnie na słabnie");
  assert.equal(directionChange("flat", "falling"), "ze stabilnie na słabnie");
  assert.equal(directionChange("down", "up"), "ze słabnie na rośnie");
  assert.equal(directionChange("up", "up"), null);
});

// ---- thesis health ------------------------------------------------------------------------------------

test("thesis health: the six states of research.md 5", () => {
  const today = "2026-10-05";
  const h = (notes, o = {}) => thesisHealth({ hasThesis: true, notes, today, ...o });
  assert.equal(thesisHealth({ hasThesis: false, notes: [note({ thesis_relation: "invalidates" })], today }), "no_thesis");
  assert.equal(h([note({ thesis_relation: "weakens" }), note({ thesis_relation: "invalidates" })]), "inv");
  assert.equal(h([note({ thesis_relation: "weakens" }), note({ thesis_relation: "supports" })]), "weak");
  assert.equal(h([note({ thesis_relation: "supports" }), note({ thesis_relation: "neutral" })]), "sup");
  assert.equal(h([note({ thesis_relation: "neutral" })]), "ok");
  assert.equal(h([], { researchedAt: "2026-10-03T07:10:00+02:00" }), "ok"); // a run covered it, nothing found
  assert.equal(h([]), "no_research");
  assert.equal(h([], { researchedAt: "2026-08-20T07:10:00+02:00" }), "no_research"); // older than 30 days
});

test("thesis health: 30-day window, reset on thesis edit, dismissed and expired notes do not count", () => {
  const today = "2026-10-05";
  const old = note({ thesis_relation: "weakens", observed_at: "2026-08-30T07:00:00+02:00", expires_at: "2026-12-01T00:00:00+01:00" });
  assert.equal(thesisHealth({ hasThesis: true, notes: [old], today }), "no_research"); // 36 days old
  const recent = note({ thesis_relation: "weakens", observed_at: "2026-09-26T07:00:00+02:00" });
  assert.equal(thesisHealth({ hasThesis: true, notes: [recent], today }), "weak");
  // the thesis was edited after the note: the health starts clean (design answer 2)
  assert.equal(windowStart(today, "2026-10-01T18:00:00+02:00"), "2026-10-01");
  assert.equal(windowStart(today, "2026-01-01"), "2026-09-05");
  assert.equal(thesisHealth({ hasThesis: true, notes: [recent], today, thesisEditedAt: "2026-10-01T18:00:00+02:00", researchedAt: "2026-10-03T07:00:00+02:00" }), "ok");
  assert.equal(thesisHealth({ hasThesis: true, notes: [note({ thesis_relation: "invalidates", dismissed_at: "2026-10-04T09:00:00Z" })], today }), "no_research");
  assert.equal(thesisHealth({ hasThesis: true, notes: [note({ thesis_relation: "invalidates", expires_at: "2026-10-04T00:00:00Z" })], today }), "no_research");
});

test("health mapping: server names normalised, pill class and label per state, derived fallback from counts", () => {
  assert.equal(normHealth("invalidated"), "inv");
  assert.equal(normHealth("weakened"), "weak");
  assert.equal(normHealth("supported"), "sup");
  assert.equal(normHealth("current"), "ok");
  assert.equal(normHealth("no_thesis"), "no_thesis");
  assert.equal(normHealth("no_research"), "no_research");
  assert.equal(normHealth("bogus"), null);
  assert.deepEqual(Object.keys(HEALTH_LABEL).map((k) => [HEALTH_LABEL[k], HEALTH_CLS[k]]), [
    ["podważona", "inv"], ["osłabiona", "weak"], ["spełniona", "ful"], ["wzmocniona", "sup"], ["aktualna", ""], ["bez tezy", "none"], ["bez researchu", "none muted"],
  ]);
  const counts = { supports: 0, weakens: 2, invalidates: 0, neutral: 0, community: 0 };
  assert.equal(healthOf({ health: "supported", counts, last_researched_at: null }, "2026-10-05"), "sup"); // server wins
  assert.equal(healthOf({ health: null, counts, last_researched_at: null }, "2026-10-05"), "weak");
  assert.equal(healthOf({ health: null, has_thesis: false, counts, last_researched_at: null }, "2026-10-05"), "no_thesis");
  assert.equal(healthOf({ health: null, counts: { ...counts, weakens: 0 }, last_researched_at: "2026-10-03" }, "2026-10-05"), "ok");
  assert.equal(healthOf({ health: null, counts: { ...counts, weakens: 0 }, last_researched_at: null }, "2026-10-05"), "no_research");
});

test("health counts line and thesis field chips (Polish verb agreement)", () => {
  const c = relationCounts([note({ thesis_relation: "weakens" }), note({ thesis_relation: "weakens" }), note({ kind: "community", thesis_relation: "neutral" })]);
  assert.deepEqual(c, { supports: 0, weakens: 2, invalidates: 0, fulfills: 0, neutral: 1, community: 1 });
  assert.equal(countsText("weak", { ...c, community: 0 }), "2 osłabiają · 0 wzmacnia");
  assert.equal(countsText("sup", { supports: 1, weakens: 0, invalidates: 0, neutral: 0, community: 1 }), "1 wzmacnia · 1 szum");
  assert.equal(countsText("weak", { supports: 0, weakens: 5, invalidates: 0, neutral: 0, community: 0 }), "5 osłabia · 0 wzmacnia");
  assert.equal(countsText("inv", { supports: 0, weakens: 0, invalidates: 1, neutral: 0, community: 0 }), "1 podważa · 0 wzmacnia");
  assert.equal(countsText("no_thesis", c, { notes: 3, latestPolarity: "negative" }), "3 notatki · ostatnio negatywna");
  assert.equal(countsText("ok", { supports: 0, weakens: 0, invalidates: 0, neutral: 2, community: 0 }), "2 neutralne");
  const chips = fieldChips([
    note({ thesis_relation: "weakens", thesis_field: "thesis" }), note({ thesis_relation: "supports", thesis_field: "thesis" }),
    note({ thesis_relation: "weakens", thesis_field: "entry" }), note({ thesis_relation: "neutral", thesis_field: "exit_plan" }),
  ]);
  assert.deepEqual([...chips.entries()], [["thesis", { relation: "weakens", text: "2 notatki osłabiają" }]]);
  assert.equal(fieldChips([note({ thesis_relation: "invalidates", thesis_field: "invalidation" })]).get("invalidation").text, "1 notatka podważa");
});

test("thesis rows: the server's attention order (invalidated, weakened, no_research, no_thesis, supported, current), then weight", () => {
  const rows = orderTheses([
    { label: "VWCE", health: "no_thesis", weight: 0.4 }, { label: "KGHM", health: "sup", weight: 0.05 },
    { label: "EIMI", health: "weak", weight: 0.006 }, { label: "CDR", health: "weak", weight: 0.057 }, { label: "X", health: "inv", weight: 0.01 },
  ]);
  assert.deepEqual(rows.map((r) => r.label), ["X", "CDR", "EIMI", "VWCE", "KGHM"]);
});

// ---- note card copy -----------------------------------------------------------------------------------

test("note dates, freshness, expiry and source text", () => {
  const today = "2026-10-05";
  assert.equal(noteWhen("2026-10-05T06:00:00+02:00", today), "dziś");
  assert.equal(noteWhen("2026-10-04T06:00:00+02:00", today), "wczoraj");
  assert.equal(noteWhen("2026-10-03T06:00:00+02:00", today), "sob 3.10");
  assert.equal(noteWhen("2026-09-30T06:00:00+02:00", today), "30.09");
  assert.equal(freshness("2026-09-29", today), "fresh");
  assert.equal(freshness("2026-09-20", today), "muted");
  assert.equal(freshness("2026-09-01", today), "old");
  assert.equal(expiryText({ expires_at: "2026-11-02T06:50:00+01:00" }, today), "wygasa 2.11");
  assert.equal(expiryText({ expires_at: "2026-10-01T06:50:00+02:00" }, today), "wygasła 1.10");
  assert.equal(sourceText({ url: "https://www.parkiet.com/x", publisher: "Parkiet", published_at: "2026-10-02" }), "Parkiet · 2.10");
  assert.equal(sourceText({ url: "https://www.bankier.pl/forum" }), "bankier.pl");
  assert.equal(safeUrl("javascript:alert(1)"), null);
  assert.equal(safeUrl("https://example.org"), "https://example.org");
});

test("candidate criteria: structured details first, else a checkbox list in the summary; threshold in brackets", () => {
  const c = candidateCriteria({ summary: "", details: { criteria: [
    { text: "-31 % od szczytu 52 tyg.", met: true, threshold: "-25 %" }, { text: "przychody stabilne 4 kwartały", met: true },
    { text: "powyżej SMA 200 od 6 tyg.", met: false, threshold: "próg 8" },
  ] } });
  assert.deepEqual([c.met, c.total], [2, 3]);
  assert.equal(criterionText(c.items[0]), "-31 % od szczytu 52 tyg. (próg -25 %)");
  assert.equal(criterionText(c.items[1]), "przychody stabilne 4 kwartały");
  assert.equal(criterionText(c.items[2]), "powyżej SMA 200 od 6 tyg. (próg 8)");
  const p = candidateCriteria({ summary: "Napływy do ETF.\n- [x] napływy 5 tyg. z rzędu\n- [ ] powyżej SMA 200\n* [X] siła relatywna +8 pp", details: null });
  assert.deepEqual(p.items.map((x) => [x.text, x.met]), [["napływy 5 tyg. z rzędu", true], ["powyżej SMA 200", false], ["siła relatywna +8 pp", true]]);
  assert.equal(candidateReturn("2026-09-27T10:00:00+02:00"), "2026-12-26");
});

test("research signal copy: relation, title, strength and sources; note id from the payload", () => {
  const s = { kind: "research:news", message: "fallback", instrument_label: "CD Projekt", payload: { note_id: 77, title: "premiera przesunięta na 2028", thesis_relation: "weakens", strength: 3, sources: [{}, {}] } };
  assert.ok(isResearchKind(s.kind));
  assert.ok(!isResearchKind("alert:price_below"));
  assert.equal(signalNoteId(s), 77);
  assert.deepEqual(researchSignalText(s, "CD Projekt", "CDR"), { title: "CD Projekt", sym: "CDR", lead: "osłabia tezę ·", bold: "premiera przesunięta na 2028", tail: "· siła 3/3 · 2 źródła" });
  const theme = researchSignalText({ kind: "research:macro", message: "m", instrument_label: null, payload: { theme: "Stopy procentowe USA", kind: "macro", strength: 3, sources_count: 1 } }, "", null);
  assert.deepEqual(theme, { title: "Stopy procentowe USA", sym: null, lead: "makro ·", bold: "m", tail: "· siła 3/3 · 1 źródło" });
});

// ---- runs, commands, schedule -------------------------------------------------------------------------

test("run tag: never ran, running, interrupted, fresh, not this week", () => {
  const today = "2026-10-05";
  assert.deepEqual(runTag([], today), { text: "jeszcze nie działał", tone: "", state: "none" });
  const done = { id: 3, started_at: "2026-10-03T06:40:00+02:00", finished_at: "2026-10-03T07:12:00+02:00", status: "done", scope: null, counts: { notes: 14 }, created_by: "agent" };
  assert.deepEqual(runTag([done], today), { text: "sob 3.10 · 14 notatek", tone: "", state: "fresh" });
  const stale = { ...done, started_at: "2026-09-26T06:40:00+02:00", finished_at: "2026-09-26T07:12:00+02:00" };
  assert.deepEqual(runTag([stale], today), { text: "brak w tym tygodniu · ostatni 26.09", tone: "warn", state: "stale" });
  const running = { ...done, id: 4, started_at: "2026-10-05T06:40:00+02:00", finished_at: null, status: "running", counts: { notes: 9 } };
  assert.equal(runTag([done, running], today).text, "trwa · od 06:40 · 9 notatek");
  const failed = { ...running, status: "failed", finished_at: "2026-10-05T06:52:00+02:00", counts: { notes: 4 } };
  assert.deepEqual(runTag([done, failed], today), { text: "przerwany 06:52 · 4 notatki zapisane", tone: "neg", state: "failed" });
});

test("next Saturday and the copied commands", () => {
  assert.equal(nextSaturday("2026-10-05"), "2026-10-10");
  assert.equal(nextSaturday("2026-10-03"), "2026-10-10"); // on a Saturday: the following one
  assert.equal(nextSaturday("2026-10-09"), "2026-10-10");
  assert.equal(researchCommand("~/Documents/finanse/jakub", "jakub"), 'cd ~/Documents/finanse/jakub && claude -p "/market-research"');
  assert.equal(researchCommand(null, "jan"), 'cd ~/Documents/finanse/jan && claude -p "/market-research"');
  assert.equal(researchCommand("~/Moje dane/finanse", "jan"), 'cd ~/"Moje dane/finanse" && claude -p "/market-research"');
  assert.equal(researchCommand("/Users/x/My Drive/f", "jan"), 'cd "/Users/x/My Drive/f" && claude -p "/market-research"');
  assert.equal(workspacePath(null, "jan"), "~/Documents/finanse/jan");
  // a LOCAL routine of the Claude app (a cloud routine from /schedule cannot reach the local MCP server)
  assert.equal(scheduleSteps(null, "jan"), "Claude (aplikacja) › Code › Routines › Nowa rutyna › Lokalna: sobota 07:00, folder ~/Documents/finanse/jan, polecenie /market-research rutyna");
  assert.ok(!scheduleSteps("~/x", "jan").includes("/schedule"));
});

// ---- home grid integration -----------------------------------------------------------------------------

test("grid: the strip only after the first run; the last cell of the home v3 (Q13), no defer", () => {
  assert.equal(showStrip(null), false);
  assert.equal(showStrip([]), false);
  assert.equal(showStrip([{ id: 1, status: "running" }]), true);
  // home v3: hero, (failed notice), the split cell, the research strip last: reading order = DOM order
  const { order, alone } = twoColumnOrder([{ id: "hero", span: 3 }, { id: "split", span: 3 }, { id: "research", span: 3 }]);
  assert.deepEqual([...order.entries()].sort((a, b) => a[1] - b[1]).map(([id]) => id), ["hero", "split", "research"]);
  assert.equal(alone.size, 0);
  // a deferred wide item (still supported by the grid) keeps its place without a waiting single widget
  const r2 = twoColumnOrder([{ id: "a", span: 3 }, { id: "r", span: 3, defer: true }, { id: "b", span: 2 }]);
  assert.deepEqual([...r2.order.entries()], [["a", 1], ["r", 2], ["b", 3]]);
  const r3 = twoColumnOrder([{ id: "s", span: 1 }, { id: "r", span: 3, defer: true }]);
  assert.deepEqual([...r3.order.entries()], [["s", 1], ["r", 2]]);
  assert.ok(r3.alone.has("s"));
});

test("contract accessors: candidate subject, accepted row, restore window, latest note, signal word, direction names", () => {
  const cand = note({ kind: "candidate", instrument_id: null, instrument: null, candidate: { symbol: "TXT", name: "Text", exchange: "XWAR", accepted_at: "2026-10-05T08:00:00Z", watchlist_item_id: 91 } });
  assert.deepEqual(noteSubject(cand), { name: "Text", sym: "TXT · XWAR" });
  assert.deepEqual(noteSubject(note({ instrument: { id: 306, label: "CDR", name: "CD Projekt", symbol: "CDR", mic: "XWAR" } })), { name: "CD Projekt", sym: "CDR · XWAR" });
  assert.equal(acceptedAt(cand), "2026-10-05T08:00:00Z");
  assert.equal(watchItemId(cand), 91);
  const now = Date.parse("2026-10-05T10:10:00Z");
  assert.equal(isRestorable({ dismissed_at: "2026-10-05T10:00:00Z", restorable_until: "2026-10-05T10:15:00Z" }, now), true);
  assert.equal(isRestorable({ dismissed_at: "2026-10-05T09:00:00Z", restorable_until: "2026-10-05T09:15:00Z" }, now), false);
  assert.equal(isRestorable({ dismissed_at: "2026-10-05T10:00:00Z" }, now), true); // 15-min fallback
  assert.equal(isRestorable({ dismissed_at: null }, now), false);
  assert.equal(latestTitle({ latest_note: { id: 1, title: "Premiera przesunięta" } }), "Premiera przesunięta");
  assert.equal(signalWord({ signal_id: null, signal: null }), null);
  assert.equal(signalWord({ signal_id: 9, signal: { id: 9, status: "active", severity: "info" } }), "sygnał otwarty");
  assert.equal(signalWord({ signal_id: 9, signal: { id: 9, status: "resolved", severity: "info" } }), "sygnał zamknięty");
  assert.deepEqual(["rising", "falling", "stable", null].map(normDirection), ["up", "down", "flat", "flat"]);
  assert.deepEqual([...chipsFromFields([{ field: "thesis", supports: 1, weakens: 2, invalidates: 0, neutral: 0 }, { field: "exit_plan", supports: 0, weakens: 0, invalidates: 0, neutral: 3 }]).entries()],
    [["thesis", { relation: "weakens", text: "2 notatki osłabiają" }]]);
});
