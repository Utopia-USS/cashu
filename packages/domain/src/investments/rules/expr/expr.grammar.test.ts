// tests/investments/rules/test_rules_expr_grammar.py, test-for-test (the Python test named in each
// title), including the evaluator's decimal and three-valued behavior.

import { describe, expect, it } from "vitest";
import { D } from "../../../decimal.js";
import { Scope } from "./catalogTypes.js";
import { compileExpression } from "./checker.js";
import { bucketReferences, metricLabel, normalized } from "./compiled.js";
import { evaluateExpression, Unknown, type Value } from "./evaluator.js";
import { ExpressionError, TokenType, tokenize } from "./lexer.js";
import type { ExprNode } from "./nodes.js";
import { parse } from "./parser.js";

function error(source: string, scope: Scope = Scope.INSTRUMENT): ExpressionError {
  try {
    compileExpression(source, scope);
  } catch (caught) {
    if (caught instanceof ExpressionError) return caught;
    throw caught;
  }
  throw new Error(`no ExpressionError for ${JSON.stringify(source)}`);
}

function as<T extends ExprNode["type"]>(node: ExprNode, type: T): Extract<ExprNode, { type: T }> {
  expect(node.type).toBe(type);
  return node as Extract<ExprNode, { type: T }>;
}

function run(source: string, values: Readonly<Record<string, Value>>) {
  return evaluateExpression(
    compileExpression(source, Scope.INSTRUMENT),
    (ref) => {
      const value = values[metricLabel(ref)];
      if (value === undefined) throw new Error("missing synthetic metric");
      return value;
    },
    "pl",
  );
}

describe("TestTokens", () => {
  it("test_numbers_percentages_text_names_operators", () => {
    const tokens = tokenize('weight >= 12.5% and .5 < 3 or holding_has_tag("core") != false');
    expect(tokens.map((t) => [t.type, t.text])).toEqual([
      [TokenType.NAME, "weight"],
      [TokenType.OP, ">="],
      [TokenType.PERCENT, "12.5%"],
      [TokenType.KEYWORD, "and"],
      [TokenType.NUMBER, ".5"],
      [TokenType.OP, "<"],
      [TokenType.NUMBER, "3"],
      [TokenType.KEYWORD, "or"],
      [TokenType.NAME, "holding_has_tag"],
      [TokenType.LPAREN, "("],
      [TokenType.STRING, '"core"'],
      [TokenType.RPAREN, ")"],
      [TokenType.OP, "!="],
      [TokenType.KEYWORD, "false"],
      [TokenType.END, ""],
    ]);
    expect(String(tokens[2]?.value)).toBe("0.125");
    expect(tokens[10]?.value).toBe("core");
    expect(tokens.slice(0, 3).map((t) => t.column)).toEqual([1, 8, 11]);
  });

  it("test_whitespace_and_newlines_are_free", () => {
    expect(run("weight\n  >\t5%", { weight: D("0.06") }).result).toBe(true);
  });
  it("test_text_in_single_quotes_and_unicode_inside_text", () => {
    expect(run("holding_has_tag('złoto')", { 'holding_has_tag("złoto")': true }).result).toBe(true);
  });
});

describe("TestPrecedence", () => {
  it("test_arithmetic_before_comparison_before_not_before_and_before_or", () => {
    const tree = as(parse("not a > 1 + 2 * 3 and b or c"), "Logical");
    expect(tree.op).toBe("or");
    const left = as(tree.operands[0] as ExprNode, "Logical");
    expect(left.op).toBe("and");
    const negation = as(left.operands[0] as ExprNode, "Unary");
    expect(negation.op).toBe("not");
    const comparison = as(negation.operand, "Compare");
    as(comparison.left, "Name");
    const addition = as(comparison.right, "Binary");
    expect(addition.op).toBe("+");
    expect(as(addition.right, "Binary").op).toBe("*");
  });

  it("test_left_associative_arithmetic_and_parentheses", () => {
    expect(run("weight - 0.1 - 0.05 == 0", { weight: D("0.15") }).result).toBe(true);
    expect(run("weight / 2 / 2 == 0.25", { weight: D("1") }).result).toBe(true);
    expect(run("(weight - 0.1) * 2 == 0.1", { weight: D("0.15") }).result).toBe(true);
    expect(run("weight - 0.1 * 2 == -0.05", { weight: D("0.15") }).result).toBe(true);
  });

  it("test_unary_minus_and_exact_decimals", () => {
    expect(run("-unrealized_pct >= 25%", { unrealized_pct: D("-0.25") }).result).toBe(true);
    expect(run("weight + 0.2 == 0.3", { weight: D("0.1") }).result).toBe(true);
    expect(run("- - weight == weight", { weight: D("0.1") }).result).toBe(true);
    const tree = as(parse("-1"), "Unary");
    as(tree.operand, "Number");
  });

  it("test_comparison_tolerance", () => {
    expect(run("weight > 0.07", { weight: D("0.07000000000000001") }).result).toBe(false);
    expect(run("weight <= 0.07", { weight: D("0.07000000000000001") }).result).toBe(true);
    expect(run("weight == 0.07", { weight: D("0.0700000001") }).result).toBe(true);
    expect(run("weight == 0.07", { weight: D("0.070000002") }).result).toBe(false);
  });
  it("test_text_and_boolean_equality", () => {
    expect(
      run('asset_class == "etf" and symbol != "PKN"', { asset_class: "etf", symbol: "VWCE" })
        .result,
    ).toBe(true);
    expect(run('holding_has_tag("x") == false', { 'holding_has_tag("x")': false }).result).toBe(
      true,
    );
  });
});

