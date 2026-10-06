// P1 plan badges (design/v3/plan-badges/plan-badges.md, spec P1 Frontend), run with `npm test`: plan labels per held /
// watched, the glyph paths, the tile ring per health x stale, the hover card / touch title rows, the `fulfills`
// relation and `fulfilled` health, and the recommendation-check signal copy.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  instCardFacts, instSummary, isPlanKind, PLAN_HELD, PLAN_PATH, PLAN_VALUES, PLAN_WATCHED, planFact, planLabel, planOptions, ringOf, ruleKindLabel,
  signalFact, signalText,
} from "../src/modules/investments/v2/logic.ts";
import {
  chipsFromFields, countsText, fieldChips, HEALTH_CLS, HEALTH_LABEL, HEALTH_RANK, healthOf, normHealth, normRelation, orderTheses, RELATION_CLS,
  RELATION_LABEL, relationCounts, relationIcon, thesisHealth,
} from "../src/modules/investments/v2/research/logic.ts";

const inst = (over) => ({ id: 1, label: "Vanguard FTSE All-World", name: "Vanguard FTSE All-World", symbol: "VWCE", mic: "XETR", isin: "IE00BK5BQT80", asset_class: "etf", region: "global", status: "active", valuation_mode: "market", needs_classification: false, ...over });

test("planLabel: held and watched forms for every value; held-only and unknown values give no label", () => {
  const held = PLAN_VALUES.map((p) => planLabel(p, true));
  assert.deepEqual(held, ["dokup asap", "dokup", "trzymaj", "redukuj", "pozbądź się asap"]);
  const watched = PLAN_VALUES.map((p) => planLabel(p, false));
  assert.deepEqual(watched, ["kup asap", "kup", "czekam", "", ""]);
  assert.equal(planLabel("hold", true), "trzymaj");
  assert.equal(planLabel("hold", false), "czekam");
  assert.equal(planLabel(null, true), "");
  assert.equal(planLabel(undefined, false), "");
  assert.equal(planLabel("sell_everything", true), "");
  assert.deepEqual(Object.keys(PLAN_HELD), [...PLAN_VALUES]);
  assert.deepEqual(Object.keys(PLAN_WATCHED), ["buy_asap", "buy", "hold"]);
  assert.deepEqual(planOptions(true), ["buy_asap", "buy", "hold", "reduce", "exit_asap"]);
  assert.deepEqual(planOptions(false), ["buy_asap", "buy", "hold"]);
  for (const v of [...Object.values(PLAN_HELD), ...Object.values(PLAN_WATCHED)]) assert.ok(!v.includes(String.fromCharCode(0x2014)), v); // never the em dash
});

test("PLAN_PATH: exactly the five plans, chevrons up / dash / down", () => {
  assert.deepEqual(Object.keys(PLAN_PATH).sort(), [...PLAN_VALUES].sort());
  assert.equal(PLAN_PATH.hold, "M3 6h6");
  assert.equal(PLAN_PATH.buy_asap.split("M").length - 1, 2); // double chevron
  assert.equal(PLAN_PATH.exit_asap.split("M").length - 1, 2);
  assert.equal(PLAN_PATH.buy.split("M").length - 1, 1);
});

test("ringOf: only supported / fulfilled / weakened / invalidated without stale research draw a ring", () => {
  const keys = ["inv", "weak", "ful", "sup", "ok", "no_thesis", "no_research"];
  for (const k of keys) {
    assert.equal(ringOf(k, true), null, `${k} stale`);
    assert.equal(ringOf(k, false), ["inv", "weak", "ful", "sup"].includes(k) ? k : null, k);
  }
  assert.equal(ringOf(null, false), null);
  assert.equal(ringOf(undefined, false), null);
});

