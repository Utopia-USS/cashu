// The weekly review deck (v2/reviewDeckLogic.ts): the week's verdict vs the portfolio's typical week and the
// benchmark, sectors and movers from the segment attribution, what waits for a decision, skipped cards.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  deckCards, decideItems, decideSubjects, openIdeas, sectorRows, sectorsTitle, shareWords, summaryTitle, topMovers, weekEvents, weeklySigma, worldVerdict,
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

test("decideItems: thesis changes and new signals only; snoozed, decided and old unchanged states stay out", () => {
  const research = { theses_changed: [
    { instrument_id: 9, label: "Złoto ETC", from: "current", to: "weakened" },
    { instrument_id: 8, label: "Inna", from: "current", to: "supported" },
  ] };
  const { items, more, rest } = decideItems([
    sig({ id: 1, rule_id: "a", instrument_id: 5 }),
    sig({ id: 2, rule_id: "b", severity: "action", instrument_id: 6, first_seen_at: "2026-10-29T07:00:00Z" }),
    sig({ id: 3, instrument_id: 7, snoozed: true, first_seen_at: "2026-10-29T07:00:00Z" }),
    sig({ id: 4, instrument_id: 7, decisions: [{ action: "held" }], first_seen_at: "2026-10-29T07:00:00Z" }),
  ], research, undefined, [], { since: "2026-10-26T00:00:00Z", now: Date.parse("2026-10-30T12:00:00Z") });
  assert.deepEqual(items.map((i) => i.key), ["t:9", "s:i:6"]);
  assert.equal(items[0].title, "Złoto ETC: teza osłabiona");
  assert.equal(items[1].group, "mixed");
  assert.deepEqual(rest, { review: 1, research: 0 });
  assert.equal(more, 0);
});

test("shareWords: a share in words, the percentage below a tenth", () => {
  assert.equal(shareWords(0.354), "ponad 1/3");
  assert.equal(shareWords(-0.68), "ok. 2/3");
  assert.equal(shareWords(-0.691), "ponad 2/3");
  assert.equal(shareWords(0.5), "ok. połowę");
  assert.equal(shareWords(0.05).replace(/\s/g, " "), "5 %");
});

// A week like a real profile's (synthetic names and numbers): 27 open signals, of which four subjects deserve a
// decision and three portfolio rules hang for weeks.
const SINCE = "2026-10-26T00:00:00Z";
const NOW = Date.parse("2026-10-30T12:00:00Z");
const OLD = "2026-10-05T14:00:00Z";
const dd = (id, inst, threshold, drawdown, over) => sig({ id, rule_id: `dd${threshold}`, kind: "drawdown_from_high", polarity: "positive", instrument_id: inst, payload: { drawdown, threshold, window_days: 252 }, first_seen_at: OLD, ...over });
const loss = (id, inst, u) => sig({ id, rule_id: "loss", kind: "loss_from_cost", polarity: "negative", instrument_id: inst, payload: { unrealized_pct: u, threshold: 0.25 }, first_seen_at: OLD });
const gain = (id, inst, u) => sig({ id, rule_id: "gain", kind: "gain_from_cost", polarity: "positive", instrument_id: inst, payload: { unrealized_pct: u, threshold: 1 }, first_seen_at: OLD });
const note = (id, inst, relation, title, kind = "research:news") => sig({ id, rule_id: kind, kind, polarity: relation === "fulfills" || relation === "supports" ? "positive" : "negative", instrument_id: inst, payload: { relation, title, kind: kind.slice(9) }, first_seen_at: OLD });
const WEEK = [
  sig({ id: 1, rule_id: "rebalance", kind: "allocation_drift", severity: "action", payload: { bucket_id: "active", drift_pp: 40 }, first_seen_at: OLD }),
  sig({ id: 2, rule_id: "rebalance", kind: "allocation_drift", severity: "action", payload: { bucket_id: "core", drift_pp: -40 }, first_seen_at: OLD }),
  sig({ id: 3, rule_id: "deposit", kind: "contribution_gap", severity: "action", polarity: "negative", payload: { last_deposit: "2024-10-31" }, first_seen_at: OLD }),
  // ETF reserve ladder: -15 / -25 % since early October, -35 % new this week
  dd(4, 40, 0.15, 0.354, { severity: "action" }), dd(5, 40, 0.25, 0.354, { severity: "action" }), dd(6, 40, 0.35, 0.354, { severity: "action", first_seen_at: "2026-10-29T17:00:00Z" }),
  // games: thesis weakened, deep loss
  dd(7, 19, 0.2, 0.417), loss(8, 19, -0.691), note(9, 19, "weakens", "Założyciele nie przejmą spółki"),
  // uranium: thesis weakened
  dd(10, 3, 0.2, 0.703), note(11, 3, "weakens", "Przejęcie z emisją ok. 1/4 nowych akcji"),
  // chips: thesis fulfilled, the exit plan written after the signals
  dd(12, 20, 0.2, 0.347), gain(13, 20, 3.437), note(14, 20, "fulfills", "Wycena wróciła do poziomu z tezy", "research:earnings"),
  // unchanged states (review): drawdown, drawdown + loss, gain + supporting note, gain, loss + unrelated news, supporting note
  dd(15, 7, 0.2, 0.216), dd(16, 8, 0.2, 0.592), loss(17, 8, -0.544), gain(18, 11, 1.234), note(19, 11, "supports", "Rekordowy kwartał", "research:earnings"),
  gain(20, 12, 1.15), loss(21, 16, -0.312), note(22, 16, null, "Oferta przejęcia wycofana"), note(23, 24, "supports", "Sprzedaż rośnie", "research:earnings"),
  // news only (Research): earnings and trends of watched names, macro without an instrument
  note(24, 29, null, "Słaby kwartał", "research:earnings"), note(25, 34, null, "Wysoka wycena", "research:trend"), note(26, 33, null, "Plan produktu", "research:trend"),
  note(27, null, null, "Cena surowca rośnie", "research:macro"),
];
const NAMES = new Map([[40, "ETF Małe Kopalnie Złota"], [19, "Wydawca Gier"], [3, "Producent Uranu"], [20, "Producent Chipów"]]);
const THESES = new Map([
  [20, { invalidation: null, exit_plan: "Zamknąć całą pozycję przy 72 albo 80 USD. Szczegóły zleceń w notatce.", exit_plan_changed_at: "2026-10-29T21:29:00Z" }],
  [19, { invalidation: "[do potwierdzenia] Marki dalej tracą, a przejęcie przestaje być realne.", exit_plan: "Po odbiciu albo przy przejęciu.", exit_plan_changed_at: OLD }],
  [3, { invalidation: "Atom przestaje rosnąć.", exit_plan: null, exit_plan_changed_at: null }],
]);