describe("TestThreeValuedLogic", () => {
  it("test_and_is_false_when_one_side_is_false_whatever_the_unknown", () => {
    expect(
      run("weight > 10% and unrealized_pct < 0", {
        weight: D("0.05"),
        unrealized_pct: new Unknown(["x"]),
      }).result,
    ).toBe(false);
  });
  it("test_or_is_true_when_one_side_is_true", () => {
    expect(
      run("weight > 10% or unrealized_pct < 0", {
        weight: D("0.2"),
        unrealized_pct: new Unknown(["x"]),
      }).result,
    ).toBe(true);
  });
  it("test_otherwise_unknown_with_all_reasons", () => {
    const result = run("weight > 10% and unrealized_pct < 0 and market_value > 0", {
      weight: new Unknown(["stale"]),
      unrealized_pct: new Unknown(["no cost"]),
      market_value: D("5"),
    });
    expect(result.result).toBeNull();
    expect(result.reasons).toEqual(["stale", "no cost"]);
    expect(run("not (weight > 10%)", { weight: new Unknown(["stale"]) }).result).toBeNull();
  });
  it("test_unknown_propagates_through_arithmetic_and_division_by_zero_is_unknown", () => {
    expect(run("weight * 2 > 1", { weight: new Unknown(["stale"]) }).reasons).toEqual(["stale"]);
    const division = run("market_value / cost_basis > 1", {
      market_value: D("1"),
      cost_basis: D("0"),
    });
    expect(division.result).toBeNull();
    expect(division.reasons).toEqual(["Dzielenie przez zero (kolumna 14)"]);
  });
  it("test_metric_values_are_reported_by_label", () => {
    const result = run("drawdown_from_high(252) >= 15% and weight < 5%", {
      weight: D("0.01"),
      "drawdown_from_high(252)": D("0.2"),
    });
    expect(result.result).toBe(true);
    expect([...result.values.keys()]).toEqual(["drawdown_from_high(252)", "weight"]);
  });
});

describe("TestScopesAndTypes", () => {
  it("test_portfolio_metrics_work_in_every_scope", () => {
    for (const scope of Object.values(Scope)) {
      expect(compileExpression("cash_weight > 10%", scope).scope).toBe(scope);
    }
  });

  it("test_scope_specific_metrics", () => {
    expect(error("weight > 1", Scope.PORTFOLIO).message).toBe(
      "weight is not available in scope portfolio (available in: instrument, bucket)",
    );
    expect(error("drawdown_from_high(5) > 0", Scope.BUCKET).message).toContain(
      "not available in scope bucket",
    );
    expect(compileExpression('drift_pp > 5 and bucket_id == "bonds"', Scope.BUCKET)).toBeTruthy();
  });

  it("test_type_errors_name_the_offending_part", () => {
    expect(error("weight").message.startsWith("The expression must be a condition")).toBe(true);
    expect(error("weight and true").message).toBe(
      "'and' needs conditions on both sides; weight is a number",
    );
    expect(error("symbol > 1").message).toBe("'>' compares numbers; symbol is text");
    expect(error('weight == "x"').message.startsWith("'==' compares values of the same type")).toBe(
      true,
    );
    expect(error("not weight").message).toBe("'not' needs a condition; weight is a number");
    expect(error("weight + true > 1").message.startsWith("'+' needs numbers on both sides")).toBe(
      true,
    );
    expect(error('-holding_has_tag("x")').message.startsWith("'-' needs a number")).toBe(true);
  });

  it("test_function_arguments_are_checked_literals", () => {
    expect(error("drawdown_from_high > 1").message).toMatch(/^drawdown_from_high is a function/);
    expect(error("weight() > 1").message).toBe(
      "weight is not a function; write it without parentheses",
    );
    expect(error("drawdown_from_high() > 1").message).toMatch(
      /^drawdown_from_high takes 1 argument\(s\)/,
    );
    expect(error("drawdown_from_high(252, 5) > 1").message).toMatch(/^drawdown_from_high takes 1/);
    expect(error("drawdown_from_high(1) > 1").message).toContain("between 2 and 2520");
    expect(error("drawdown_from_high(5000) > 1").message).toContain("between 2 and 2520");
    expect(error("drawdown_from_high(2.5) > 1").message).toContain("whole number, got 2.5");
    expect(error("drawdown_from_high(weight) > 1").message).toContain("written as a literal");
    expect(error("drawdown_from_high(10%) > 1").message).toContain("written as a literal");
    expect(error("holding_has_tag(core)").message).toContain("must be text in quotes");
    expect(error('holding_has_tag("  ")').message).toContain("must not be empty");
    expect(error('tagged_weight("a", "a") > 0').message).toBe(
      "tagged_weight lists the same value twice",
    );
    expect(compileExpression('tagged_weight("a", "b", "c") > 0', Scope.PORTFOLIO)).toBeTruthy();
    const unknownClass = error('asset_class_weight("stocks") > 0', Scope.PORTFOLIO);
    expect(unknownClass.message).toMatch(/^Unknown asset_class "stocks"/);
  });

  it("test_text_literals_compared_with_asset_class_are_checked", () => {
    expect(error('asset_class == "etff"').message).toMatch(
      /^asset_class is never "etff" \(did you mean "etf"\?\)/,
    );
    expect(compileExpression('"etf" == asset_class', Scope.INSTRUMENT)).toBeTruthy();
  });

  it("test_unknown_names_get_hints_and_keywords_must_be_lowercase", () => {
    expect(error("wieght > 1").message).toMatch(
      /^Unknown name "wieght" \(did you mean "weight"\?\)/,
    );
    expect(error("weight > 1 AND weight < 2").message).toBe(
      "Unexpected 'AND' after a complete expression",
    );
    expect(error("True").message).toBe('Write "true" in lowercase');
  });

  it("test_constant_expressions_are_rejected", () => {
    expect(error("1 > 0").message).toMatch(/^The expression uses no metric/);
    expect(error("true").message).toMatch(/^The expression uses no metric/);
  });

  it("test_metric_references_and_bucket_references", () => {
    const compiled = compileExpression(
      'bucket_drift_pp("bonds") < -5 and bucket_weight("bonds") > 0 and weight > 1',
      Scope.INSTRUMENT,
    );
    expect(compiled.metrics.map(metricLabel)).toEqual([
      'bucket_drift_pp("bonds")',
      'bucket_weight("bonds")',
      "weight",
    ]);
    expect(bucketReferences(compiled)).toEqual([
      ["bonds", 1],
      ["bonds", 35],
    ]);
    expect(normalized(compileExpression("weight  >\n 1", Scope.INSTRUMENT))).toBe("weight > 1");
  });
});

