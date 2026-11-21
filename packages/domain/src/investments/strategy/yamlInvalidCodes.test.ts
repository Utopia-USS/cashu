// Port of tests/investments/strategy/test_yaml_invalid_codes.py (F7-FIX2 B6): a YAML error is one
// line with the stable code `strategy.yaml_invalid`; a control character gets PyYAML's problem
// sentence as `problem` and the character's line / column; a positioned parser error is unchanged.

import { describe, expect, it } from "vitest";
import { classify, loadStrategy, type StrategyIssue } from "./index.js";

/** `_issue`: the only issue of the load. */
function onlyIssue(text: string): StrategyIssue {
  const issues = loadStrategy(text, "").issues;
  expect(issues).toHaveLength(1);
  const [issue] = issues;
  if (issue === undefined) throw new Error("no issue");
  return issue;
}

describe("yaml_invalid codes", () => {
  it("test_a_control_character_is_yaml_invalid_with_its_position", () => {
    const issue = onlyIssue("version: 1\nbase_currency: PLN\x01\n");
    const problem = "unacceptable character #x0001: special characters are not allowed";
    expect(issue.message).toBe(`Invalid YAML: ${problem}`);
    expect(issue.message).not.toContain("\n");
    expect(issue.code).toBe("strategy.yaml_invalid");
    expect(issue.params).toEqual({ problem });
    expect([issue.line, issue.column]).toEqual([2, 19]);
  });

  it("test_a_positioned_parser_error_is_unchanged", () => {
    const issue = onlyIssue("version: 1\nbase_currency: [PLN\n");
    const problem = "expected ',' or ']', but got '<stream end>' (while parsing a flow sequence)";
    expect(issue.message).toBe(`Invalid YAML: ${problem}`);
    expect(issue.code).toBe("strategy.yaml_invalid");
    expect(issue.params).toEqual({ problem });
    expect([issue.line, issue.column]).toEqual([3, 1]);
  });

  it("test_a_multi_line_message_still_classifies_with_the_first_line", () => {
    const message =
      "Invalid YAML: unacceptable character #x0001: special characters are not allowed\n" +
      '  in "<unicode string>", position 29';
    expect(classify(message)).toEqual([
      "strategy.yaml_invalid",
      { problem: "unacceptable character #x0001: special characters are not allowed" },
    ]);
  });
});
