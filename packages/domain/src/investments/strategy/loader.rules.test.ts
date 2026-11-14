// Port of tests/investments/strategy/test_strategy_loader.py, classes TestRules and TestCustomRules.

import { describe, expect, it } from "vitest";
import { type CustomParams, expr } from "../rules/index.js";
import { isError, isValid } from "./index.js";
import { configOf, issueAt, load, MINIMAL } from "./testing/load.js";

describe("TestRules", () => {
  const withRules = (rules: string): string => MINIMAL + rules;

  it("test_ids_unique_well_formed_id_and_kind_required", () => {
    const result = load(
      withRules(`rules:
  - { id: loss, kind: loss_from_cost, params: { threshold: 0.2 } }
  - { id: loss, kind: loss_from_cost, params: { threshold: 0.3 } }
  - { id: "a|b", kind: cash_level, params: { max_weight: 0.1 } }
  - { kind: cash_level, params: { max_weight: 0.1 } }
  - { id: no_kind }
  - 42
`),
    );
    expect(issueAt(result, "rules[1].id").message).toBe(
      'Duplicate rule id "loss" (first defined on line 4)',
    );
    expect(issueAt(result, "rules[2].id").message).toContain("may only contain");
    expect(issueAt(result, "rules[3].id").message).toBe("Rule id is required");
    expect(
      issueAt(result, "rules[4].kind").message.startsWith(
        "Rule kind is required; known: allocation_drift,",
      ),
    ).toBe(true);
    expect(issueAt(result, "rules[5]").message).toContain("must be a mapping");
    expect(result.config).toBeNull();
  });

  it("test_unknown_kind_is_an_error_with_the_closest_known_kind", () => {
    const issue = issueAt(
      load(withRules("rules:\n  - { id: x, kind: loss_from_costs }\n")),
      "rules[0].kind",
    );
    expect(
      issue.message.startsWith(
        'Unknown rule kind "loss_from_costs" (did you mean "loss_from_cost"?)',
      ),
    ).toBe(true);
    expect(issue.message.endsWith("tagged_weight, custom")).toBe(true);
    expect([issue.line, issue.column]).toEqual([4, 20]);
  });

  it("test_params_are_validated_by_the_kind_and_located_at_the_value", () => {
    const result = load(
      withRules(`rules:
  - id: dip
    kind: drawdown_from_high
    params:
      threshold: 15
      window_days: soon
  - id: conc
    kind: position_concentration
`),
    );
    const threshold = issueAt(result, "rules[0].params.threshold");
    expect(threshold.message).toBe(
      "threshold must be greater than 0 and less than 1, got 15 (fractions: 0.15 = 15%)",
    );
    expect([threshold.line, threshold.column]).toEqual([7, 18]);
    expect(issueAt(result, "rules[0].params.window_days").message).toContain(
      'whole number, got "soon"',
    );
    const missing = issueAt(result, "rules[1].params.max_weight");
    expect(missing.message).toBe("max_weight is required");
    expect([missing.line, missing.column], "falls back to the rule when params are absent").toEqual(
      [9, 5],
    );
  });

  it("test_filters_are_validated", () => {
    const result = load(
      withRules(
        "rules:\n  - { id: l, kind: loss_from_cost, params: { threshold: 0.2, tags: [[x]], asset_class: stocks } }\n",
      ),
    );
    expect(issueAt(result, "rules[0].params.tags[0]").message).toContain("got a list");
    expect(issueAt(result, "rules[0].params.asset_class").message).toContain("Unknown asset class");
  });

  it("test_severity_cooldown_and_params_shape", () => {
    const result = load(
      withRules(`rules:
  - { id: a, kind: cash_level, params: { max_weight: 0.1 }, severity: urgent }
  - { id: b, kind: cash_level, params: { max_weight: 0.1 }, cooldown_days: -1 }
  - { id: c, kind: cash_level, params: [max_weight] }
`),
    );
    expect(issueAt(result, "rules[0].severity").message).toContain("allowed: info, action");
    expect(issueAt(result, "rules[1].cooldown_days").message).toContain("at least 0");
    expect(issueAt(result, "rules[2].params").message).toBe("params must be a mapping");
  });

  it("test_allocation_drift_needs_targets_and_known_buckets", () => {
    expect(
      issueAt(load(withRules("rules:\n  - { id: d, kind: allocation_drift }\n")), "rules[0]")
        .message,
    ).toBe("allocation_drift needs buckets and allocation.targets");
    const result = load(`version: 1
base_currency: PLN
buckets:
  - { id: stocks, match: { asset_class: equity } }
  - { id: cash, match: { asset_class: cash } }
allocation: { targets: { stocks: 0.9, cash: 0.1 } }
rules:
  - { id: d, kind: allocation_drift, params: { buckets: [stocks, cahs] } }
`);
    expect(issueAt(result, "rules[0].params.buckets").message).toBe(
      'Unknown bucket "cahs" (did you mean "cash"?)',
    );
  });

  it("test_rebalance_without_drift_rule_and_contribution_gap_without_plan_are_warnings", () => {
    const result = load(`version: 1
base_currency: PLN
buckets:
  - { id: all, match: {} }
allocation:
  targets: { all: 1 }
  rebalance: { absolute_band_pp: 5 }
rules:
  - { id: deposits, kind: contribution_gap }
`);
    expect(isValid(result)).toBe(true);
    expect(issueAt(result, "allocation.rebalance").message).toContain(
      "only checked by an allocation_drift rule",
    );
    expect(issueAt(result, "rules[0]").message).toContain(
      "contribution_gap needs a contributions: plan",
    );
  });

  it("test_rules_must_be_a_list", () => {
    expect(isError(issueAt(load(withRules("rules: { a: 1 }\n")), "rules"))).toBe(true);
  });

  it("test_tagged_weight_params", () => {
    const result = load(
      withRules("rules:\n  - { id: t, kind: tagged_weight, params: { max_weight: 0.3 } }\n"),
    );
    expect(issueAt(result, "rules[0].params.tags").message).toBe(
      "tags is required (one tag or a list of tags)",
    );
  });
});

