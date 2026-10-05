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
  "Nowa reguła własna: w teście wstecznym 2 epizody");
  // F7 D2: never the raw rule id or kind; a built-in kind and an older proposal without params stay Polish
  assert.equal(proposalSummary({ kind: "custom_rule", summary_code: "custom_rule",
    summary_params: { rule_id: "agent_cash_level_1", rule_kind: "cash_level", episodes: 0, evaluated: 40 } }),
  "Nowa reguła: w teście wstecznym 0 epizodów");
  assert.equal(proposalSummary({ kind: "custom_rule", summary: "Rule turnover (custom): fired 2x in backtest" }), "Nowa reguła");
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

test("F7: performance data-quality notes and worker job codes read in Polish; unknown codes keep the English text", async () => {
  const { describePerfNote, describeJob } = await import("../src/core/messages.ts");
  assert.equal(describePerfNote({ code: "incomplete_days", params: { days: 3 }, message: "3 days" }), "niepełna wycena: 3 dni");
  assert.equal(describePerfNote({ code: "benchmark_stale", params: { last_date: "2026-09-30" }, message: "x" }), "benchmark: ceny tylko do 30.09.2026, bez porównania");
  assert.equal(describePerfNote({ code: "benchmark_partial", params: { first_date: "2026-02-01" } }), "benchmark: ceny dopiero od 01.02.2026");
  assert.match(describePerfNote({ code: "implied_funding", params: {} }), /ujemna gotówka/);
  assert.equal(describePerfNote({ code: "something_new", message: "Something new" }), "Something new");
  assert.equal(describeJob({ code: "eb_not_configured", params: {}, detail: "Enable Banking not configured" }), "Enable Banking nie jest skonfigurowany");
  // the raw rule id never reaches the UI (F7 C1)
  assert.equal(describeJob({ code: "rule_inactive", params: { rule: "dca" }, detail: "x" }), "reguła nieaktywna (błąd w strategy.yaml)");
  assert.equal(describeJob({ code: "prices_failed", params: {}, detail: "prices failed" }), "prices failed");
  assert.equal(describeJob({ code: null, detail: "legacy detail" }), "legacy detail");
  assert.equal(describeJob({ code: null, detail: null }), null);
  const prev = process.env.TZ;
  process.env.TZ = "Europe/Warsaw";
  try { assert.equal(describeJob({ code: "throttled", params: { until: "2026-10-05T10:00:00Z" } }), "limit banku do 5.10 12:00"); }
  finally { if (prev === undefined) delete process.env.TZ; else process.env.TZ = prev; }
});

test("F7 R8: relocation has a worker part and an MCP part, each its own line; the pre-R8 flat shape maps onto them", async () => {
  const { relocationParts } = await import("../src/core/messages.ts");
  const none = { worker: null, mcp: null };
  assert.deepEqual(relocationParts(null), none);
  assert.deepEqual(relocationParts({ worker: null, mcp: null }), none);
  const READD = "Dodaj ponownie serwer MCP w Claude Code (polecenie w Agent AI).";
  assert.deepEqual(relocationParts({ worker: { reason: "missing", program: "/gone/finanse", expected_program: null, actions: ["worker_reinstall"] }, mcp: null }),
    { worker: "Praca w tle wskazuje program, którego już nie ma", mcp: null });
  assert.deepEqual(relocationParts({ worker: null, mcp: { reason: "app_moved", app_moved_from: "/Applications/Old.app", moved_at: null, actions: ["mcp_readd"] } }),
    { worker: null, mcp: `Aplikacja została przeniesiona z /Applications/Old.app. ${READD}` });
  assert.deepEqual(relocationParts({ worker: { reason: "other_program", actions: [] }, mcp: { reason: "app_moved", app_moved_from: "/x", actions: [] } }),
    { worker: "Praca w tle wskazuje inną kopię aplikacji", mcp: `Aplikacja została przeniesiona z /x. ${READD}` });
  // pre-R8 server: one flat object
  assert.deepEqual(relocationParts({ worker: "missing", app_moved_from: null, actions: ["worker_reinstall"] }),
    { worker: "Praca w tle wskazuje program, którego już nie ma", mcp: null });
  assert.deepEqual(relocationParts({ worker: null, app_moved_from: "/Applications/Old.app", actions: ["mcp_readd"] }),
    { worker: null, mcp: `Aplikacja została przeniesiona z /Applications/Old.app. ${READD}` });
});

