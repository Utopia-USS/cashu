// Research layer pure logic (src/modules/investments/v2/research/logic.ts) and its place in the home grid
// (src/grid.ts `defer`), run with `npm test`.
import assert from "node:assert/strict";
import { test } from "node:test";
import { twoColumnOrder } from "../src/grid.ts";
import {
  acceptedAt, candidateCriteria, candidateReturn, chipsFromFields, countsText, isRestorable, latestTitle, noteSubject, signalWord, watchItemId, criterionText, direction, expiryText, fieldChips, freshness, healthOf,
  HEALTH_CLS, HEALTH_LABEL, isResearchKind, nextSaturday, normHealth, noteWhen, orderTheses, relationCounts,
  researchCommand, researchSignalText, runTag, safeUrl, scheduleSteps, workspacePath, sentiment8w, sentimentBars, showStrip, signalNoteId, sourceText, thesisHealth,
  weekLabels, weekScore, weekStarts, windowStart,
} from "../src/modules/investments/v2/research/logic.ts";
import {
  BAR_FLOOR, barTitle, contribBars, currencyChips, currencySub, exposed, factTitle, homeRows, isSegment, normAttribution, pageRows, ppOf, ppTone,
  instSymbol, noExposure, normDigestMarket, reviewColumn, reviewRows, segmentLabel, segmentSub, SEGMENTS, staleSymbols, staleTitle, tone, UNASSIGNED, windowTitle, withNewNote,
} from "../src/modules/investments/v2/research/segments.ts";

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

test("sentiment direction: last 4 weeks vs the previous 4, more than 1.0 apart", () => {
  assert.equal(direction([0.2, 0.3, null, 0, -0.2, -0.3, -0.5, -0.8]), "down");
  assert.equal(direction([0.1, 0.3, 0.2, 0.4, null, 0.5, 0.3, 0.6]), "flat"); // +0.4 only
  assert.equal(direction([-0.4, -0.3, null, null, 0.3, 0.4, 0.2, 0.5]), "up");
  assert.equal(direction([null, null, null, null, null, null, null, null]), "flat");
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
  // An old theme signal keeps its theme as the title.
  const theme = researchSignalText({ kind: "research:macro", message: "m", instrument_label: null, payload: { theme: "Stopy procentowe USA", kind: "macro", strength: 3, sources_count: 1 } }, "", null);
  assert.deepEqual(theme, { title: "Stopy procentowe USA", sym: null, lead: "makro ·", bold: "m", tail: "· siła 3/3 · 1 źródło" });
  // P5: a segment note's signal is titled by the segment label, sym `rynek`.
  const seg = researchSignalText({ kind: "research:macro", message: "m", instrument_label: null, payload: { segment: "gold", kind: "macro", strength: 3, sources_count: 1 } }, "", null);
  assert.deepEqual(seg, { title: "Złoto i górnicy", sym: "rynek", lead: "makro ·", bold: "m", tail: "· siła 3/3 · 1 źródło" });
  assert.equal(researchSignalText({ kind: "research:trend", message: "m", instrument_label: null, payload: { segment: "gold", segment_label: "Złoto" } }, "", null).title, "Złoto");
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
  assert.equal(researchCommand("~/Documents/cashU/jakub", "jakub"), 'cd ~/Documents/cashU/jakub && claude -p "/market-research"');
  assert.equal(researchCommand(null, "jan"), 'cd ~/Documents/cashU/jan && claude -p "/market-research"');
  assert.equal(researchCommand("~/Moje dane/cashu", "jan"), 'cd ~/"Moje dane/cashu" && claude -p "/market-research"');
  assert.equal(researchCommand("/Users/x/My Drive/f", "jan"), 'cd "/Users/x/My Drive/f" && claude -p "/market-research"');
  assert.equal(workspacePath(null, "jan"), "~/Documents/cashU/jan");
  // a LOCAL routine of the Claude app (a cloud routine from /schedule cannot reach the local MCP server)
  assert.equal(scheduleSteps(null, "jan"), "Claude (aplikacja) › Code › Routines › Nowa rutyna › Lokalna: sobota 07:00, folder ~/Documents/cashU/jan, polecenie /market-research rutyna");
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
  // P5: a segment note's subject is its segment label (after instrument and candidate, before the old theme).
  assert.equal(noteSubject(note({ instrument_id: null, instrument: null, segment: "bonds", segment_label: null, title: "t" })).name, "Obligacje i stopy");
  assert.equal(noteSubject(note({ instrument_id: null, instrument: null, theme: "stopy procentowe", title: "t" })).name, "stopy procentowe");
  assert.deepEqual([...chipsFromFields([{ field: "thesis", supports: 1, weakens: 2, invalidates: 0, neutral: 0 }, { field: "exit_plan", supports: 0, weakens: 0, invalidates: 0, neutral: 3 }]).entries()],
    [["thesis", { relation: "weakens", text: "2 notatki osłabiają" }]]);
});

