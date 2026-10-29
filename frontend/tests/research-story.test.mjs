// Research as a story (v2/research/storyLogic.ts): the mood word, the plain headline of a note, the topics with
// something to say this week, the theses that moved and the events coming up.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  aheadEvents, dayBucket, firstSentence, hasPlainHeadline, moodOf, noteHeadline, storyTopics, thesisMoves,
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