// F7 C2: every strategy issue code the backend can emit, with params as the backend produces them. Codes: the
// `_TEMPLATES` of src/finanse/modules/investments/strategy/codes.py (`strategy.other` left out: it means "no
// template", the English text stays). Params: tests/test_message_codes.py CORPUS plus a few variants run
// through load_strategy (collected 2026-10-05). Keep in sync when codes.py gains a template.
const BACKEND_ISSUES = [
  ["allocation_not_mapping", {}],
  ["base_currency_not_pln", {}],
  ["base_currency_required", {}],
  ["benchmark_id_required", {}],
  ["benchmark_one_currency", {}],
  ["benchmark_proxy_empty", {}],
  ["benchmark_proxy_required", {}],
  ["bucket_catch_all", {"bucket": "all"}],
  ["bucket_id_required", {}],
  ["bucket_not_mapping", {}],
  ["buckets_not_list", {}],
  ["cash_level_needs_bound", {}],
  ["contribution_gap_needs_plan", {}],
  ["criteria_not_mapping", {}],
  ["criterion_unknown", {"key": "max_pee", "suggestion": "max_pe"}],
  ["currency_invalid", {"value": "zloty"}],
  ["custom_bucket_needs_targets", {}],
  ["drift_needs_targets", {}],
  ["empty", {}],
  ["expression_invalid", {"column": "1", "detail": "Unknown name \"bucket\"; see the metric catalog for scope bucket"}],
  ["id_duplicate", {"first_line": "4", "id": "a", "what": "bucket"}],
  ["id_duplicate", {"first_line": "4", "id": "a", "what": "rule"}],
  ["id_invalid", {"id": "bad id", "what": "Benchmark"}],
  ["id_invalid", {"id": "bad id", "what": "Bucket"}],
  ["id_invalid", {"id": "bad id", "what": "Rule"}],
  ["match_required", {}],
  ["md_empty", {}],
  ["message_empty", {}],
  ["message_too_long", {"max": "200"}],
  ["min_below_max", {"key": "min_weight", "other": "max_weight"}],
  ["no_cash_bucket", {}],
  ["not_finite", {"key": "max_stale_weight"}],
  ["not_mapping", {}],
  ["not_mapping_key", {"key": "data"}],
  ["not_number", {"key": "max_pe", "value": "low"}],
  ["not_number", {"key": "monthly_amount", "value": "\"abc\""}],
  ["not_text", {"key": "base_currency", "value": "a list"}],
  ["not_text_list", {"key": "tags", "value": "a mapping"}],
  ["not_whole_number", {"key": "cooldown_days", "value": "1.5"}],
  ["out_of_range", {"fraction_hint": " (fractions: 0.15 = 15%)", "key": "max_stale_weight", "range": "at least 0 and at most 1", "value": "2"}],
  ["out_of_range", {"key": "monthly_amount", "range": "greater than 0", "value": "-5"}],
  ["params_not_mapping", {}],
  ["rebalance_without_drift", {}],
  ["required", {"key": "monthly_amount"}],
  ["rule_id_required", {}],
  ["rule_kind_required", {"known": "allocation_drift, position_concentration, loss_from_cost, gain_from_cost, drawdown_from_high, cash_level, contribution_gap, tagged_weight, custom"}],
  ["rule_kind_unknown", {"kind": "allocation_drif", "known": "allocation_drift, position_concentration, loss_from_cost, gain_from_cost, drawdown_from_high, cash_level, contribution_gap, tagged_weight, custom", "suggestion": "allocation_drift"}],
  ["rule_not_mapping", {}],
  ["rules_not_list", {}],
  ["scope_only", {"key": "tags", "scope": "instrument"}],
  ["tags_required", {}],
  ["target_invalid", {"bucket": "eq", "value": "1.5"}],
  ["target_missing", {"bucket": "cash"}],
  ["target_unknown_bucket", {"bucket": "e", "suggestion": "eq"}],
  ["target_unknown_bucket", {"bucket": "eq"}],
  ["targets_missing", {}],
  ["targets_not_mapping", {}],
  ["targets_required", {}],
  ["targets_sum", {"sum": "0.700"}],
  ["unknown_asset_class", {"allowed": "equity, etf, fund, bond, treasury_bond, cash, crypto, commodity, claim, other", "suggestion": "bond", "value": "bnd"}],
  ["unknown_bucket", {"bucket": "eqq", "suggestion": "eq"}],
  ["unknown_bucket", {"bucket": "eqq"}],
  ["unknown_choice", {"allowed": "info, action", "value": "urgnt", "what": "severity"}],
  ["unknown_choice", {"allowed": "monday, tuesday, wednesday, thursday, friday, saturday, sunday", "suggestion": "sunday", "value": "sundy", "what": "weekday"}],
  ["unknown_key", {"key": "horizon_yaers", "suggestion": "horizon_years"}],
  ["unknown_value", {"allowed": "info, action", "key": "severity", "suggestion": "action", "value": "actoin"}],
  ["version_unsupported", {"supported": "1", "version": "2"}],
  ["watchlist_not_mapping", {}],
  ["when_required", {}],
  ["yaml_alias", {}],
  ["yaml_duplicate_key", {"first_line": "1", "key": "version"}],
  ["yaml_invalid", {"problem": "expected the node content, but found '<stream end>' (while parsing a flow node)"}],
  ["yaml_key_not_text", {}],
  ["yaml_merge_key", {}],
  ["yaml_tag", {"tag": "tag:yaml.org,2002:python/object:os.system"}],
  ["yaml_too_deep", {"max": "32"}],
  ["yaml_too_large", {"chars": "512102", "max": "512000"}],
];
// The English sentences inside params: `detail` of expression_invalid (rules/expr lexer.py / parser.py /
// checker.py through compile_expression) and `problem` of yaml_invalid (PyYAML through yaml_tree.compose),
// as the backend printed them on 2026-10-05.
const EXPR_DETAILS = [
  "'$' is not supported",
  "'%' must directly follow a number (5% = 0.05); the modulo operator is not supported",
  "'+' needs numbers on both sides; the part at column 14 is a condition (true/false)",
  "'-' needs a number; the part at column 15 is a condition (true/false)",
  "':' is not supported",
  "'==' compares values of the same type; asset_class is text, 5 is a number",
  "'==' compares values of the same type; weight is a number, true is a condition (true/false)",
  "'>' compares numbers; \"a\" is text",
  "'>' compares numbers; asset_class is text",
  "'>' compares numbers; true is a condition (true/false)",
  "'?' is not supported",
  "'and' needs conditions on both sides; cash_weight is a number",
  "'not' must be put in parentheses here, e.g. 1 + (not x)",
  "'not' needs a condition; cash_weight is a number",
  "A decimal point must be followed by digits (e.g. 0.5)",
  "A number can have only one decimal point",
  "Attribute access is not supported",
  "Backslash escapes are not supported in text",
  "Backslashes are not supported",
  "Backticks are not supported",
  "Bit operations are not supported",
  "Braces are not supported",
  "Chained comparisons are not supported; combine them with 'and'",
  "Comments are not supported",
  "Expected a value, found ')'",
  "Expression ended unexpectedly; expected a value",
  "Expression has too many parts (max 200 tokens)",
  "Expression is empty",
  "Expression is nested too deeply (max 24 levels)",
  "Expression is too long (1597 characters, max 1000)",
  "Expression is too long (2100 characters, max 1000)",
  "Indexing and lists are not supported",
  "Integer division is not supported; use '/'",
  "Invalid number \"5a...\"",
  "Missing ')' for the '(' at column 1; found the end of the expression",
  "Missing ')' to close bucket_weight( at column 14; found the end of the expression",
  "Missing closing quote \"",
  "Name is too long (max 64 characters)",
  "Names cannot start with \"_\" (got \"_x\")",
  "Number is too long (max 24 characters)",
  "Only one expression is allowed; ';' is not supported",
  "Powers and bit operations are not supported",
  "Powers are not supported",
  "Scientific notation is not supported; write the number out",
  "Text is too long (max 100 characters)",
  "Text must end on the same line (missing closing quote)",
  "The '@' operator is not supported",
  "The expression must be a condition (true or false), e.g. weight > 10%; this one gives a number",
  "The expression uses no metric, so it would always give the same answer",
  "Too many arguments for tagged_weight (max 10)",
  "Unexpected '\"a\"' after a complete expression",
  "Unexpected 'cash_weight' after a complete expression",
  "Unexpected character U+0007 in text",
  "Unexpected character U+00E9",
  "Unexpected character U+2265",
  "Unknown asset_class \"etff\" (did you mean \"etf\"?); known: equity, etf, fund, bond, treasury_bond, cash, crypto, commodity, claim, other",
  "Unknown asset_class \"stock\"; known: equity, etf, fund, bond, treasury_bond, cash, crypto, commodity, claim, other",
  "Unknown name \"cash_wieght\" (did you mean \"cash_weight\"?); see the metric catalog for scope portfolio",
  "Use '!=' to compare for inequality",
  "Use '<=' for 'less than or equal'",
  "Use '==' to compare; assignment is not supported",
  "Use '>=' for 'greater than or equal'",
  "Use 'and' instead of '&&'",
  "Use 'and' instead of '&'",
  "Use 'not' instead of '!'",
  "Use 'or' instead of '|'",
  "Use 'or' instead of '||'",
  "Write \"and\" in lowercase",
  "Write \"true\" in lowercase",
  "asset_class is never \"etff\" (did you mean \"etf\"?); known: equity, etf, fund, bond, treasury_bond, cash, crypto, commodity, claim, other",
  "asset_class is never \"stocks\"; known: equity, etf, fund, bond, treasury_bond, cash, crypto, commodity, claim, other",
  "bucket of bucket_weight must be text in quotes, e.g. bucket_weight(\"x\")",
  "bucket of bucket_weight must not be empty",
  "bucket_weight is a function; call it with arguments: bucket_weight(bucket)",
  "bucket_weight takes 1 argument(s); usage: bucket_weight(bucket)",
  "cash_weight is not a function; write it without parentheses",
  "tagged_weight lists the same value twice",
  "tagged_weight takes at least 1 argument(s); usage: tagged_weight(tag, ...)",
  "weight is not available in scope portfolio (available in: instrument, bucket)",
  "window_days of price_change must be a whole number between 2 and 2520, written as a literal",
  "window_days of price_change must be a whole number, got 2.5",
  "window_days of price_change must be between 2 and 2520, got 1",
];
const YAML_PROBLEMS = [
  "expected the node content, but found '<stream end>' (while parsing a flow node)",
  "mapping values are not allowed here",
  "could not find expected ':' (while scanning a simple key)",
  "found character '\\t' that cannot start any token (while scanning for the next token)",
  "found character '%' that cannot start any token (while scanning for the next token)",
  "expected <block end>, but found '<block mapping start>' (while parsing a block collection)",
  "expected ',' or ']', but got ':' (while parsing a flow sequence)",
  "expected ',' or '}', but got '<stream end>' (while parsing a flow mapping)",
  "found unexpected end of stream (while scanning a quoted scalar)",
  "but found another document (expected a single document in the stream)",
  "found unknown escape character 'q' (while scanning a double-quoted scalar)",
];
// English words as whole words (Unicode-aware: "gotówka" is not "got").
const ENGLISH = /(?<![\p{L}\d_])(must|is|are|the|required|unknown|expected|found|got|supported|cannot|missing|invalid|needs?|takes|write|use)(?![\p{L}\d_])/iu;

