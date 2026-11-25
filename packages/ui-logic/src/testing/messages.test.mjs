// Polish label map for coded backend messages (src/core/messages.ts), Runs with the ui-logic Vitest suite.
import assert from "node:assert/strict";
import {
  describeImportWarning,
  describeIssue,
  fill,
  LABELS,
  label,
  plural,
  proposalError,
  proposalSummary,
} from "@cashu/ui-logic/core/messages";
import { test } from "vitest";

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
  const typo = {
    code: "strategy.unknown_key",
    params: { key: "horizon_yaers", suggestion: "horizon_years" },
    message: 'Unknown key "horizon_yaers" (did you mean "horizon_years"?); it is ignored',
  };
  assert.deepEqual(describeIssue(typo), {
    text: 'Nieznany klucz „horizon_yaers" (czy chodziło o „horizon_years"?); jest pomijany',
    detail: null,
    translated: true,
  });
  const range = {
    code: "strategy.out_of_range",
    message: "x",
    params: {
      key: "threshold",
      range: "at least 0 and at most 1",
      value: "2",
      fraction_hint: " (fractions: 0.15 = 15%)",
    },
  };
  assert.equal(
    describeIssue(range).text,
    "threshold musi być co najmniej 0 i co najwyżej 1, jest 2 (ułamki: 0.15 = 15%)",
  );
  assert.equal(
    describeIssue({
      code: "strategy.not_text",
      params: { key: "tags", value: "a mapping" },
      message: "m",
    }).text,
    "tags musi być tekstem, jest mapą",
  );
  // an older server (no code) and the catch-all code show the English text
  assert.deepEqual(describeIssue({ message: "Targets sum to 0.950, expected 1 (+-0.001)" }), {
    text: "Targets sum to 0.950, expected 1 (+-0.001)",
    detail: null,
    translated: false,
  });
  assert.equal(describeIssue({ code: "strategy.other", params: {}, message: "m" }).text, "m");
  // a known code with incomplete params falls back too
  assert.equal(
    describeIssue({ code: "strategy.unknown_bucket", params: {}, message: "Unknown bucket" }).text,
    "Unknown bucket",
  );
});

test("import warnings: label from the kind, English detail kept", () => {
  const w = {
    kind: "invalid_value",
    row: 4,
    blocking: true,
    message: 'quantity: "abc" is not a number',
  };
  assert.deepEqual(describeImportWarning(w), {
    text: "Nieprawidłowa wartość",
    detail: 'quantity: "abc" is not a number',
    translated: true,
  });
  assert.equal(
    describeImportWarning({ ...w, code: "import.missing_column" }).text,
    "Brak kolumny w pliku",
  );
  assert.deepEqual(
    describeImportWarning({ kind: "other", message: "This file was already imported" }),
    { text: "This file was already imported", detail: null, translated: false },
  );
});

