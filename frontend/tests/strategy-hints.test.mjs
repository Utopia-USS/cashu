// P2 strategy hints + P3 recommendation freshness (design/v3/strategy-hints/strategy-hints.md, specs P2 / P3
// Frontend), run with `npm test`: chip and line per hint code (held / watched), numbers from params, unknown codes,
// severity classes, the hover card rows (strategia + continuations, value classes, teza / rekomendacja suffixes), the
// touch title, the freshness state, the reason lines and the note row title suffix.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  FRESH_LABEL, FRESH_REASON_SHORT, freshOf, freshReasonLines, freshReasonText, HEALTH_LOC, hintChip, hintCls, hintLine, instCardFacts, instSummary, knownHints,
  noteAfterText, notesVerb, pct0,
} from "../src/modules/investments/v2/logic.ts";
import { noteRowTitle } from "../src/modules/investments/v2/research/logic.ts";

const sp = (x) => x.replace(/ /g, " ");
const h = (code, params = {}, severity = "review") => ({ code, severity, params });
const chip = (code, params, held = true) => sp(hintChip(h(code, params), held));
const line = (code, params, held = true) => sp(hintLine(h(code, params), held));
const inst = (over) => ({ id: 1, label: "CD Projekt", name: "CD Projekt", symbol: "CDR", mic: "XWAR", isin: "PLOPTTC00011", asset_class: "etf", region: "global", status: "active", valuation_mode: "market", needs_classification: false, ...over });

test("pct0: integer percent with nbsp, signed / unsigned, empty for missing", () => {
  assert.equal(sp(pct0(4.55, true)), "+455 %");
  assert.equal(sp(pct0(-0.272)), "-27 %");
  assert.equal(sp(pct0(0.2)), "20 %");
  assert.equal(sp(pct0(12, true)), "+1200 %");
  assert.equal(pct0(null), "");
  assert.equal(pct0(Number.NaN), "");
});

test("hintChip: held copy for every code; numbers from params (loss / drawdown are magnitudes)", () => {
  assert.equal(chip("recommendation_outdated"), "rekomendacja nieaktualna");
  assert.equal(chip("recommendation_maybe_outdated"), "sprawdź rekomendację");
  assert.equal(chip("thesis_invalidated"), "teza podważona");
  assert.equal(chip("plan_vs_thesis", { plan: "buy_asap", health: "weakened" }), "plan kontra teza");
  assert.equal(chip("thesis_fulfilled", { has_exit_plan: true }), "teza spełniona");
  assert.equal(chip("gain_review", { gain: 4.55, threshold: 1 }), "+455 % · plan wyjścia");
  assert.equal(chip("loss_review", { loss: 0.27 }), "-27 % · przegląd tezy");
  assert.equal(chip("drawdown_review", { drawdown: 0.22 }), "-22 % od szczytu");
  assert.equal(chip("concentration", { weight: 0.257, max_weight: 0.2 }), "ponad 20 %");
  assert.equal(chip("thesis_weakened"), "teza osłabiona");
  assert.equal(chip("no_thesis"), "zapisz tezę");
  assert.equal(chip("no_exit_plan"), "bez planu wyjścia");
  // missing numbers: the words alone
  assert.equal(chip("gain_review", {}), "plan wyjścia");
  assert.equal(chip("drawdown_review", {}), "spadek od szczytu");
  assert.equal(chip("concentration", {}), "koncentracja");
});

test("hintChip: watched copy; unknown codes give no chip", () => {
  assert.equal(chip("alert_triggered", { title: "-30 % od szczytu" }, false), "alert: -30 % od szczytu");
  assert.equal(chip("alert_triggered", {}, false), "alert spełniony");
  assert.equal(chip("plan_without_thesis", { plan: "buy" }, false), "kup bez tezy");
  assert.equal(chip("no_thesis", {}, false), "bez tezy");
  assert.equal(chip("sell_now", {}), "");
  assert.equal(line("sell_now", {}), "");
});

