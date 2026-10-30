// Research as a story (v2/research/storyLogic.ts): the mood word, the plain headline of a note, the topics with
// something to say this week, the theses that moved and the events coming up.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  aheadDays, aheadEvents, dayBucket, valuationOf, firstSentence, hasPlainHeadline, moodOf, noteHeadline, storyTopics, thesisMoves,
} from "../src/modules/investments/v2/research/storyLogic.ts";

test("moodOf: the week's move in one word; a flat week with a negative brief is uncertain", () => {
  assert.equal(moodOf(0.05), "up");
  assert.equal(moodOf(0.015), "tail");
  assert.equal(moodOf(-0.04), "press");
  assert.equal(moodOf(-0.012), "weak");
  assert.equal(moodOf(0.002, "negative"), "unsure");
  assert.equal(moodOf(null), "calm");
});

test("noteHeadline: the plain headline first, then a brief's, else the title", () => {
  assert.equal(noteHeadline({ title: "AWS +39 % r/r", details: { headline: "Chmura rośnie najszybciej od lat" } }), "Chmura rośnie najszybciej od lat");
  assert.equal(noteHeadline({ title: "Fed 4,25 %", details: { brief: { headline: "Stopy bez zmian" } } }), "Stopy bez zmian");
  assert.equal(noteHeadline({ title: "Tylko tytuł", details: null }), "Tylko tytuł");
  assert.equal(hasPlainHeadline({ title: "Tylko tytuł", details: null }), false);
  assert.equal(firstSentence("Pierwsze zdanie. Drugie zdanie."), "Pierwsze zdanie.");
});

const note = (o) => ({ id: 1, kind: "news", strength: 1, title: "t", details: null, dismissed_at: null, observed_at: "2026-10-29T10:00:00Z", instrument_id: null, segment: null, polarity: "neutral", ...o });

test("storyTopics: topics with a brief or a note, biggest effect first; the rest are only named", () => {
  const att = { segments: [
    { segment: "semis_ai", label: "AI: chipy", weight: 0.2, contribution: 0.012, trend_1w: 0.02, instruments: [{ instrument_id: 7, contribution: 0.012, return: 0.06 }], briefs: [{ headline: "Inwestorzy sprawdzają zyski z AI", polarity: "neutral" }], thesis: { assessment: "Popyt nierówny. Dalej rośnie.", outlook: "Wzrost wolniej.", draft: true } },
    { segment: "gold", label: "Złoto", weight: 0.1, contribution: -0.02, trend_1w: -0.04, instruments: [{ instrument_id: 8, contribution: -0.02, return: -0.1 }], briefs: [] },
    { segment: "games", label: "Gry", weight: 0.05, contribution: 0.001, trend_1w: 0, instruments: [], briefs: [] },
  ] };
  const { topics, quiet } = storyTopics(att, [note({ id: 3, instrument_id: 8, details: { headline: "Mocniejszy dolar ciąży złotu" } })], (id) => `S${id}`);
  assert.deepEqual(topics.map((t) => [t.key, t.mood, t.headline]), [
    ["gold", "press", "Mocniejszy dolar ciąży złotu"],
    ["semis_ai", "tail", "Inwestorzy sprawdzają zyski z AI"],
  ]);
  assert.equal(topics[1].now, "Popyt nierówny.");
  assert.equal(topics[1].draft, true);
  assert.deepEqual(quiet, ["Gry"]);
});

test("thesisMoves, dayBucket and aheadEvents", () => {
  const inst = (id, health, held = true) => ({ instrument_id: id, health, held, counts: {}, has_thesis: true, last_researched_at: "2026-10-29" });
  const m = thesisMoves({ instruments: [inst(1, "weakened"), inst(2, "supported"), inst(3, "invalidated", false), inst(4, "current")] }, "2026-10-29");
  assert.deepEqual([m.weak.map((i) => i.instrument_id), m.strong.map((i) => i.instrument_id)], [[1], [2]]);
  assert.deepEqual(["2026-10-29", "2026-10-28", "2026-10-24", "2026-10-01"].map((d) => dayBucket(d, "2026-10-29")), [0, 1, 2, 3]);
  const ev = (date, id = null) => ({ date, time: null, kind: id ? "earnings" : "macro", title: "x", instrument_id: id });
  const out = aheadEvents([ev("2026-11-03"), ev("2026-10-30", 5), ev("2026-11-20", 6), ev("2026-10-28")], "2026-10-29", 7);
  assert.deepEqual(out.map((e) => e.date), ["2026-10-30", "2026-11-03"]);
});

