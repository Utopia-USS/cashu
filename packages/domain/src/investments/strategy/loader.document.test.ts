// Port of tests/investments/strategy/test_strategy_loader.py, classes TestDocumentErrors, TestHeader,
// TestUnknownKeys and the module-level tests (issue rendering, garbage never raises).

import { describe, expect, it } from "vitest";
import {
  errorsOf,
  isError,
  issueText,
  isValid,
  type StrategyIssue,
  strategyIssue,
  warningsOf,
} from "./index.js";
import { configOf, issueAt, load, MINIMAL } from "./testing/load.js";

/** `result.errors[0]`. */
function firstError(yamlText: string): StrategyIssue {
  const [issue] = errorsOf(load(yamlText));
  expect(issue).toBeDefined();
  if (issue === undefined) throw new Error("no error");
  return issue;
}

describe("TestDocumentErrors", () => {
  it("test_yaml_syntax_error_carries_the_parser_location", () => {
    const result = load("version: 1\nbase_currency: [PLN\n");
    expect(result.config).toBeNull();
    const errors = errorsOf(result);
    expect(errors).toHaveLength(1);
    const issue = errors[0];
    expect(issue?.path).toBe("");
    expect(issue?.message.startsWith("Invalid YAML: ")).toBe(true);
    expect(issue?.line).not.toBeNull();
    expect(issue?.column).not.toBeNull();
  });

  it("test_duplicate_keys_are_an_error_at_the_duplicate", () => {
    const issue = firstError("version: 1\nbase_currency: PLN\nversion: 1\n");
    expect(issue.message).toBe(
      'Invalid YAML: duplicate mapping key "version" (first defined on line 1)',
    );
    expect([issue.line, issue.column]).toEqual([3, 1]);
  });

  it("test_nested_duplicate_keys_too", () => {
    const issue = firstError(`${MINIMAL}data:\n  max_stale_weight: 0.1\n  max_stale_weight: 0.2\n`);
    expect([issue.line, issue.column]).toEqual([5, 3]);
  });

  it("test_an_empty_file_or_a_non_mapping_document", () => {
    expect(firstError("").message).toContain("strategy.yaml is empty");
    expect(firstError("# only a comment\n").message).toContain("strategy.yaml is empty");
    expect(firstError("- a\n- b\n").message).toContain("must be a mapping");
    expect(firstError("just text\n").message).toContain("must be a mapping");
  });

  it("test_anchors_aliases_merge_keys_and_custom_tags_are_rejected", () => {
    const alias = firstError(`${MINIMAL}data: &d { max_stale_weight: 0.1 }\nwatchlist: *d\n`);
    expect(alias.message).toBe("YAML anchors and aliases (& and *) are not supported");
    const merge = firstError(`${MINIMAL}data:\n  <<: { max_stale_weight: 0.1 }\n`);
    expect(merge.message).toBe("YAML merge keys (<<) are not supported");
    expect([merge.line, merge.column]).toEqual([4, 3]);
    const tag = firstError(`${MINIMAL}data: !!python/object:os.system { }\n`);
    expect(tag.message.startsWith("Unsupported YAML tag")).toBe(true);
    const localTag = firstError(`${MINIMAL}horizon_years: !custom 5\n`);
    expect(localTag.message).toBe("Unsupported YAML tag !custom");
    const complexKey = firstError(`${MINIMAL}? [a, b]\n: 1\n`);
    expect(complexKey.message).toBe("Mapping keys must be plain text");
  });

  it("test_a_billion_laughs_document_is_rejected", () => {
    const laughs = 'a: &a ["lol","lol"]\nb: &b [*a,*a,*a]\nc: &c [*b,*b,*b]\nd: [*c,*c,*c]\n';
    expect(firstError(MINIMAL + laughs).message).toContain("aliases");
  });

  it("test_huge_and_deeply_nested_documents_are_rejected", () => {
    const huge = `${MINIMAL}# ${"x".repeat(600_000)}\n`;
    expect(firstError(huge).message).toContain("too large");
    const deep = `${MINIMAL}watchlist: ${"[".repeat(5000)}${"]".repeat(5000)}\n`;
    const issue = firstError(deep);
    expect(issue.message).toBe("strategy.yaml is nested too deeply (max 32 levels)");
    expect([issue.line, issue.column]).toEqual([3, 43]);
  });
});