test("hintLine: condition, then the review the strategy asks for; plan labels by form; HEALTH_LOC", () => {
  assert.equal(line("thesis_invalidated"), "zaszedł warunek unieważnienia tezy: zanotuj decyzję");
  assert.equal(line("thesis_invalidated", {}, false), "zaszedł warunek unieważnienia tezy: zweryfikuj plan");
  assert.equal(line("plan_vs_thesis", { plan: "buy_asap", health: "weakened" }), "plan dokup asap przy tezie osłabionej: popraw plan albo tezę");
  assert.equal(line("plan_vs_thesis", { plan: "buy", health: "invalidated" }, false), "plan kup przy tezie podważonej: popraw plan albo tezę");
  assert.equal(HEALTH_LOC.weak, "osłabionej");
  assert.equal(HEALTH_LOC.inv, "podważonej");
  assert.equal(line("thesis_fulfilled", { has_exit_plan: true }), "teza spełniona: sprawdź plan wyjścia");
  assert.equal(line("thesis_fulfilled", { has_exit_plan: false }), "teza spełniona, brak planu wyjścia: zapisz go");
  assert.equal(line("thesis_fulfilled", {}, false), "teza spełniona bez pozycji: zweryfikuj plan");
  assert.equal(line("gain_review", { gain: 4.55, threshold: 1, has_exit_plan: true }), "+455 % od kosztu, próg +100 %: sprawdź plan wyjścia");
  assert.equal(line("gain_review", { gain: 4.55, has_exit_plan: false }), "+455 % od kosztu, brak planu wyjścia: zapisz go");
  assert.equal(line("loss_review", { loss: 0.27, threshold: 0.25 }), "-27 % od kosztu, próg -25 %: czy teza jest aktualna?");
  assert.equal(line("drawdown_review", { drawdown: 0.22 }), "-22 % od szczytu: czy teza jest aktualna?");
  assert.equal(line("concentration", { weight: 0.257, max_weight: 0.2 }), "25,7 % portfela, limit 20 %: przegląd koncentracji");
  assert.equal(line("thesis_weakened"), "research osłabia tezę: przejrzyj notatki");
  assert.equal(line("no_thesis"), "pozycja bez zapisanej tezy: zapisz tezę i warunek unieważnienia");
  assert.equal(line("no_thesis", {}, false), "bez zapisanej tezy");
  assert.equal(line("no_exit_plan"), "teza bez planu wyjścia: uzupełnij go");
  assert.equal(line("alert_triggered", { title: "poniżej 180,00 $" }, false), "alert spełniony: poniżej 180,00 $. sprawdź tezę i plan");
  assert.equal(line("plan_without_thesis", { plan: "buy_asap" }, false), "plan kup asap bez tezy: najpierw zapisz tezę");
  assert.equal(line("recommendation_outdated", { reasons: ["note_invalidates", "thesis_changed"] }), "rekomendacja nieaktualna: notatka podważa tezę, teza zmieniona");
  assert.equal(line("recommendation_maybe_outdated", { reasons: ["age", "bogus"] }), "rekomendacja do sprawdzenia: starsza niż 30 dni");
  assert.equal(line("recommendation_maybe_outdated", {}), "rekomendacja do sprawdzenia");
  for (const l of Object.values(FRESH_REASON_SHORT)) assert.doesNotMatch(l, /\u2014/);
});

test("hintCls / knownHints: severity class, unknown codes dropped in payload order", () => {
  assert.equal(hintCls("rule"), "rule");
  assert.equal(hintCls("review"), "review");
  assert.equal(hintCls("info"), "info");
  assert.equal(hintCls("whatever"), "info");
  const list = [h("bogus"), h("no_thesis", {}, "info"), h("thesis_weakened")];
  assert.deepEqual(knownHints(list, true).map((x) => x.code), ["no_thesis", "thesis_weakened"]);
  assert.deepEqual(knownHints(null, true), []);
});