test("proposal summaries and errors", () => {
  assert.equal(
    proposalSummary({
      kind: "strategy",
      summary: "Strategy: 5 rules, 3 buckets",
      summary_code: "strategy",
      summary_params: { rules: 5, buckets: 3, inactive_rules: 0 },
    }),
    "Nowa strategia: 5 reguł, 3 koszyki",
  );
  assert.equal(
    proposalSummary({
      kind: "custom_rule",
      summary_code: "custom_rule",
      summary_params: { rule_id: "turnover", rule_kind: "custom", episodes: 2, evaluated: 40 },
    }),
    "Nowa reguła własna: w teście wstecznym 2 epizody",
  );
  // F7 D2: never the raw rule id or kind; a built-in kind and an older proposal without params stay Polish
  assert.equal(
    proposalSummary({
      kind: "custom_rule",
      summary_code: "custom_rule",
      summary_params: {
        rule_id: "agent_cash_level_1",
        rule_kind: "cash_level",
        episodes: 0,
        evaluated: 40,
      },
    }),
    "Nowa reguła: w teście wstecznym 0 epizodów",
  );
  assert.equal(
    proposalSummary({
      kind: "custom_rule",
      summary: "Rule turnover (custom): fired 2x in backtest",
    }),
    "Nowa reguła",
  );
  assert.equal(
    proposalSummary({
      kind: "import",
      summary_code: "import",
      summary_params: {
        account: "XTB IKE",
        importer: "cashu",
        converter: null,
        new: 12,
        duplicates: 0,
      },
    }),
    "Import do XTB IKE (cashu): 12 nowych wierszy",
  );
  assert.equal(
    proposalSummary({
      kind: "import",
      summary_code: "import",
      summary_params: { account: "DIF", converter: "dif_csv", new: null },
    }),
    "Import do DIF (konwerter dif_csv): konwerter czeka na zatwierdzenie",
  );
  // no params (older proposal) -> the English summary; unknown kind -> the English summary
  assert.equal(
    proposalSummary({ kind: "strategy", summary: "Strategy: 2 rules, 1 buckets" }),
    "Strategy: 2 rules, 1 buckets",
  );
  assert.equal(proposalSummary({ kind: "mystery", summary: "Something" }), "Something");

  assert.equal(proposalError(null), null);
  assert.equal(proposalError({ version: 3 }), null);
  assert.deepEqual(
    proposalError({
      error: "the change makes rule(s) inactive: a",
      error_code: "rules_made_inactive",
    }),
    {
      text: "Ta zmiana wyłączyłaby inne reguły",
      detail: "the change makes rule(s) inactive: a",
      translated: true,
    },
  );
  assert.deepEqual(proposalError({ error: "boom", error_code: "brand_new" }), {
    text: "boom",
    detail: null,
    translated: false,
  });
});

test("Polish plurals and no em dash anywhere in the copy", () => {
  assert.equal(plural(1, "reguła", "reguły", "reguł"), "1 reguła");
  assert.equal(plural(3, "reguła", "reguły", "reguł"), "3 reguły");
  assert.equal(plural(12, "reguła", "reguły", "reguł"), "12 reguł");
  assert.equal(plural(22, "reguła", "reguły", "reguł"), "22 reguły");
  for (const [code, l] of Object.entries(LABELS)) {
    const sample =
      typeof l === "string"
        ? l
        : String(
            l({
              what: "Rule",
              id: "x",
              first_line: 1,
              key: "k",
              value: "v",
              allowed: "a",
              known: "k",
              bucket: "b",
              kind: "k",
              rules: 2,
              buckets: 1,
              rule_id: "r",
              rule_kind: "custom",
              episodes: 1,
              account: "A",
              new: 1,
              range: "at least 1",
              suggestion: "s",
            }),
          );
    assert.ok(!sample.includes("\u2014"), code); // no em dash
  }
});

test("F7: performance data-quality notes read in Polish; unknown codes keep the English text", async () => {
  const { describePerfNote } = await import("@cashu/ui-logic/core/messages");
  assert.equal(
    describePerfNote({ code: "incomplete_days", params: { days: 3 }, message: "3 days" }),
    "niepełna wycena: 3 dni",
  );
  assert.equal(
    describePerfNote({
      code: "benchmark_stale",
      params: { last_date: "2026-09-30" },
      message: "x",
    }),
    "benchmark: ceny tylko do 30.09.2026, bez porównania",
  );
  assert.equal(
    describePerfNote({ code: "benchmark_partial", params: { first_date: "2026-02-01" } }),
    "benchmark: ceny dopiero od 01.02.2026",
  );
  assert.match(describePerfNote({ code: "implied_funding", params: {} }), /ujemna gotówka/);
  assert.equal(
    describePerfNote({ code: "something_new", message: "Something new" }),
    "Something new",
  );
});