test("F7 C2: every backend strategy issue code has a Polish label, filled from the real params", () => {
  const codes = new Set(BACKEND_ISSUES.map(([c]) => `strategy.${c}`));
  assert.equal(codes.size, 69);
  const labelled = new Set(Object.keys(LABELS).filter((k) => k.startsWith("strategy.")));
  assert.deepEqual([...codes].filter((c) => !labelled.has(c)), []); // no backend code without a label
  assert.deepEqual([...labelled].filter((c) => !codes.has(c)), []); // no label for a code the backend dropped
  for (const [c, params] of BACKEND_ISSUES) {
    const d = describeIssue({ code: `strategy.${c}`, params, message: "EN" });
    assert.ok(d.translated && d.text !== "EN", c);
    assert.doesNotMatch(d.text, ENGLISH, c);
  }
});

test("F7 C2: condition errors and YAML problems read in Polish; an unknown sentence is dropped, never English", async () => {
  const { exprDetail, yamlProblem } = await import("../src/core/messages.ts");
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
  const expr = (detail) => describeIssue({ code: "strategy.expression_invalid", params: { column: "14", detail }, message: "m" }).text;
  assert.equal(expr("Expression ended unexpectedly; expected a value"), "Błąd w warunku (kolumna 14): warunek urywa się; brakuje wartości");
  assert.equal(expr('Unknown name "cash_wieght" (did you mean "cash_weight"?); see the metric catalog for scope portfolio'),
    "Błąd w warunku (kolumna 14): nieznana nazwa „cash_wieght\" (czy chodziło o „cash_weight\"?) w scope portfolio");
  assert.equal(expr("'>' compares numbers; the part at column 3 is a condition (true/false)"),
    "Błąd w warunku (kolumna 14): '>' porównuje liczby; część z kolumny 3 jest warunkiem");
  assert.equal(expr("A brand new sentence"), "Błąd w warunku (kolumna 14)");
  const yaml = (problem) => describeIssue({ code: "strategy.yaml_invalid", params: { problem }, message: "m" }).text;
  assert.equal(yaml("found character '\\t' that cannot start any token (while scanning for the next token)"), "Błędny YAML: tabulator zamiast spacji we wcięciu");
  assert.equal(yaml("something PyYAML says"), "Błędny YAML");
  assert.equal(describeIssue({ code: "strategy.not_number", params: { key: "monthly_amount", value: '"abc"' }, message: "m" }).text,
    "monthly_amount musi być liczbą, jest „abc\"");
});