test("decideItems on a real-like week: 27 signals become four subjects and one rules-to-fix item", () => {
  const { items, rest, more } = decideItems(WEEK, null, NAMES, [], { since: SINCE, theses: THESES, now: NOW });
  assert.deepEqual(items.map((i) => [i.title, i.group]), [
    ["Wydawca Gier", "risk"], ["Producent Uranu", "risk"], ["ETF Małe Kopalnie Złota", "chance"], ["Producent Chipów", "plan"], ["3 sygnały wiszą od tygodni", "fix"],
  ]);
  assert.deepEqual(rest, { review: 6, research: 4 });
  assert.equal(more, 0);
  const [games, uranium, gold, chips, fix] = items;
  assert.equal(games.why, "Założyciele nie przejmą spółki");
  assert.equal(games.tag, "Ryzyko · teza osłabiona");
  assert.match(games.context, /^Spadek o ponad 1\/3 od rocznego szczytu\. Pozycja ponad 2\/3 pod kreską\. /);
  assert.match(games.context, /Teza upada, gdy: Marki dalej tracą, a przejęcie przestaje być realne\.$/);
  assert.deepEqual(games.signalIds.sort((a, b) => a - b), [7, 8, 9]);
  assert.equal(uranium.why, "Przejęcie z emisją ok. 1/4 nowych akcji");
  // one item for the ladder, the deepest step speaks, all three signals are decided together
  assert.equal(gold.why.replace(/\s/g, " "), "Spadek o ponad 1/3 od rocznego szczytu przekroczył Twój próg -35 %.");
  assert.equal(gold.tag, "Szansa · nowe");
  assert.match(gold.context, /^To już 3\. próg tej reguły; wcześniejsze czekają bez decyzji od 05\.10\./);
  assert.deepEqual(gold.signalIds.sort((a, b) => a - b), [4, 5, 6]);
  // the exit plan changed after the signals: the decision is taken, the plan is in progress
  assert.equal(chips.tag, "Plan w toku · teza spełniona");
  assert.match(chips.context, /Pozycja jest warta ponad 4× tyle, ile kosztowała\./);
  assert.match(chips.context, /Twój plan: Zamknąć całą pozycję przy 72 albo 80 USD\.$/);
  assert.deepEqual(chips.actions.map((a) => a.action), ["sold", "held", "snooze"]);
  assert.equal(fix.kind, "rules");
  assert.deepEqual(fix.signalIds.sort((a, b) => a - b), [1, 2, 3]);
  assert.deepEqual(fix.actions.map((a) => a.action), ["ack", "snooze"]);
});