// F7 C2: every strategy issue code the strategy checker can emit, with params as it fills them. Codes: the
// `TEMPLATES` of packages/domain/src/investments/strategy/codes.ts (`strategy.other` left out: it means "no
// template", the English text stays). Keep in sync when codes.ts gains a template.
const BACKEND_ISSUES = [
  ["allocation_not_mapping", {}],
  ["base_currency_not_pln", {}],
  ["base_currency_required", {}],
  ["benchmark_id_required", {}],
  ["benchmark_one_currency", {}],
  ["benchmark_proxy_empty", {}],
  ["benchmark_proxy_required", {}],
  ["bucket_catch_all", { bucket: "all" }],
  ["bucket_id_required", {}],
  ["bucket_not_mapping", {}],
  ["buckets_not_list", {}],
  ["cash_level_needs_bound", {}],
  ["contribution_gap_needs_plan", {}],
  ["criteria_not_mapping", {}],
  ["criterion_unknown", { key: "max_pee", suggestion: "max_pe" }],
  ["currency_invalid", { value: "zloty" }],
  ["custom_bucket_needs_targets", {}],
  ["drift_needs_targets", {}],
  ["empty", {}],
  [
    "expression_invalid",
    { column: "1", detail: 'Unknown name "bucket"; see the metric catalog for scope bucket' },
  ],
  ["id_duplicate", { first_line: "4", id: "a", what: "bucket" }],
  ["id_duplicate", { first_line: "4", id: "a", what: "rule" }],
  ["id_invalid", { id: "bad id", what: "Benchmark" }],
  ["id_invalid", { id: "bad id", what: "Bucket" }],
  ["id_invalid", { id: "bad id", what: "Rule" }],
  ["match_required", {}],
  ["md_empty", {}],
  ["message_empty", {}],
  ["message_too_long", { max: "200" }],
  ["min_below_max", { key: "min_weight", other: "max_weight" }],
  ["no_cash_bucket", {}],
  ["not_finite", { key: "max_stale_weight" }],
  ["not_mapping", {}],
  ["not_mapping_key", { key: "data" }],
  ["not_number", { key: "max_pe", value: "low" }],
  ["not_number", { key: "monthly_amount", value: '"abc"' }],
  ["not_text", { key: "base_currency", value: "a list" }],
  ["not_text_list", { key: "tags", value: "a mapping" }],
  ["not_whole_number", { key: "cooldown_days", value: "1.5" }],
  [
    "out_of_range",
    {
      fraction_hint: " (fractions: 0.15 = 15%)",
      key: "max_stale_weight",
      range: "at least 0 and at most 1",
      value: "2",
    },
  ],
  ["out_of_range", { key: "monthly_amount", range: "greater than 0", value: "-5" }],
  ["params_not_mapping", {}],
  ["rebalance_without_drift", {}],
  ["required", { key: "monthly_amount" }],
  ["rule_id_required", {}],
  [
    "rule_kind_required",
    {
      known:
        "allocation_drift, position_concentration, loss_from_cost, gain_from_cost, drawdown_from_high, cash_level, contribution_gap, tagged_weight, custom",
    },
  ],
  [
    "rule_kind_unknown",
    {
      kind: "allocation_drif",
      known:
        "allocation_drift, position_concentration, loss_from_cost, gain_from_cost, drawdown_from_high, cash_level, contribution_gap, tagged_weight, custom",
      suggestion: "allocation_drift",
    },
  ],
  ["rule_not_mapping", {}],
  ["rules_not_list", {}],
  ["scope_only", { key: "tags", scope: "instrument" }],
  ["tags_required", {}],
  ["target_invalid", { bucket: "eq", value: "1.5" }],
  ["target_missing", { bucket: "cash" }],
  ["target_unknown_bucket", { bucket: "e", suggestion: "eq" }],
  ["target_unknown_bucket", { bucket: "eq" }],
  ["targets_missing", {}],
  ["targets_not_mapping", {}],
  ["targets_required", {}],
  ["targets_sum", { sum: "0.700" }],
  [
    "unknown_asset_class",
    {
      allowed: "equity, etf, fund, bond, treasury_bond, cash, crypto, commodity, claim, other",
      suggestion: "bond",
      value: "bnd",
    },
  ],
  ["unknown_bucket", { bucket: "eqq", suggestion: "eq" }],
  ["unknown_bucket", { bucket: "eqq" }],
  ["unknown_choice", { allowed: "info, action", value: "urgnt", what: "severity" }],
  [
    "unknown_choice",
    {
      allowed: "monday, tuesday, wednesday, thursday, friday, saturday, sunday",
      suggestion: "sunday",
      value: "sundy",
      what: "weekday",
    },
  ],
  ["unknown_key", { key: "horizon_yaers", suggestion: "horizon_years" }],
  [
    "unknown_value",
    { allowed: "info, action", key: "severity", suggestion: "action", value: "actoin" },
  ],
  ["version_unsupported", { supported: "1", version: "2" }],
  ["watchlist_not_mapping", {}],
  ["when_required", {}],
  ["yaml_alias", {}],
  ["yaml_duplicate_key", { first_line: "1", key: "version" }],
  [
    "yaml_invalid",
    { problem: "expected the node content, but found '<stream end>' (while parsing a flow node)" },
  ],
  ["yaml_key_not_text", {}],
  ["yaml_merge_key", {}],
  ["yaml_tag", { tag: "tag:yaml.org,2002:python/object:os.system" }],
  ["yaml_too_deep", { max: "32" }],
  ["yaml_too_large", { chars: "512102", max: "512000" }],
];
// A few English sentences inside params, as the strategy checker prints them: `detail` of expression_invalid
// and `problem` of yaml_invalid (the PyYAML port's error texts). One per kind of translation rule.
const EXPR_DETAILS = [
  "'>' compares numbers; asset_class is text",
  "Expression is too long (1597 characters, max 1000)",
  'Unknown name "cash_wieght" (did you mean "cash_weight"?); see the metric catalog for scope portfolio',
  "Use 'and' instead of '&&'",
  "bucket_weight takes 1 argument(s); usage: bucket_weight(bucket)",
  "window_days of price_change must be between 2 and 2520, got 1",
];
const YAML_PROBLEMS = [
  "mapping values are not allowed here",
  "found character '\\t' that cannot start any token (while scanning for the next token)",
  "found unknown escape character 'q' (while scanning a double-quoted scalar)",
];
// English words as whole words (Unicode-aware: "gotówka" is not "got").
const ENGLISH =
  /(?<![\p{L}\d_])(must|is|are|the|required|unknown|expected|found|got|supported|cannot|missing|invalid|needs?|takes|write|use)(?![\p{L}\d_])/iu;