test("instCardFacts: recommendation and thesis rows first, date, stale suffix, nothing without a recommendation or a summary row", () => {
  const f = instCardFacts(inst({ plan: "buy", plan_at: "2026-10-06T08:00:00Z" }), { accounts: ["XTB · IKE"], held: true, health: "ful" });
  assert.deepEqual(f.rows, [["rekomendacja", "dokup · 6.10"], ["teza", "spełniona"], ["klasa", "ETF · globalny"], ["rachunek", "XTB · IKE"], ["ISIN", "IE00BK5BQT80"]]);
  // without plan_at: the label alone; watched form
  assert.deepEqual(instCardFacts(inst({ plan: "hold", plan_at: null }), { held: false }).rows[0], ["rekomendacja", "czekam"]);
  // unknown held state -> the held form
  assert.deepEqual(instCardFacts(inst({ plan: "hold" }), {}).rows[0], ["rekomendacja", "trzymaj"]);
  // stale research
  assert.deepEqual(instCardFacts(inst({}), { health: "sup", healthStale: true }).rows[0], ["teza", "wzmocniona · research nieaktualny"]);
  // a fine thesis is a fact too; no_thesis / no_research read as words
  assert.deepEqual(instCardFacts(inst({}), { health: "ok" }).rows[0], ["teza", "aktualna"]);
  assert.deepEqual(instCardFacts(inst({}), { health: "no_thesis" }).rows[0], ["teza", "bez tezy"]);
  assert.deepEqual(instCardFacts(inst({}), { health: "no_research" }).rows[0], ["teza", "bez researchu"]);
  // no plan, no summary row: the old card
  const plain = instCardFacts(inst({ plan: null }), { health: null });
  assert.deepEqual(plain.rows.map((r) => r[0]), ["klasa", "ISIN"]);
  // a held-only plan on a watched instrument or an unknown value: no row
  assert.deepEqual(instCardFacts(inst({ plan: "reduce" }), { held: false }).rows.map((r) => r[0]), ["klasa", "ISIN"]);
  assert.deepEqual(instCardFacts(inst({ plan: "moon" }), { held: true }).rows.map((r) => r[0]), ["klasa", "ISIN"]);
});

test("instSummary: the touch title appends `rekomendacja: …` and `teza: …`", () => {
  assert.equal(instSummary(inst({ plan: "buy", plan_at: "2026-10-06T08:00:00Z" }), { accounts: ["XTB · IKE"], held: true, health: "ful", healthStale: true }),
    "VWCE · Xetra · ETF · globalny · XTB · IKE · IE00BK5BQT80 · rekomendacja: dokup · teza: spełniona");
  assert.equal(instSummary(inst({}), {}), "VWCE · Xetra · ETF · globalny · IE00BK5BQT80");
  assert.equal(instSummary(inst({ plan: "buy_asap" }), { held: false }), "VWCE · Xetra · ETF · globalny · IE00BK5BQT80 · rekomendacja: kup asap");
});