describe("TestCustomRules", () => {
  const withRules = (rules: string): string =>
    `${MINIMAL}buckets:\n  - { id: bonds, match: { asset_class: bond } }\n  - { id: cash, match: { asset_class: cash } }\nallocation: { targets: { bonds: 0.9, cash: 0.1 } }\n${rules}`;

  it("test_expression_errors_point_at_the_exact_yaml_column", () => {
    const rules =
      'rules:\n  - { id: c, kind: custom, params: { scope: instrument, when: "weight >> 1" } }';
    const result = load(`${MINIMAL}${rules}\n`);
    const issue = issueAt(result, "rules[0].params.when");
    expect(issue.message).toBe("Expected a value, found '>' (column 9 of the expression)");
    const line = rules.split("\n")[1] ?? "";
    expect([issue.line, issue.column]).toEqual([4, line.indexOf("weight") + 1 + 8]);
  });

  it("test_plain_and_block_scalars", () => {
    const plain = load(
      `${MINIMAL}rules:\n  - id: c\n    kind: custom\n    params:\n      when: cash_weight >> 1\n`,
    );
    const issue = issueAt(plain, "rules[0].params.when");
    expect([issue.line, issue.column]).toEqual([7, 13 + 13]);
    const block = load(
      `${MINIMAL}rules:\n  - id: c\n    kind: custom\n    params:\n      when: >\n        cash_weight >> 1\n`,
    );
    const blockIssue = issueAt(block, "rules[0].params.when");
    expect(blockIssue.line, "block scalars fall back to the value's start").toBe(7);
    expect(blockIssue.message).toContain("(column 14 of the expression)");
  });

  it("test_unknown_names_scope_errors_and_hints", () => {
    const result = load(
      `${MINIMAL}rules:\n  - { id: a, kind: custom, params: { when: "wieght > 1", scope: instrument } }\n` +
        '  - { id: b, kind: custom, params: { when: "weight > 1" } }\n' +
        '  - { id: c, kind: custom, params: { when: "cash_weight > 1", scope: instrumnet } }\n',
    );
    expect(
      issueAt(result, "rules[0].params.when").message.startsWith(
        'Unknown name "wieght" (did you mean "weight"?)',
      ),
    ).toBe(true);
    expect(issueAt(result, "rules[1].params.when").message).toContain(
      "not available in scope portfolio",
    );
    expect(issueAt(result, "rules[2].params.scope").message).toContain('did you mean "instrument"');
  });

  it("test_bucket_references_are_cross_checked", () => {
    const result = load(
      withRules(
        'rules:\n  - id: b\n    kind: custom\n    params:\n      when: bucket_weight("bnds") > 50%\n' +
          "  - { id: s, kind: custom, params: { scope: bucket, buckets: [csh], when: drift_pp > 5 } }\n",
      ),
    );
    const when = issueAt(result, "rules[0].params.when");
    expect(when.message).toBe(
      'Unknown bucket "bnds" (did you mean "bonds"?) (column 1 of the expression)',
    );
    expect([when.line, when.column]).toEqual([11, 13]);
    expect(issueAt(result, "rules[1].params.buckets").message).toBe(
      'Unknown bucket "csh" (did you mean "cash"?)',
    );
  });

  it("test_bucket_scope_and_bucket_metrics_need_buckets", () => {
    const result = load(
      `${MINIMAL}rules:\n  - { id: s, kind: custom, params: { scope: bucket, when: drift_pp > 5 } }\n` +
        '  - { id: p, kind: custom, params: { when: bucket_weight("x") > 5% } }\n',
    );
    expect(issueAt(result, "rules[0]").message).toBe(
      "custom rules with scope bucket need buckets and allocation.targets",
    );
    expect(issueAt(result, "rules[1].params.when").message).toContain("(no buckets are defined)");
  });

  it("test_valid_custom_rules_load", () => {
    const result = load(
      withRules(
        "rules:\n" +
          '  - { id: a, kind: custom, params: { when: "bucket_drift_pp(\\"bonds\\") < -5" } }\n' +
          "  - { id: b, kind: custom, params: { scope: bucket, buckets: [bonds], when: drift_rel < -25% } }\n",
      ),
    );
    expect(result.issues).toEqual([]);
    expect(configOf(result).rules.map((r) => (r.params as CustomParams).scope)).toEqual([
      expr.Scope.PORTFOLIO,
      expr.Scope.BUCKET,
    ]);
  });
});