test("F7 C2: every backend strategy issue code has a Polish label, filled from the real params", () => {
  const codes = new Set(BACKEND_ISSUES.map(([c]) => `strategy.${c}`));
  assert.equal(codes.size, 69);
  const labelled = new Set(Object.keys(LABELS).filter((k) => k.startsWith("strategy.")));
  assert.deepEqual(
    [...codes].filter((c) => !labelled.has(c)),
    [],
  ); // no backend code without a label
  assert.deepEqual(
    [...labelled].filter((c) => !codes.has(c)),
    [],
  ); // no label for a code the backend dropped
  for (const [c, params] of BACKEND_ISSUES) {
    const d = describeIssue({ code: `strategy.${c}`, params, message: "EN" });
    assert.ok(d.translated && d.text !== "EN", c);
    assert.doesNotMatch(d.text, ENGLISH, c);
  }
});

test("F7 C2: condition errors and YAML problems read in Polish; an unknown sentence is dropped, never English", async () => {
  const { exprDetail, yamlProblem } = await import("@cashu/ui-logic/core/messages");
  for (const s of EXPR_DETAILS) {
    const pl = exprDetail(s);
    assert.ok(pl, s);
    assert.doesNotMatch(pl, ENGLISH, s);
  }
  for (const s of YAML_PROBLEMS) {
    const pl = yamlProblem(s);
    assert.ok(pl, s);
    assert.doesNotMatch(pl, ENGLISH, s);
  }
  const expr = (detail) =>
    describeIssue({
      code: "strategy.expression_invalid",
      params: { column: "14", detail },
      message: "m",
    }).text;
  assert.equal(
    expr("Expression ended unexpectedly; expected a value"),
    "Błąd w warunku (kolumna 14): warunek urywa się; brakuje wartości",
  );
  assert.equal(
    expr(
      'Unknown name "cash_wieght" (did you mean "cash_weight"?); see the metric catalog for scope portfolio',
    ),
    'Błąd w warunku (kolumna 14): nieznana nazwa „cash_wieght" (czy chodziło o „cash_weight"?) w scope portfolio',
  );
  assert.equal(
    expr("'>' compares numbers; the part at column 3 is a condition (true/false)"),
    "Błąd w warunku (kolumna 14): '>' porównuje liczby; część z kolumny 3 jest warunkiem",
  );
  assert.equal(expr("A brand new sentence"), "Błąd w warunku (kolumna 14)");
  const yaml = (problem) =>
    describeIssue({ code: "strategy.yaml_invalid", params: { problem }, message: "m" }).text;
  assert.equal(
    yaml("found character '\\t' that cannot start any token (while scanning for the next token)"),
    "Błędny YAML: tabulator zamiast spacji we wcięciu",
  );
  assert.equal(yaml("something PyYAML says"), "Błędny YAML");
  assert.equal(
    describeIssue({
      code: "strategy.not_number",
      params: { key: "monthly_amount", value: '"abc"' },
      message: "m",
    }).text,
    'monthly_amount musi być liczbą, jest „abc"',
  );
});