test("aheadDays: one row per day, companies by topic (own first), research events under them, the market apart", () => {
  const e = (o) => ({ time: null, country: null, country_label: null, instrument_id: null, label: null, held: null, note_id: null, ...o });
  const events = [
    e({ date: "2026-10-29", kind: "earnings", title: "Wyniki kwartalne AMZN", instrument_id: 1, label: "AMZN", held: false }),
    e({ date: "2026-10-29", kind: "earnings", title: "Wyniki kwartalne INTC", instrument_id: 2, label: "INTC", held: true }),
    e({ date: "2026-10-29", kind: "earnings", title: "Wyniki kwartalne SNDK", instrument_id: 3, label: "SNDK", held: false }),
    e({ date: "2026-10-29", kind: "macro", title: "Fed: decyzja o stopach", country_label: "USA" }),
    e({ date: "2026-10-29", kind: "macro", title: "PKB", country_label: "USA" }),
    e({ date: "2026-11-01", kind: "research", title: "Zapisy na 2027", instrument_id: 4, label: "UNH", held: true }),
  ];
  const topics = { 1: "Konsumpcja", 2: "AI: chipy", 3: "AI: chipy", 4: "Ochrona zdrowia" };
  const names = { 1: "Amazon", 2: "Intel", 3: "SanDisk", 4: "UnitedHealth" };
  const days = aheadDays(events, (id) => topics[id] ?? null, (ev) => names[ev.instrument_id] ?? ev.label);
  assert.equal(days.length, 2);
  assert.equal(days[0].mine, 1);
  assert.deepEqual(days[0].groups.map((g) => [g.topic, g.items.map((i) => i.name)]), [["AI: chipy", ["Intel", "SanDisk"]], ["Konsumpcja", ["Amazon"]]]);
  assert.deepEqual(days[0].market, ["Fed: decyzja o stopach", "PKB (USA)"]);
  assert.deepEqual(days[1].groups[0].items[0], { name: "UnitedHealth", mine: true, earnings: false, title: "Zapisy na 2027" });
});

test("valuationOf: PEG first (robotics P/E 60, forward 20, 45 % growth is cheap for its growth), then the 5-year average", () => {
  const robots = valuationOf({ pe: 60, forward_pe: 20, eps_growth: 0.45 });
  assert.equal(robots.multiple, 3);
  assert.equal(robots.verdict, "cheap");
  assert.equal(valuationOf({ pe: 30, forward_pe: 28, eps_growth: 0.08 }).verdict, "rich");
  assert.equal(valuationOf({ pe: 22, forward_pe: 20 }).verdict, "fair"); // growth implied by P/E / forward P/E: 10 %
  assert.equal(valuationOf({ forward_pe: 15, pe_avg_5y: 20 }).verdict, "cheap");
  assert.equal(valuationOf({ pe: 25 }).verdict, null);
  // review findings: the 5-year average wins over the growth P/E / forward P/E only implies
  assert.equal(valuationOf({ pe: 25, forward_pe: 24, pe_avg_5y: 30 }).verdict, "cheap");
  // shrinking earnings never read as cheap
  assert.equal(valuationOf({ pe: 15, forward_pe: 20 }).verdict, null);
  assert.equal(valuationOf({ forward_pe: 15, eps_growth: -0.2, pe_avg_5y: 20 }).verdict, null);
});

test("aheadDays: the own count is distinct companies; a research event named by its own title is not doubled", () => {
  const e = (o) => ({ time: null, country: null, country_label: null, instrument_id: null, label: null, held: null, note_id: null, ...o });
  const days = aheadDays([
    e({ date: "2026-11-03", kind: "earnings", title: "Wyniki kwartalne X", instrument_id: 1, label: "X", held: true }),
    e({ date: "2026-11-03", kind: "research", title: "Dzień inwestora", instrument_id: 1, label: "X", held: true }),
    e({ date: "2026-11-03", kind: "research", title: "Dzień inwestora", instrument_id: 1, label: "X", held: true }),
    e({ date: "2026-11-03", kind: "research", title: "Premiera", instrument_id: 9, label: null, held: null }),
    e({ date: "2026-11-03", kind: "macro", title: "Fed: decyzja o stopach", time: "19:00" }),
  ], () => "T", (ev) => (ev.instrument_id === 1 ? "Xco" : ev.title));
  assert.equal(days[0].mine, 1);
  assert.deepEqual(days[0].groups[0].items.map((i) => [i.name, i.title]), [["Xco", null], ["Xco", "Dzień inwestora"], ["Premiera", null]]);
  assert.deepEqual(days[0].market, ["Fed: decyzja o stopach 19:00"]);
});