test("fulfills relation and fulfilled health: labels, classes, precedence and attention order", () => {
  assert.equal(normHealth("fulfilled"), "ful");
  assert.equal(normHealth("spełniona"), "ful");
  assert.equal(normRelation("fulfills"), "fulfills");
  assert.equal(HEALTH_LABEL.ful, "spełniona");
  assert.equal(HEALTH_CLS.ful, "ful");
  assert.equal(RELATION_LABEL.fulfills, "spełnia tezę");
  assert.equal(RELATION_CLS.fulfills, "ful");
  assert.deepEqual(relationIcon("fulfills"), { cls: "ful", glyph: "✓", label: "spełnia tezę" });
  // spec HEALTH_ORDER: invalidated, weakened, fulfilled, no_research, no_thesis, supported, current
  assert.deepEqual(Object.entries(HEALTH_RANK).sort((a, b) => a[1] - b[1]).map(([k]) => k), ["inv", "weak", "ful", "no_research", "no_thesis", "sup", "ok"]);
  assert.deepEqual(orderTheses([{ label: "A", health: "sup" }, { label: "B", health: "ful" }, { label: "C", health: "weak" }]).map((r) => r.label), ["C", "B", "A"]);
  // precedence: invalidated > weakened > fulfilled > supported
  const today = "2026-10-05";
  const n = (rel) => ({ kind: "news", thesis_relation: rel, observed_at: "2026-10-03T08:00:00Z", expires_at: null, dismissed_at: null });
  const h = (notes) => thesisHealth({ hasThesis: true, notes, today });
  assert.equal(h([n("fulfills"), n("supports")]), "ful");
  assert.equal(h([n("fulfills"), n("weakens")]), "weak");
  assert.equal(h([n("fulfills"), n("invalidates")]), "inv");
  const c = relationCounts([n("fulfills"), n("supports")]);
  assert.equal(c.fulfills, 1);
  assert.equal(healthOf({ health: null, counts: c, last_researched_at: null }, today), "ful");
  assert.equal(healthOf({ health: "fulfilled", counts: { supports: 0, weakens: 0, invalidates: 0, neutral: 0, community: 0 }, last_researched_at: null }, today), "ful");
  assert.equal(countsText("ful", c), "1 spełnia · 1 wzmacnia");
  assert.equal(fieldChips([{ thesis_relation: "fulfills", thesis_field: "exit_plan" }, { thesis_relation: "supports", thesis_field: "exit_plan" }]).get("exit_plan").text, "1 notatka spełnia");
  assert.equal(chipsFromFields([{ field: "thesis", supports: 1, weakens: 0, invalidates: 0, fulfills: 2, neutral: 0 }]).get("thesis").text, "2 notatki spełniają");
});

const planSig = (kind, payload, message = "") => ({ id: 1, rule_id: kind, kind, severity: "info", status: "active", message, instrument_id: 5, instrument_label: "KGHM", account_id: null, payload, first_seen_at: "2026-10-04T07:00:00Z", last_seen_at: "2026-10-04T07:00:00Z" });

test("recommendation checks: kind label, fact from payload, server message as fallback", () => {
  assert.ok(isPlanKind("plan:plan_no_exit"));
  assert.ok(!isPlanKind("gain_from_cost"));
  assert.equal(ruleKindLabel("plan:plan_no_exit"), "Rekomendacja");
  assert.equal(ruleKindLabel("plan:plan_vs_thesis"), "Rekomendacja");
  const ful = planSig("plan:plan_no_exit", { check: "plan_no_exit", plan: "hold", health: "fulfilled", has_exit_plan: false, unrealized: 0.4, trigger: "fulfilled" }, "Teza spełniona, brak planu wyjścia");
  assert.deepEqual(signalFact(ful), { pre: "teza", bold: "spełniona", post: ", brak planu wyjścia" });
  const t = signalText(ful);
  assert.equal(t.title, "KGHM");
  assert.equal([t.lead, t.bold, t.tail].join(" "), "Rekomendacja · teza spełniona · brak planu wyjścia");
  const gain = planSig("plan:plan_no_exit", { check: "plan_no_exit", plan: null, health: "current", has_exit_plan: false, unrealized: 1.12, trigger: "gain" });
  const g = signalFact(gain);
  assert.equal(g.bold.replace(/\s/g, " "), "+112,0 %");
  assert.equal(g.post, "od kosztu, brak planu wyjścia");
  const vs = planSig("plan:plan_vs_thesis", { check: "plan_vs_thesis", plan: "buy_asap", health: "invalidated", has_exit_plan: true, unrealized: 0.1 }, "Rekomendacja: dokup asap, teza podważona");
  assert.deepEqual(planFact(vs), { pre: "rekomendacja", bold: "dokup asap", post: ", teza podważona" });
  const vt = signalText(vs);
  assert.equal([vt.lead, vt.bold, vt.tail].join(" "), "Rekomendacja · dokup asap · teza podważona");
  // unknown payload: the server's Polish message
  assert.deepEqual(signalFact(planSig("plan:plan_new_check", {}, "Rekomendacja: coś nowego")), { pre: "Rekomendacja: coś nowego", bold: "" });
});