test("alert labels of the F8 kinds (F8 review FE-5)", () => {
  const sp = (v) => v.replace(/[\s  ]+/g, " ");
  assert.equal(
    sp(
      label("alert.range_breakout", {
        window_days: 30,
        breakout_pct: 0.062,
        range_low: "10.50",
        range_high: "11.20",
        currency: "USD",
      }),
    ),
    "wybicie z konsolidacji 30 sesji +6,2 % nad 11,20 $",
  );
  assert.equal(
    sp(
      label("alert.range_breakout", {
        window_days: 30,
        breakout_pct: -0.0001,
        range_low: "10.50",
        range_high: "11.20",
        currency: "USD",
      }),
    ),
    "wybicie z konsolidacji 30 sesji tuż pod 10,50 $",
  );
  assert.equal(
    sp(label("alert.volume_spike", { ratio: 3.42, window_days: 20 })),
    "wolumen 3,4x średniej z 20 sesji",
  );
  assert.equal(label("alert.volume_spike", { window_days: 20 }), null);
});

test("English UI: every helper shows the server's English text; frontend-only texts are English", async () => {
  const { setLanguageForTests } = await import("@cashu/i18n");
  const { describeError, describePerfNote, errorText, exprDetail, yamlProblem } = await import(
    "@cashu/ui-logic/core/messages"
  );
  setLanguageForTests("en");
  try {
    assert.equal(label("strategy.required", { key: "base_currency" }), null);
    assert.deepEqual(
      describeIssue({
        code: "strategy.required",
        params: { key: "version" },
        message: "version is required",
      }),
      { text: "version is required", detail: null, translated: false },
    );
    assert.deepEqual(describeImportWarning({ kind: "fx_missing", message: "Row 3: no fx_rate" }), {
      text: "Row 3: no fx_rate",
      detail: null,
      translated: false,
    });
    assert.equal(
      proposalSummary({
        kind: "strategy",
        summary: "New strategy: 2 rules",
        summary_params: { rules: 2, buckets: 1 },
      }),
      "New strategy: 2 rules",
    );
    assert.equal(
      proposalError({ error: "proposal is not pending", error_code: "not_pending" }).text,
      "proposal is not pending",
    );
    const err = Object.assign(new Error("loan name already exists"), {
      status: 409,
      code: "loan_name_taken",
    });
    assert.equal(
      errorText(Object.assign(new Error("not found"), { status: 404, code: "not_found" })),
      "not found",
    );
    assert.equal(
      describePerfNote({
        code: "incomplete_days",
        params: { days: 3 },
        message: "3 days with incomplete prices",
      }),
      "3 days with incomplete prices",
    );
    assert.equal(exprDetail("Expression is empty"), "Expression is empty");
    assert.equal(
      yamlProblem("mapping values are not allowed here"),
      "mapping values are not allowed here",
    );
    // texts with no server English of their own
    assert.equal(
      errorText(new TypeError("Failed to fetch")),
      "Can't reach the app (the cashU server is not responding)",
    );
    assert.equal(describeError(err).text, "A loan with this name already exists.");
    for (const v of Object.values(
      (await import("@cashu/ui-logic/core/messages.strings")).EN_LABELS,
    )) {
      const t = typeof v === "string" ? v : v({ timeout_s: 1 });
      assert.ok(!/[ąćęłńóśźż\u2014]/i.test(t), t);
    }
  } finally {
    setLanguageForTests("pl");
  }
});