test("instCardFacts: strategia rows after rekomendacja / teza, continuation keys empty, value classes; recommendation hints folded into the rekomendacja row", () => {
  const hints = [h("recommendation_maybe_outdated", { reasons: ["age"] }), h("plan_vs_thesis", { plan: "buy_asap", health: "weakened" }, "rule"), h("thesis_weakened"), h("no_exit_plan", {}, "info")];
  const f = instCardFacts(inst({ plan: "buy_asap", plan_at: "2026-10-06T08:00:00Z", plan_freshness: { state: "maybe_outdated", reasons: [{ code: "age", at: null }] } }),
    { held: true, health: "weak", hints, accounts: ["XTB · IKE"] });
  assert.deepEqual(f.rows.map((r) => r[0]), ["rekomendacja", "teza", "strategia", "", "", "klasa", "rachunek", "ISIN"]);
  assert.equal(f.rows[0][1], "dokup asap · 6.10 · może być nieaktualna");
  assert.equal(f.rows[2][1], "plan dokup asap przy tezie osłabionej: popraw plan albo tezę");
  assert.deepEqual(f.rows.slice(2, 5).map((r) => r[2]), ["hv rule", "hv review", "hv info"]);
  assert.equal(f.rows[5].length, 2);
  // no plan row: the recommendation hint stays a strategia row
  const g = instCardFacts(inst({}), { held: true, hints: [h("recommendation_outdated", { reasons: [] }, "rule")] });
  assert.deepEqual(g.rows[0], ["strategia", "rekomendacja nieaktualna", "hv rule"]);
  // outdated plan
  const o = instCardFacts(inst({ plan: "hold", plan_at: "2026-10-06T08:00:00Z", plan_freshness: { state: "outdated", reasons: [] } }), { held: true });
  assert.equal(o.rows[0][1], "trzymaj · 6.10 · nieaktualna");
  const fresh = instCardFacts(inst({ plan: "hold", plan_at: "2026-10-06T08:00:00Z", plan_freshness: { state: "fresh", reasons: [] } }), { held: true });
  assert.equal(fresh.rows[0][1], "trzymaj · 6.10");
});

test("instCardFacts: teza suffix, stale research wins over research older than the thesis", () => {
  assert.equal(instCardFacts(inst({}), { health: "ful", pre: true }).rows[0][1], "spełniona · research sprzed zmiany tezy");
  assert.equal(instCardFacts(inst({}), { health: "ful", pre: true, healthStale: true }).rows[0][1], "spełniona · research nieaktualny");
  assert.equal(instCardFacts(inst({}), { health: "ful" }).rows[0][1], "spełniona");
});

test("instSummary: strategia suffix = the main hint's chip, no hint lines in the title", () => {
  const s = sp(instSummary(inst({}), { held: true, hints: [h("bogus"), h("loss_review", { loss: 0.27 }), h("no_exit_plan", {}, "info")] }));
  assert.match(s, / · strategia: -27 % · przegląd tezy$/);
  assert.doesNotMatch(s, /czy teza/);
  assert.doesNotMatch(sp(instSummary(inst({}), { held: true })), /strategia/);
});

test("freshOf / FRESH_LABEL: maybe (yellow), out (red), nothing for fresh / none / unknown", () => {
  assert.equal(freshOf({ state: "maybe_outdated" }), "maybe");
  assert.equal(freshOf({ state: "outdated" }), "out");
  assert.equal(freshOf({ state: "fresh" }), null);
  assert.equal(freshOf({ state: "weird" }), null);
  assert.equal(freshOf(null), null);
  assert.deepEqual(FRESH_LABEL, { maybe: "może być nieaktualna", out: "nieaktualna" });
});

test("notesVerb: Polish numeral agreement per relation", () => {
  assert.equal(notesVerb(1, "invalidates"), "notatka podważa tezę");
  assert.equal(notesVerb(null, "weakens"), "notatka osłabia tezę");
  assert.equal(notesVerb(3, "weakens"), "3 notatki osłabiają tezę");
  assert.equal(notesVerb(5, "supports"), "5 notatek wzmacnia tezę");
  assert.equal(notesVerb(12, "fulfills"), "12 notatek spełnia tezę");
  assert.equal(notesVerb(22, "fulfills"), "22 notatki spełniają tezę");
  assert.equal(notesVerb(2, null), "2 notatki dotyczą tezy");
});