// ---- P5 market segments (R/segments.ts) -------------------------------------------------------------------

const segRow = (over) => ({
  segment: "gold", label: "Złoto i górnicy", group: "asset", weight: 0.1, contribution: 0, return: 0, instruments: [],
  note: null, note_this_week: false, unread: 0, notes_8w: 0, ...over,
});
const symOf = (id) => ({ 301: "VWRA", 305: "GDXJ", 306: "CDR", 307: "EIMI", 308: "GLD", 309: "SIL" })[id] ?? null;

test("segments: the catalog has 18 unique keys in the BE order, labels and the pseudo row", () => {
  assert.equal(SEGMENTS.length, 18);
  assert.equal(new Set(SEGMENTS.map((s) => s.key)).size, 18);
  assert.equal(SEGMENTS[0].key, "equity_global");
  assert.equal(SEGMENTS[17].key, "quantum");
  assert.equal(SEGMENTS.filter((s) => s.group === "sector").length, 8);
  assert.equal(segmentLabel("gold"), "Złoto i górnicy");
  assert.equal(segmentLabel(UNASSIGNED), "Bez segmentu");
  assert.equal(segmentLabel("nope"), "nope");
  assert.equal(segmentLabel(null), "");
  assert.ok(isSegment("semis_ai") && !isSegment(UNASSIGNED) && !isSegment(null));
});

test("segments: contribution tone, pp text and return tone (symmetric one-decimal rounding)", () => {
  assert.equal(ppTone(0.0004), "zero");
  assert.equal(ppTone(0.0005), "pos");
  assert.equal(ppTone(-0.0005), "neg");
  assert.equal(ppTone(0), "zero");
  assert.equal(ppTone(null), "zero");
  assert.equal(ppOf(-0.008), "-0,8\u00a0pp");
  assert.equal(ppOf(0.004), "+0,4\u00a0pp");
  assert.equal(ppOf(-0.0004), "0,0\u00a0pp");
  assert.equal(ppOf(-0.0005), "-0,1\u00a0pp");
  assert.equal(ppOf(null), "-");
  assert.equal(tone(-0.012), "neg");
  assert.equal(tone(0.031), "pos");
  assert.equal(tone(0.0004), "");
  assert.equal(tone(null), "");
  // the return tone follows `pct` rounding: a half value printed as 0,0 % has no colour
  assert.equal(tone(-0.0005), "");
  assert.equal(tone(0.0005), "pos");
  assert.equal(tone(-0.0006), "neg");
});

test("segments: diverging bar geometry on a shared scale with a 0,5 pp floor", () => {
  const a = contribBars([-0.008, 0.004, 0.0003]);
  assert.equal(a.max, 0.008);
  assert.deepEqual(a.bars.map((b) => b.w), [50, 25, 0]);
  assert.deepEqual(a.bars.map((b) => b.cls), ["neg", "pos", "zero"]);
  const b = contribBars([0.001, -0.0005]);
  assert.equal(b.max, BAR_FLOOR);
  assert.deepEqual(b.bars.map((x) => x.w), [10, 5]);
  assert.ok(contribBars([0, 0, 0.0001]).bars.every((x) => x.w === 0));
  assert.equal(contribBars([]).max, BAR_FLOOR);
  assert.deepEqual(contribBars([]).bars, []);
  assert.equal(barTitle(-0.008, 0.02), "wkład -0,8\u00a0pp · skala ±2,0\u00a0pp");
});

