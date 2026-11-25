// Port of the strategy parts of tests/test_message_codes.py: every strategy issue carries a stable
// code and its params, each message comes from the real loader (a reworded message that no longer
// matches its template fails here instead of silently losing its code).

import { describe, expect, it } from "vitest";
import {
  CODES,
  classify,
  issueRecord,
  loadStrategy,
  OTHER,
  type StrategyIssue,
  strategyIssue,
} from "./index.js";

const H = "version: 1\nbase_currency: PLN\n";
const B2 = `${H}buckets:\n  - { id: eq, match: { asset_class: etf } }\n  - { id: cash, match: { asset_class: cash } }\n`;
const T2 = `${B2}allocation:\n  targets: { eq: 0.8, cash: 0.2 }\n`;

/** `CORPUS`: (expected code, strategy.yaml, strategy.md). */
const CORPUS: readonly (readonly [string, string, string | null])[] = [
  ["yaml_too_large", `# ${"x".repeat(512_100)}`, null],
  ["yaml_duplicate_key", "version: 1\nversion: 1\n", null],
  ["yaml_too_deep", `a: ${"[".repeat(40)}${"]".repeat(40)}\n`, null],
  ["yaml_invalid", "rules: [\n", null],
  ["yaml_alias", "a: &x 1\nb: *x\n", null],
  ["yaml_merge_key", "base: { a: 1 }\nother:\n  <<: { a: 2 }\n", null],
  ["yaml_tag", "a: !!python/object:os.system x\n", null],
  ["yaml_key_not_text", "? [a]\n: 1\n", null],
  ["empty", "", null],
  ["not_mapping", "- a\n- b\n", null],
  ["md_empty", H, "   "],
  ["version_unsupported", "version: 2\nbase_currency: PLN\n", null],
  ["base_currency_required", "version: 1\n", null],
  ["currency_invalid", "version: 1\nbase_currency: zloty\n", null],
  ["base_currency_not_pln", "version: 1\nbase_currency: EUR\n", null],
  ["buckets_not_list", `${H}buckets: 5\n`, null],
  ["bucket_not_mapping", `${H}buckets:\n  - 5\n`, null],
  ["bucket_id_required", `${H}buckets:\n  - { match: {} }\n`, null],
  ["id_invalid", `${H}buckets:\n  - { id: bad id, match: {} }\n`, null],
  ["id_duplicate", `${H}buckets:\n  - { id: a, match: {} }\n  - { id: a, match: {} }\n`, null],
  ["match_required", `${H}buckets:\n  - { id: a }\n`, null],
  [
    "bucket_catch_all",
    `${H}buckets:\n  - { id: all, match: {} }\n  - { id: c, match: { asset_class: cash } }\n`,
    null,
  ],
  [
    "no_cash_bucket",
    `${H}buckets:\n  - { id: eq, match: { asset_class: etf } }\nallocation:\n  targets: { eq: 1 }\n`,
    null,
  ],
  ["targets_missing", B2, null],
  ["allocation_not_mapping", `${B2}allocation: 5\n`, null],
  ["targets_required", `${B2}allocation: {}\n`, null],
  ["targets_not_mapping", `${B2}allocation:\n  targets: 5\n`, null],
  ["target_unknown_bucket", `${B2}allocation:\n  targets: { e: 0.8, cash: 0.2 }\n`, null],
  ["target_invalid", `${B2}allocation:\n  targets: { eq: 1.5, cash: 0.2 }\n`, null],
  ["targets_sum", `${B2}allocation:\n  targets: { eq: 0.5, cash: 0.2 }\n`, null],
  ["target_missing", `${B2}allocation:\n  targets: { eq: 1 }\n`, null],
  ["rules_not_list", `${H}rules: 5\n`, null],
  ["rule_not_mapping", `${H}rules:\n  - 5\n`, null],
  ["rule_id_required", `${H}rules:\n  - { kind: cash_level, params: { max_weight: 0.2 } }\n`, null],
  ["rule_kind_required", `${H}rules:\n  - { id: r }\n`, null],
  ["rule_kind_unknown", `${H}rules:\n  - { id: r, kind: cash_levl }\n`, null],
  ["params_not_mapping", `${H}rules:\n  - { id: r, kind: cash_level, params: 5 }\n`, null],
  [
    "rebalance_without_drift",
    `${B2}allocation:\n  targets: { eq: 0.8, cash: 0.2 }\n  rebalance: { absolute_band_pp: 5 }\n`,
    null,
  ],
  ["drift_needs_targets", `${H}rules:\n  - { id: d, kind: allocation_drift }\n`, null],
  [
    "custom_bucket_needs_targets",
    `${H}rules:\n  - { id: s, kind: custom, params: { scope: bucket, when: drift_pp > 5 } }\n`,
    null,
  ],
  [
    "unknown_bucket",
    `${T2}rules:\n  - { id: d, kind: allocation_drift, params: { buckets: [eqq] } }\n`,
    null,
  ],
  ["contribution_gap_needs_plan", `${H}rules:\n  - { id: g, kind: contribution_gap }\n`, null],
  ["when_required", `${H}rules:\n  - { id: c, kind: custom }\n`, null],
  [
    "expression_invalid",
    `${H}rules:\n  - { id: c, kind: custom, params: { when: cash_weight > } }\n`,
    null,
  ],
  [
    "message_empty",
    `${H}rules:\n  - { id: c, kind: custom, params: { when: cash_weight > 1%, message: ' ' } }\n`,
    null,
  ],
  [
    "message_too_long",
    `${H}rules:\n  - { id: c, kind: custom, params: { when: cash_weight > 1%, message: ${"x".repeat(300)} } }\n`,
    null,
  ],
  [
    "scope_only",
    `${H}rules:\n  - { id: c, kind: custom, params: { when: cash_weight > 1%, tags: [a] } }\n`,
    null,
  ],
  [
    "tags_required",
    `${H}rules:\n  - { id: t, kind: tagged_weight, params: { max_weight: 0.2 } }\n`,
    null,
  ],
  ["cash_level_needs_bound", `${H}rules:\n  - { id: c, kind: cash_level, params: {} }\n`, null],
  [
    "min_below_max",
    `${H}rules:\n  - { id: c, kind: cash_level, params: { min_weight: 0.5, max_weight: 0.2 } }\n`,
    null,
  ],
  ["benchmark_id_required", `${H}benchmark:\n  proxy: VWCE.DE\n`, null],
  ["benchmark_proxy_required", `${H}benchmark:\n  id: acwi\n`, null],
  ["benchmark_proxy_empty", `${H}benchmark:\n  id: acwi\n  proxy: ' '\n`, null],
  [
    "benchmark_one_currency",
    `${H}benchmark:\n  id: acwi\n  proxy: VWCE.DE\n  currency: [EUR, USD]\n`,
    null,
  ],
  ["unknown_choice", `${H}notifications:\n  digest_weekday: sundy\n`, null],
  ["watchlist_not_mapping", `${H}watchlist: 5\n`, null],
  ["criteria_not_mapping", `${H}watchlist:\n  criteria: 5\n`, null],
  ["criterion_unknown", `${H}watchlist:\n  criteria:\n    max_pee: 5\n`, null],
  ["unknown_key", `${H}horizon_yaers: 5\n`, null],
  ["unknown_asset_class", `${H}buckets:\n  - { id: b, match: { asset_class: bnd } }\n`, null],
  [
    "unknown_value",
    `${H}rules:\n  - { id: c, kind: cash_level, severity: urgent, params: { max_weight: 0.2 } }\n`,
    null,
  ],
  ["required", `${H}contributions:\n  day_of_month: 5\n`, null],
  ["not_number", `${H}watchlist:\n  criteria:\n    max_pe: low\n`, null],
  ["not_whole_number", `${H}horizon_years: 1.5\n`, null],
  ["not_finite", `${H}data:\n  max_stale_weight: .nan\n`, null],
  ["not_text_list", `${H}buckets:\n  - { id: b, match: { tags: { a: 1 } } }\n`, null],
  ["not_text", "version: 1\nbase_currency: [PLN]\n", null],
  ["not_mapping_key", `${H}data: 5\n`, null],
  ["out_of_range", `${H}data:\n  max_stale_weight: 2\n`, null],
];