describe("TestSyntaxErrorsCarryColumns", () => {
  const cases: [string, string, number][] = [
    ["", "Expression is empty", 1],
    ["   ", "Expression is empty", 1],
    ["weight >", "Expression ended unexpectedly; expected a value", 9],
    ["(weight > 1", "Missing ')' for the '(' at column 1; found the end of the expression", 12],
    ["weight > 1)", "Unexpected ')' after a complete expression", 11],
    ["weight > 1 > 2", "Chained comparisons are not supported; combine them with 'and'", 12],
    ["weight >> 1", "Expected a value, found '>'", 9],
    ["weight > 1 weight", "Unexpected 'weight' after a complete expression", 12],
    [
      'holding_has_tag("x" , 1',
      "Missing ')' to close holding_has_tag( at column 16; found the end of the expression",
      24,
    ],
    ["weight > 1.", "A decimal point must be followed by digits (e.g. 0.5)", 11],
    ["weight > 1.2.3", "A number can have only one decimal point", 13],
    ["weight > 1e5", "Scientific notation is not supported; write the number out", 11],
    ["weight > 5abc", 'Invalid number "5a..."', 10],
    [
      "weight > 5 %",
      "'%' must directly follow a number (5% = 0.05); the modulo operator is not supported",
      12,
    ],
    ['holding_has_tag("x)', 'Missing closing quote "', 17],
    ["weight = 1", "Use '==' to compare; assignment is not supported", 8],
    ["weight > 1 && weight < 2", "Use 'and' instead of '&&'", 12],
    ["weight > 1 || weight < 2", "Use 'or' instead of '||'", 12],
    ["!holding_has_tag('x')", "Use 'not' instead of '!'", 1],
    ["weight ** 2 > 1", "Powers are not supported", 8],
    ["weight > 1 + not true", "'not' must be put in parentheses here, e.g. 1 + (not x)", 14],
    ["weight <> 1", "Use '!=' to compare for inequality", 8],
  ];

  it.each(cases)("test_error_message_and_column %j", (source, message, column) => {
    const caught = error(source);
    expect([caught.message, caught.column]).toEqual([message, column]);
    expect(String(caught)).toBe(`${message} (column ${column})`);
  });
});

// Extra (not in the Python file): the values Python gives for `str(Decimal(text) / 100)`.
describe("percent values are Python's str(value / 100)", () => {
  it.each([
    ["5%", "0.05"],
    ["12.5%", "0.125"],
    ["100%", "1"],
    ["0.00%", "0.00"],
    ["1.50%", "0.015"],
    ["007%", "0.07"],
    ["0.000000000000000000001%", "1E-23"],
    ["123456789012345678901234%", "1234567890123456789012.34"],
  ])("%s -> %s", (text, expected) => {
    const value = tokenize(text)[0]?.value;
    expect(String(value)).toBe(expected);
  });
});