test("segments: home rows take 6 slots, Waluty from 0,1 pp, Bez segmentu from 2 % weight", () => {
  const segs = Array.from({ length: 7 }, (_, i) => segRow({ segment: SEGMENTS[i].key, label: SEGMENTS[i].label, contribution: -0.001 * (7 - i), unread: i === 6 ? 2 : i === 5 ? 1 : 0 }));
  const cur = { contribution: -0.002, currencies: [] };
  const un = { weight: 0.05, contribution: 0.001, instruments: [{ instrument_id: 307, contribution: 0.001, return: 0.019 }] };
  const all = homeRows({ segments: segs, currency: cur, unassigned: un });
  assert.equal(all.rows.length, 6);
  assert.deepEqual(all.rows.map((r) => r.key), ["equity_global", "equity_pl", "equity_em", "bonds", "currency", UNASSIGNED]);
  assert.deepEqual(all.rest, { count: 3, unread: 3 });
  assert.equal(all.rows[5].label, "Bez segmentu");
  assert.ok(Math.abs(all.rows[5].return - 0.02) < 1e-9); // contribution / weight
  // currency 0.0004 -> no Waluty row
  assert.ok(!homeRows({ segments: segs, currency: { contribution: 0.0004, currencies: [] }, unassigned: null }).rows.some((r) => r.key === "currency"));
  assert.ok(homeRows({ segments: segs, currency: { contribution: -0.001, currencies: [] }, unassigned: null }).rows.some((r) => r.key === "currency"));
  // unassigned weight 0.019 -> no row; 0.02 -> row
  assert.ok(!homeRows({ segments: [], currency: cur, unassigned: { ...un, weight: 0.019 } }).rows.some((r) => r.key === UNASSIGNED));
  assert.ok(homeRows({ segments: [], currency: cur, unassigned: { ...un, weight: 0.02 } }).rows.some((r) => r.key === UNASSIGNED));
  // the page has no cap
  assert.equal(pageRows({ segments: segs, currency: cur, unassigned: un }).length, 9);
});

test("segments: sub line (note this week, older note, symbols, currencies), stale marks, review order", () => {
  const today = segRow({ note: { id: 1, title: "Fed: realne stopy w dół", observed_at: "2026-10-06" }, note_this_week: true });
  const older = segRow({ note: { id: 2, title: "x", observed_at: "2026-09-22" } });
  const none = segRow({ instruments: [305, 308, 309, 306].map((id) => ({ instrument_id: id, contribution: 0, return: 0 })) });
  const rows = homeRows({ segments: [today, older, none], currency: { contribution: -0.002, currencies: [
    { currency: "EUR", weight: 0.08, return: 0.002, contribution: 0.0002 }, { currency: "USD", weight: 0.55, return: -0.007, contribution: -0.0039 }, { currency: "CHF", weight: 0.01, return: 0, contribution: 0 },
  ] }, unassigned: null }).rows;
  assert.deepEqual(segmentSub(rows[0], symOf), { text: "Fed: realne stopy w dół", title: "Fed: realne stopy w dół" });
  assert.equal(segmentSub(rows[1], symOf).text, "bez zmian od 22.09");
  assert.equal(segmentSub(rows[2], symOf).text, "GDXJ · GLD · SIL");
  assert.equal(segmentSub(rows[3], symOf).text, "USD -0,7\u00a0% · EUR +0,2\u00a0%");
  assert.equal(currencySub([]), "");
  assert.deepEqual(currencyChips([{ currency: "EUR", weight: 0.08, return: 0, contribution: 0 }, { currency: "USD", weight: 0.55, return: 0, contribution: 0 }]), ["USD 55\u00a0%", "EUR 8\u00a0%"]);
  const st = staleSymbols(rows[2], [305, 308], symOf);
  assert.deepEqual(st, ["GDXJ", "GLD"]);
  assert.equal(staleTitle(st), "notowania nieaktualne: GDXJ, GLD");
  assert.equal(staleTitle([]), undefined);
  assert.deepEqual(reviewRows([older, today]).map((r) => r.note?.id), [1, 2]);
  assert.equal(withNewNote([today, older]), 1);
  assert.equal(exposed({ segments: [today, segRow({ weight: 0 })] }), 1);
  assert.equal(exposed(null), 0);
});

test("segments: header and fact tooltips with and without residual, new positions, stale", () => {
  const d = { start: "2026-10-01", end: "2026-10-08", portfolio_return: -0.012, explained: -0.0118, residual: -0.0004, new_positions: 0 };
  assert.equal(windowTitle(d), "1.10 - 8.10 · TWR portfela");
  assert.equal(windowTitle({ ...d, portfolio_return: null }), "1.10 - 8.10 · TWR portfela · brak pełnej historii");
  assert.equal(factTitle(d), "wyjaśnione -1,2\u00a0% · reszta 0,0\u00a0% · 1.10 - 8.10");
  assert.equal(factTitle({ ...d, residual: null }), "wyjaśnione -1,2\u00a0% · reszta - · 1.10 - 8.10");
  assert.equal(factTitle({ ...d, residual: -0.001, new_positions: 1 }, ["GDXJ"]), "wyjaśnione -1,2\u00a0% · reszta -0,1\u00a0% · 1.10 - 8.10 · 1 nowa pozycja poza oknem · nieaktualne: GDXJ");
  assert.match(factTitle({ ...d, new_positions: 3 }), /3 nowe pozycje poza oknem$/);
});