describe("TestHeader", () => {
  it("test_version_and_base_currency_are_required", () => {
    const result = load("horizon_years: 5\n");
    expect(issueAt(result, "version").message).toBe("version is required");
    expect(issueAt(result, "base_currency").message).toContain("base_currency is required");
    expect(result.config).toBeNull();
  });

  it("test_unsupported_or_non_integer_version", () => {
    expect(issueAt(load("version: 2\nbase_currency: PLN\n"), "version").message).toBe(
      "Unsupported version 2 (supported: 1)",
    );
    const issue = issueAt(load('version: "1"\nbase_currency: PLN\n'), "version");
    expect(issue.message).toContain("whole number");
    expect([issue.line, issue.column]).toEqual([1, 10]);
    expect(issueAt(load("version: true\nbase_currency: PLN\n"), "version").message).toContain(
      "whole number, got true",
    );
  });

  it("test_invalid_currency_is_an_error_non_pln_a_warning", () => {
    expect(isError(issueAt(load("version: 1\nbase_currency: zloty\n"), "base_currency"))).toBe(
      true,
    );
    const eur = load("version: 1\nbase_currency: EUR\n");
    expect(isValid(eur)).toBe(true);
    expect(warningsOf(eur)[0]?.message).toContain("Only PLN is fully supported");
    expect(configOf(eur).baseCurrency).toBe("EUR");
  });

  it("test_horizon_years_range", () => {
    expect(issueAt(load(`${MINIMAL}horizon_years: 0\n`), "horizon_years").message).toContain(
      "at least 1",
    );
    expect(issueAt(load(`${MINIMAL}horizon_years: 101\n`), "horizon_years").message).toContain(
      "at most 100",
    );
  });
});

describe("TestUnknownKeys", () => {
  it("test_unknown_keys_at_every_level_are_warnings_with_hints_at_the_key", () => {
    const result = load(`version: 1
base_currency: PLN
horizon_yaers: 10
data: { max_stale_wieght: 0.1 }
buckets:
  - id: all
    match: {}
    note: everything
allocation:
  targets: { all: 1 }
  rebalence: { absolute_band_pp: 5 }
rules:
  - id: conc
    kind: position_concentration
    serverity: action
    params: { max_weight: 0.1, asset_clas: equity }
watchlist:
  criterea: { max_pe: 20 }
benchmark: { id: x, proxy: y, curency: PLN }
notifications: { imediate: [action] }
`);
    expect(isValid(result)).toBe(true);
    expect(errorsOf(result)).toEqual([]);
    const byPath = new Map(warningsOf(result).map((issue) => [issue.path, issue]));
    expect([...byPath.keys()]).toEqual([
      "horizon_yaers",
      "data.max_stale_wieght",
      "buckets[0].note",
      "allocation.rebalence",
      "rules[0].serverity",
      "rules[0].params.asset_clas",
      "watchlist.criterea",
      "benchmark.curency",
      "notifications.imediate",
    ]);
    const at = (path: string): StrategyIssue => {
      const issue = byPath.get(path);
      if (issue === undefined) throw new Error(`no warning at ${path}`);
      return issue;
    };
    expect(at("horizon_yaers").message).toBe(
      'Unknown key "horizon_yaers" (did you mean "horizon_years"?); it is ignored',
    );
    expect(at("data.max_stale_wieght").message).toContain('did you mean "max_stale_weight"');
    expect(at("allocation.rebalence").message).toContain('did you mean "rebalance"');
    expect(at("rules[0].serverity").message).toContain('did you mean "severity"');
    expect(at("rules[0].params.asset_clas").message).toContain('did you mean "asset_class"');
    expect(at("benchmark.curency").message).toContain('did you mean "currency"');
    expect(at("notifications.imediate").message).toContain('did you mean "immediate"');
    expect(at("buckets[0].note").message).not.toContain("did you mean");
    const param = at("rules[0].params.asset_clas");
    expect([param.line, param.column], "points at the key").toEqual([16, 32]);
    expect([at("horizon_yaers").line, at("horizon_yaers").column]).toEqual([3, 1]);
  });
});

// test_strategy_issue_renders_path_and_location
it("test_strategy_issue_renders_path_and_location", () => {
  const issue = issueAt(load("version: 2\nbase_currency: PLN\n"), "version");
  expect(issueText(issue)).toBe(
    "error version (line 1, column 10): Unsupported version 2 (supported: 1)",
  );
  expect(issueText(strategyIssue("warning", "strategy.md", "m"))).toBe("warning strategy.md: m");
  expect(issueText(strategyIssue("error", "", "m", 1, 1))).toBe("error (line 1, column 1): m");
});

// test_garbage_never_raises (parametrized)
it.each(["version: 1\nbase_currency: PLN\nrules: 5\n", "version: [1]\nbase_currency: [PLN]\n"])(
  "test_garbage_never_raises %j",
  (text) => {
    expect(load(text).config).toBeNull();
  },
);