test("noteAfterText: one note reads like its relation chip, several read neutrally (review FE-2 / FE-3)", () => {
  assert.equal(noteAfterText(1, "weakens"), "notatka osłabia tezę");
  assert.equal(noteAfterText(null, "supports"), "notatka wzmacnia tezę");
  assert.equal(noteAfterText(1, "neutral"), "notatka nie dotyka tezy");
  assert.equal(noteAfterText(1, null), "nowa notatka");
  assert.equal(noteAfterText(3, "weakens"), "3 nowe notatki");
  assert.equal(noteAfterText(5, "fulfills"), "5 nowych notatek");
  assert.equal(noteAfterText(22, "supports"), "22 nowe notatki");
  assert.equal(freshReasonText({ code: "note_after", at: null, count: 3, relation: "weakens" }), "3 nowe notatki");
  assert.equal(freshReasonText({ code: "note_after", at: null, count: 1, relation: "neutral" }), "notatka nie dotyka tezy");
});

test("freshReasonText / freshReasonLines: dated lines, thresholds from hints, alert titles, note ids", () => {
  const hints = [h("gain_review", { gain: 1.12, threshold: 1 }), h("concentration", { weight: 0.25, max_weight: 0.2 })];
  const alerts = [{ id: 7, title: "-30 % od szczytu", kind: "drawdown_from_high" }];
  const f = {
    state: "outdated",
    reasons: [
      { code: "note_invalidates", at: "2026-10-07T09:00:00+00:00", note_id: 41, relation: "invalidates", count: 1 },
      { code: "thesis_changed", at: "2026-10-07T10:00:00+00:00" },
      { code: "rule_fired", at: "2026-10-08T06:00:00+00:00", signal_id: 3, kind: "gain_from_cost" },
      { code: "rule_fired", at: "2026-10-08T06:00:00+00:00", signal_id: 4, kind: "position_concentration" },
      { code: "rule_fired", at: "2026-10-08T06:00:00+00:00", signal_id: 5, kind: "loss_from_cost" },
      { code: "alert_triggered", at: "2026-10-08T06:00:00+00:00", alert_id: 7, kind: "drawdown_from_high" },
      { code: "alert_triggered", at: "2026-10-08T06:00:00+00:00", alert_id: 99, kind: "price_below" },
      { code: "age", at: "2026-11-05T00:00:00+00:00" },
      { code: "future_code", at: null },
    ],
  };
  const lines = freshReasonLines(f, { hints, alerts });
  assert.deepEqual(lines.map((l) => sp(l.text)), [
    "7.10 · notatka podważa tezę", "7.10 · teza zmieniona", "8.10 · +100 % od kosztu", "8.10 · ponad 20 % portfela", "8.10 · strata od kosztu",
    "8.10 · alert: -30 % od szczytu", "8.10 · alert: cena poniżej", "starsza niż 30 dni",
  ]);
  assert.equal(lines[0].noteId, 41);
  assert.equal(lines[1].noteId, null);
  assert.equal(freshReasonText({ code: "fulfilled_buy", at: null, count: 2, relation: "fulfills" }), "2 notatki spełniają tezę");
  assert.equal(freshReasonText({ code: "thesis_invalidated", at: null }), "teza podważona");
  assert.deepEqual(freshReasonLines({ state: "fresh", reasons: [{ code: "age", at: null }] }), []);
  assert.deepEqual(freshReasonLines(null), []);
});

test("noteRowTitle: `sprzed zmiany tezy` suffix for a note older than the thesis", () => {
  const n = { kind: "news", observed_at: "2026-10-03T08:00:00Z", dismissed_at: null, expires_at: null };
  assert.doesNotMatch(noteRowTitle(n, "2026-10-06"), /sprzed/);
  assert.match(noteRowTitle({ ...n, predates_thesis: true }, "2026-10-06"), / · sprzed zmiany tezy$/);
});