test("decideItems: the same week right after a review is quiet; decideSubjects names the theses to load", () => {
  const after = decideItems(WEEK.map((s) => (s.id === 9 || s.id === 11 || s.id === 14 ? { ...s, decisions: [{ action: "held" }] } : s)), null, NAMES, [],
    { since: "2026-10-30T00:00:00Z", theses: THESES, now: NOW });
  assert.deepEqual(after.items.map((i) => i.group), ["fix"]);
  assert.deepEqual(decideSubjects(WEEK, SINCE).sort((a, b) => a - b), [3, 19, 20, 40]);
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
  assert.deepEqual(quiet.skipped.map((s) => s.id), ["positions", "events", "ideas", "decide"]);
  assert.equal(summaryTitle(0), "Gotowe. Nic nie wymaga dalszej uwagi.");
  assert.equal(summaryTitle(1), "Gotowe. Jedna sprawa idzie do agenta.");
  assert.equal(summaryTitle(3), "Gotowe. 3 sprawy idą do agenta.");
});

test("decideItems: a week's thesis change gives an instrument's unchanged signals a reason, counted once", () => {
  const research = { theses_changed: [{ instrument_id: 5, label: "ACME", from: "current", to: "weakened" }] };
  const { items, rest } = decideItems([dd(1, 5, 0.2, 0.3)], research, new Map([[5, "ACME"]]), [], { since: SINCE, now: NOW });
  assert.deepEqual(items.map((i) => [i.key, i.group, i.tag]), [["s:i:5", "risk", "Ryzyko · teza osłabiona"]]);
  assert.equal(items[0].why, "Research znalazł fakty przeciw tezie.");
  assert.deepEqual(items[0].signalIds, [1]);
  assert.deepEqual(rest, { review: 0, research: 0 });
  assert.deepEqual(decideSubjects([dd(1, 5, 0.2, 0.3)], SINCE, research), [5]);
});

test("decideItems: only an exit plan changed after the signals means in progress, not any thesis edit", () => {
  const signal = dd(1, 5, 0.2, 0.3, { severity: "action", polarity: "negative", first_seen_at: "2026-10-27T07:00:00Z" });
  const edited = { invalidation: null, exit_plan: "Sprzedam przy 200.", exit_plan_changed_at: "2026-06-01T10:00:00Z" };
  const planned = { ...edited, exit_plan_changed_at: "2026-10-29T10:00:00Z" };
  const run = (t) => decideItems([signal], null, undefined, [], { since: SINCE, now: NOW, theses: new Map([[5, t]]) }).items[0].group;
  assert.equal(run(edited), "risk");
  assert.equal(run(planned), "plan");
});

test("decideItems: only threshold steps of one polarity form a ladder; custom rules and alerts stay apart", () => {
  const fresh = "2026-10-28T07:00:00Z";
  const { items } = decideItems([
    sig({ id: 1, rule_id: "buy_dip", kind: "custom", polarity: "positive", instrument_id: 5, first_seen_at: fresh }),
    sig({ id: 2, rule_id: "pe_high", kind: "custom", polarity: "negative", instrument_id: 5, first_seen_at: "2026-10-29T07:00:00Z" }),
  ], null, undefined, [], { since: SINCE, now: NOW });
  assert.equal(items[0].group, "mixed");
  assert.doesNotMatch(items[0].context ?? "", /próg tej reguły/);
  assert.deepEqual(items[0].signalIds.sort(), [1, 2]);
});

test("decideItems: server times without a zone and with microseconds parse like the rest of the app", () => {
  const { items } = decideItems([dd(1, 5, 0.2, 0.3, { severity: "action", first_seen_at: "2026-10-29 17:28:09.651694" })], null, undefined, [],
    { since: "2026-10-26T17:00:00.123456", now: NOW });
  assert.equal(items.length, 1);
  assert.match(items[0].tag, /nowe$/);
});

test("decideItems: without a review for weeks, old states are not new; the same four subjects remain", () => {
  const { items, rest } = decideItems(WEEK, null, NAMES, [], { since: "2026-10-05T14:16:48Z", theses: THESES, now: NOW });
  assert.deepEqual(items.map((i) => i.group), ["risk", "risk", "chance", "plan", "fix"]);
  assert.deepEqual(rest, { review: 6, research: 4 });
  assert.deepEqual(decideSubjects(WEEK, "2026-10-05T14:16:48Z", null, NOW).sort((a, b) => a - b), [3, 19, 20, 40]);
});