test("segments: the payload is read tolerantly (missing fields, string numbers, catalog label fallback)", () => {
  const d = normAttribution({
    as_of: "2026-10-08", start: "2026-10-01", end: "2026-10-08", window: "1w", portfolio_return: "-0.012", explained: -0.0115,
    stale: [{ instrument_id: 7 }, 8], segments: [{ segment: "gold", weight: 0.18, contribution: -0.008, instruments: [12, { instrument_id: 13, contribution: 0.001 }], note: { id: 140, title: "t", observed_at: "2026-10-06" }, note_this_week: true }, { label: "no key" }],
  });
  assert.equal(d.portfolio_return, -0.012);
  assert.equal(d.residual, null);
  assert.deepEqual(d.stale, [7, 8]);
  assert.equal(d.segments.length, 1);
  assert.equal(d.segments[0].label, "Złoto i górnicy");
  assert.equal(d.segments[0].group, "asset");
  assert.equal(d.segments[0].return, null);
  assert.deepEqual(d.segments[0].instruments.map((i) => i.instrument_id), [12, 13]);
  assert.equal(d.segments[0].unread, 0);
  assert.equal(d.unassigned, null);
  assert.deepEqual(d.currency, { contribution: 0, currencies: [] });
  assert.equal(normAttribution({}, "4w").window, "4w");
});

test("segments fix pass: expired last note, BE labels, note-only rows, review column with the digest market", () => {
  // MED-2: no active note but an older (expired) one -> `bez zmian od`, symbols only without either
  const expired = homeRows({ segments: [segRow({ last_note_at: "2026-08-20", instruments: [{ instrument_id: 305, contribution: 0, return: 0 }] })], currency: null, unassigned: null }).rows[0];
  assert.equal(segmentSub(expired, symOf).text, "bez zmian od 20.08");
  // MED-3: a sold position is named by the BE label, then `#id`
  assert.equal(instSymbol({ instrument_id: 999, label: "BNDA" }, symOf), "BNDA");
  assert.equal(instSymbol({ instrument_id: 305, label: "X" }, symOf), "GDXJ");
  assert.equal(instSymbol({ instrument_id: 998 }, symOf), "#998");
  const sold = homeRows({ segments: [segRow({ instruments: [{ instrument_id: 999, contribution: 0, return: 0, label: "BNDA" }] })], currency: null, unassigned: null }).rows[0];
  assert.equal(segmentSub(sold, symOf).text, "BNDA");
  assert.deepEqual(staleSymbols(sold, [999], symOf), ["BNDA"]);
  // MED-4: a note-only segment shows `-`; a held non-market one (weight > 0, contribution 0) keeps 0,0 pp
  const rows = pageRows({ segments: [segRow({ weight: 0 }), segRow({ segment: "bonds", weight: 0.2, contribution: 0, return: null })], currency: null, unassigned: null });
  assert.deepEqual(rows.map(noExposure), [true, false]);
  assert.equal(noExposure({ kind: "currency", weight: 0 }), false);
  // MED-1: the review column takes Waluty / Bez segmentu from the digest market and keeps 6 rows
  const segs = Array.from({ length: 6 }, (_, i) => segRow({ segment: SEGMENTS[i].key, note_this_week: i === 5 }));
  const { segments, market } = normDigestMarket(segs, { start: "2026-10-01", end: "2026-10-08", portfolio_return: "-0.012", stale: [305],
    currency: { contribution: -0.001, currencies: [] }, unassigned: { weight: 0.05, contribution: 0.001, return: 0.02, instruments: [] } });
  assert.equal(market.portfolio_return, -0.012);
  assert.deepEqual(market.stale, [305]);
  assert.equal(market.unassigned.return, 0.02);
  const col = reviewColumn(segments, market);
  assert.equal(col.length, 6);
  assert.deepEqual(col.map((r) => r.key), [SEGMENTS[5].key, SEGMENTS[0].key, SEGMENTS[1].key, SEGMENTS[2].key, "currency", UNASSIGNED]);
  assert.equal(normDigestMarket(undefined, null).market, null);
  assert.equal(reviewColumn(segments, null).length, 6);
  // the parser keeps the BE extras
  const d = normAttribution({ segments: [{ segment: "gold", last_note_at: "2026-08-20", instruments: [{ instrument_id: 1, label: "GLBA", weight: 0.1 }] }] });
  assert.equal(d.segments[0].last_note_at, "2026-08-20");
  assert.equal(d.segments[0].instruments[0].label, "GLBA");
  assert.equal(d.segments[0].instruments[0].weight, 0.1);
});
