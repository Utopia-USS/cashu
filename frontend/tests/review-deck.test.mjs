// The weekly review deck (v2/reviewDeckLogic.ts): the week's verdict vs the portfolio's typical week and the
// benchmark, sectors and movers from the segment attribution, what waits for a decision, skipped cards.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  deckCards, decideItems, openIdeas, sectorRows, sectorsTitle, summaryTitle, topMovers, weekEvents, weeklySigma, worldVerdict,
} from "../src/modules/investments/v2/reviewDeckLogic.ts";

const day = (n) => new Date(Date.UTC(2026, 0, 1 + n)).toISOString().slice(0, 10);

test("weeklySigma: the spread of 7-day TWR changes; null with too little history", () => {
  assert.equal(weeklySigma([{ date: day(0), twr: 0 }, { date: day(7), twr: 0.01 }]), null);
  const flat = Array.from({ length: 120 }, (_, i) => ({ date: day(i), twr: 0.001 * i }));
  const sd = weeklySigma(flat);
  assert.ok(sd === null || sd < 0.001, "a steady climb has almost no spread");
  const noisy = Array.from({ length: 120 }, (_, i) => ({ date: day(i), twr: (i % 14 < 7 ? 0.03 : -0.03) }));
  assert.ok(weeklySigma(noisy) > 0.02);
});

test("worldVerdict: size from the typical week, direction vs the benchmark", () => {
  const calm = worldVerdict(0.016, 0.023, 0.02);
  assert.equal(calm.size, "calm");
  assert.equal(calm.pill, "w normie");
  assert.equal(calm.title, "Spokojny tydzień. Portfel idzie razem z rynkiem.");
  const crash = worldVerdict(-0.078, -0.051, 0.025);
  assert.equal(crash.size, "rare");
  assert.equal(crash.tone, "neg");
  assert.equal(crash.title, "Rzadko spotykany spadek. Rynek też spadał, ale portfel mocniej.");
  assert.equal(worldVerdict(-0.04, null, 0.03).title, "Mocny spadek.");
  assert.equal(worldVerdict(null, 0.01, 0.02).pill, "brak wyceny");
});

const att = {
  segments: [
    { segment: "semis_ai", label: "AI: chipy", weight: 0.24, contribution: -0.034, return: -0.142, instruments: [{ instrument_id: 1, contribution: -0.016, return: -0.161 }, { instrument_id: 2, contribution: -0.018, return: -0.128 }] },
    { segment: "gold", label: "Złoto", weight: 0.22, contribution: -0.02, return: -0.091, instruments: [{ instrument_id: 3, contribution: -0.02, return: -0.091 }] },
    { segment: "energy", label: "Ropa i gaz", weight: 0.04, contribution: 0.001, return: 0.021, instruments: [{ instrument_id: 4, contribution: 0.001, return: 0.021 }] },
    { segment: "semis_watch", label: "Obserwowane", weight: 0, contribution: 0, return: null, instruments: [] },
  ],
  unassigned: null,
  currency: { contribution: -0.004, currencies: [] },
};

test("sectorRows: biggest contributions first, empty segments out, the currency part last", () => {
  const rows = sectorRows(att);
  assert.deepEqual(rows.map((r) => r.key), ["semis_ai", "gold", "energy", "currency"]);
  const t = sectorsTitle(rows, -0.058);
  assert.equal(t.title, "AI: chipy i Złoto: 100 % spadku.");
  assert.equal(sectorRows(null).length, 0);
});

test("topMovers: own returns, at most 3 each way, display names from the caller", () => {
  const m = topMovers(att, new Map([[1, "Chip Designer"]]));
  assert.deepEqual(m.down.map((x) => x.label), ["Chip Designer", "#2", "#3"]);
  assert.deepEqual(m.up.map((x) => x.id), [4]);
});

const sig = (over) => ({ id: 1, rule_id: "r", kind: "custom", severity: "info", status: "active", message: "Wiadomość", instrument_id: null, instrument_label: null,
  payload: {}, first_seen_at: "2026-10-01T07:00:00Z", decisions: [], ...over });

test("decideItems: worse thesis health first, then undecided signals (action first), snoozed and decided out", () => {
  const research = { theses_changed: [
    { instrument_id: 9, label: "Złoto ETC", from: "current", to: "weakened" },
    { instrument_id: 8, label: "Inna", from: "current", to: "supported" },
  ] };
  const { items, more } = decideItems([
    sig({ id: 1 }),
    sig({ id: 2, severity: "action" }),
    sig({ id: 3, snoozed: true }),
    sig({ id: 4, decisions: [{ action: "held" }] }),
  ], research);
  assert.deepEqual(items.map((i) => i.key), ["t:9", "s:2", "s:1"]);
  assert.equal(items[0].title, "Złoto ETC: teza osłabiona");
  assert.equal(more, 0);
});

test("weekEvents and openIdeas: what matters, no dismissed, accepted or expired", () => {
  const n = (over) => ({ id: 1, kind: "news", strength: 1, thesis_relation: "none", dismissed_at: null, observed_at: "2026-10-28T10:00:00Z", title: "t", ...over });
  const ev = weekEvents([n({ id: 1 }), n({ id: 2, strength: 2 }), n({ id: 3, thesis_relation: "weakens" }), n({ id: 4, strength: 3, dismissed_at: "x" })]);
  assert.deepEqual(ev.map((e) => e.note.id), [3, 2]);
  const ideas = openIdeas([
    n({ id: 5, kind: "candidate", expires_at: "2099-01-01T00:00:00Z" }),
    n({ id: 6, kind: "candidate", candidate: { accepted_at: "2026-10-01" }, expires_at: "2099-01-01T00:00:00Z" }),
    n({ id: 7, kind: "candidate", expires_at: "2000-01-01T00:00:00Z" }),
  ]);
  assert.deepEqual(ideas.map((x) => x.id), [5]);
});

test("deckCards: a quiet week skips the empty cards and says why", () => {
  const quiet = deckCards({ movers: { down: [{ ret: -0.01 }], up: [] }, sectors: sectorRows(att), events: [], macroChanges: [], decide: [], ideas: [] });
  assert.deepEqual(quiet.cards, ["world", "sectors", "calendar"]);
  assert.deepEqual(quiet.skipped.map((s) => s.id), ["positions", "events", "decide", "ideas"]);
  assert.equal(summaryTitle(0), "Gotowe. Nic nie wymaga dalszej uwagi.");
  assert.equal(summaryTitle(1), "Gotowe. Jedna sprawa idzie do agenta.");
  assert.equal(summaryTitle(3), "Gotowe. 3 sprawy idą do agenta.");
});
