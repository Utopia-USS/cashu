// Polish label map for coded backend messages (src/core/messages.ts), run with `npm test`.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  LABELS, describeImportWarning, describeIssue, fill, label, plural, proposalError, proposalSummary,
} from "../src/core/messages.ts";

test("templates fill their params, a missing param falls back (null)", () => {
  assert.equal(fill("Brak {key}", { key: "version" }), "Brak version");
  assert.equal(fill("Brak {key}", {}), null);
  assert.equal(fill("match: {}", {}), "match: {}"); // braces without a name are text
  assert.equal(label("strategy.required", { key: "base_currency" }), "Brak base_currency");
  assert.equal(label("strategy.required", {}), null);
  assert.equal(label("strategy.no_such_code", { key: "x" }), null);
  assert.equal(label(null), null);
});

test("strategy issues: Polish when the code is known, English otherwise", () => {
  const typo = { code: "strategy.unknown_key", params: { key: "horizon_yaers", suggestion: "horizon_years" },
    message: 'Unknown key "horizon_yaers" (did you mean "horizon_years"?); it is ignored' };
  assert.deepEqual(describeIssue(typo), {
    text: "Nieznany klucz „horizon_yaers\" (czy chodziło o „horizon_years\"?); jest pomijany",
    detail: null, translated: true,
  });
  const range = { code: "strategy.out_of_range", message: "x",
    params: { key: "threshold", range: "at least 0 and at most 1", value: "2", fraction_hint: " (fractions: 0.15 = 15%)" } };
  assert.equal(describeIssue(range).text, "threshold musi być co najmniej 0 i co najwyżej 1, jest 2 (ułamki: 0.15 = 15%)");
  assert.equal(describeIssue({ code: "strategy.not_text", params: { key: "tags", value: "a mapping" }, message: "m" }).text,
    "tags musi być tekstem, jest mapą");
  // an older server (no code) and the catch-all code show the English text
  assert.deepEqual(describeIssue({ message: "Targets sum to 0.950, expected 1 (+-0.001)" }),
    { text: "Targets sum to 0.950, expected 1 (+-0.001)", detail: null, translated: false });
  assert.equal(describeIssue({ code: "strategy.other", params: {}, message: "m" }).text, "m");
  // a known code with incomplete params falls back too
  assert.equal(describeIssue({ code: "strategy.unknown_bucket", params: {}, message: "Unknown bucket" }).text, "Unknown bucket");
});

test("import warnings: label from the kind, English detail kept", () => {
  const w = { kind: "invalid_value", row: 4, blocking: true, message: 'quantity: "abc" is not a number' };
  assert.deepEqual(describeImportWarning(w), {
    text: "Nieprawidłowa wartość", detail: 'quantity: "abc" is not a number', translated: true,
  });
  assert.equal(describeImportWarning({ ...w, code: "import.missing_column" }).text, "Brak kolumny w pliku");
  assert.deepEqual(describeImportWarning({ kind: "other", message: "This file was already imported" }),
    { text: "This file was already imported", detail: null, translated: false });
});

test("proposal summaries and errors", () => {
  assert.equal(proposalSummary({ kind: "strategy", summary: "Strategy: 5 rules, 3 buckets",
    summary_code: "strategy", summary_params: { rules: 5, buckets: 3, inactive_rules: 0 } }),
  "Nowa strategia: 5 reguł, 3 koszyki");
  assert.equal(proposalSummary({ kind: "custom_rule", summary_code: "custom_rule",
    summary_params: { rule_id: "turnover", rule_kind: "custom", episodes: 2, evaluated: 40 } }),
  "Reguła turnover (custom): w teście wstecznym 2 epizody");
  assert.equal(proposalSummary({ kind: "import", summary_code: "import",
    summary_params: { account: "XTB IKE", importer: "finanse", converter: null, new: 12, duplicates: 0 } }),
  "Import do XTB IKE (finanse): 12 nowych wierszy");
  assert.equal(proposalSummary({ kind: "import", summary_code: "import",
    summary_params: { account: "DIF", converter: "dif_csv", new: null } }),
  "Import do DIF (konwerter dif_csv): konwerter czeka na zatwierdzenie");
  // no params (older proposal) -> the English summary; unknown kind -> the English summary
  assert.equal(proposalSummary({ kind: "strategy", summary: "Strategy: 2 rules, 1 buckets" }), "Strategy: 2 rules, 1 buckets");
  assert.equal(proposalSummary({ kind: "mystery", summary: "Something" }), "Something");

  assert.equal(proposalError(null), null);
  assert.equal(proposalError({ version: 3 }), null);
  assert.deepEqual(proposalError({ error: "the change makes rule(s) inactive: a", error_code: "rules_made_inactive" }),
    { text: "Ta zmiana wyłączyłaby inne reguły", detail: "the change makes rule(s) inactive: a", translated: true });
  assert.deepEqual(proposalError({ error: "boom", error_code: "brand_new" }),
    { text: "boom", detail: null, translated: false });
});

test("Polish plurals and no em dash anywhere in the copy", () => {
  assert.equal(plural(1, "reguła", "reguły", "reguł"), "1 reguła");
  assert.equal(plural(3, "reguła", "reguły", "reguł"), "3 reguły");
  assert.equal(plural(12, "reguła", "reguły", "reguł"), "12 reguł");
  assert.equal(plural(22, "reguła", "reguły", "reguł"), "22 reguły");
  for (const [code, l] of Object.entries(LABELS)) {
    const sample = typeof l === "string" ? l : String(l({ what: "Rule", id: "x", first_line: 1, key: "k", value: "v",
      allowed: "a", known: "k", bucket: "b", kind: "k", rules: 2, buckets: 1, rule_id: "r", rule_kind: "custom",
      episodes: 1, account: "A", new: 1, range: "at least 1", suggestion: "s" }));
    assert.ok(!sample.includes("\u2014"), code); // no em dash
  }
});