/** `_issues`: every issue of the load plus the issues of the inactive rules. */
function issuesOf(yamlText: string, md: string | null): StrategyIssue[] {
  const result = loadStrategy(yamlText, md);
  const out = [...result.issues];
  for (const rule of result.inactiveRules) out.push(...rule.issues);
  return out;
}

/** The fields of a `StrategyIssue` that take part in Python's dataclass equality (not code / params). */
function compared(issue: StrategyIssue) {
  const { severity, path, message, line, column } = issue;
  return { severity, path, message, line, column };
}

describe("strategy message codes", () => {
  it.each(CORPUS)("test_loader_messages_carry_their_code[%s]", (code, yamlText, md) => {
    const issues = issuesOf(yamlText, md);
    const codes = new Set(issues.map((i) => i.code));
    expect(
      codes.has(`strategy.${code}`),
      JSON.stringify(issues.map((i) => [i.code, i.message])),
    ).toBe(true);
    expect(
      codes.has(OTHER),
      JSON.stringify(issues.filter((i) => i.code === OTHER).map((i) => i.message)),
    ).toBe(false);
  });

  it("test_every_code_is_pinned_by_the_corpus", () => {
    const pinned = new Set(CORPUS.map(([code]) => `strategy.${code}`));
    expect(new Set(CODES.filter((code) => code !== OTHER))).toEqual(pinned);
  });

  it("test_params_hold_the_variable_parts", () => {
    const issues = issuesOf(
      `${T2}rules:\n  - { id: d, kind: allocation_drift, params: { buckets: [eqq] } }\n`,
      null,
    );
    const bucket = issues.find((i) => i.code === "strategy.unknown_bucket");
    expect(bucket?.params).toEqual({ bucket: "eqq", suggestion: "eq" });
    const range = issuesOf(`${H}data:\n  max_stale_weight: 2\n`, null)[0];
    expect(range?.params).toEqual({
      key: "max_stale_weight",
      range: "at least 0 and at most 1",
      value: "2",
      fraction_hint: " (fractions: 0.15 = 15%)",
    });
  });

  it("test_issue_code_is_derived_unless_given_and_stays_out_of_equality", () => {
    const derived = strategyIssue("error", "version", "version is required", 1, 1);
    expect([derived.code, derived.params]).toEqual(["strategy.required", { key: "version" }]);
    const given = strategyIssue("error", "", "anything", null, null, {
      code: "strategy.custom",
      params: { a: "1" },
    });
    expect([given.code, given.params]).toEqual(["strategy.custom", { a: "1" }]);
    const unknown = strategyIssue("warning", "", "a brand new sentence");
    expect([unknown.code, unknown.params]).toEqual([OTHER, {}]);
    // Python: equal despite a different code / params (they are compare=False); `hash(derived)` has no
    // TypeScript twin
    const other = strategyIssue("error", "version", "version is required", 1, 1, {
      code: "x",
      params: { other: "y" },
    });
    expect(compared(derived)).toEqual(compared(other));
    expect(classify("")).toEqual([OTHER, {}]);
  });

  it("test_issue_dict_and_the_strategy_endpoint_carry_codes (issue_dict half)", () => {
    const first = issuesOf(`${H}horizon_yaers: 5\n`, null)[0];
    expect(first).toBeDefined();
    if (first === undefined) return;
    const d = issueRecord(first);
    expect(d.code).toBe("strategy.unknown_key");
    expect(d.params).toEqual({ key: "horizon_yaers", suggestion: "horizon_years" });
    for (const key of ["severity", "path", "message", "line", "column"])
      expect(d).toHaveProperty(key);
  });

  it.todo(
    "test_issue_dict_and_the_strategy_endpoint_carry_codes - the strategy endpoint (S38c / S22)",
  );
  it.todo(
    "test_frontend_labels_cover_every_backend_code - the label map lives in ui-logic (messages.ts), not domain",
  );
});
