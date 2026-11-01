// tests/investments/rules/test_rules_expr_security.py, test-for-test (the Python test named in each
// title): malicious and runaway expressions are rejected safely, with no code run and bounded cost.

import { afterEach, describe, expect, it, vi } from "vitest";
import { PyValueError } from "../../../dates.js";
import { pyLen } from "../../../text.js";
import { Scope } from "./catalogTypes.js";
import { compileExpression } from "./checker.js";
import { ExpressionError } from "./lexer.js";
import { MAX_DEPTH, MAX_EXPRESSION_LENGTH, MAX_FUNCTION_ARGS, MAX_TOKENS } from "./limits.js";

const MALICIOUS: readonly string[] = [
  '__import__("os").system("echo pwned")',
  "__builtins__",
  "weight.__class__",
  "weight.real > 0",
  "().__class__.__bases__[0].__subclasses__()",
  "[x for x in ()]",
  "{}",
  'eval("1")',
  'exec("import os")',
  'compile("1", "", "eval")',
  'open("/etc/passwd")',
  "import os",
  "lambda: 1",
  "weight if true else 0",
  "globals()",
  "getattr(weight, 'real')",
  "weight[0] > 1",
  "weight > 1; import os",
  "weight > 1 # comment",
  "`id`",
  "$HOME",
  "weight := 1",
  "f'{weight}'",
  '"a" "b"',
  "weight\\\n> 1",
  "1 > 0 or __import__('os')",
  "\x00",
  "weight > \u0661", // Arabic-Indic digit one
  "weight\u200b > 1", // zero-width space
  "ｗｅｉｇｈｔ > 1", // full-width letters
  "weight > 1 \u2014 0", // the em dash character, written as an escape
  "holding_has_tag('a\\'b')",
  'holding_has_tag("\\x41")',
  "holding_has_tag('line\nbreak')",
];

function compileError(source: string, scope: Scope = Scope.INSTRUMENT): ExpressionError {
  try {
    compileExpression(source, scope);
  } catch (caught) {
    if (caught instanceof ExpressionError) return caught;
    throw caught;
  }
  throw new Error(`no ExpressionError for ${JSON.stringify(source)}`);
}

describe("test_rules_expr_security", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Python monkeypatches builtins eval / exec / compile to fail the test if called. JS has no
  // equivalent hook for every code-loading path; the global `eval` is spied on (the one a port could
  // reach by accident) and the compile error is asserted, which is what the test guards.
  it.each(MALICIOUS)("test_malicious_inputs_are_rejected_without_running_anything %j", (source) => {
    const evalSpy = vi.spyOn(globalThis, "eval");
    const caught = compileError(source);
    expect(evalSpy).not.toHaveBeenCalled();
    expect(caught.column).toBeGreaterThanOrEqual(1);
    expect(caught.column).toBeLessThanOrEqual(pyLen(source) + 1);
  });

  it("test_underscore_names_are_rejected_before_any_lookup", () => {
    expect(compileError("__class__ > 1", Scope.PORTFOLIO).message).toMatch(
      /Names cannot start with "_"/,
    );
  });

  it("test_attribute_access_is_a_syntax_error", () => {
    const caught = compileError("weight.real > 1");
    expect(caught.message).toMatch(/Attribute access is not supported/);
    expect(caught.column).toBe(7);
  });

  // Python also asserts it takes under 0.5 s; tests here never assert wall-clock time (testing.md),
  // the length check runs before any tokenizing and vitest's per-test timeout bounds the rest.
  it("test_a_huge_expression_is_rejected_quickly", () => {
    const source = `${"weight > 1 and ".repeat(10_000)}weight > 1`;
    expect(compileError(source).message).toMatch(/Expression is too long/);
  });

  it("test_too_many_tokens", () => {
    const source = Array(60).fill("weight>1").join(" or ");
    expect(source.length).toBeLessThanOrEqual(MAX_EXPRESSION_LENGTH);
    expect(compileError(source).message).toContain(`too many parts (max ${MAX_TOKENS} tokens)`);
  });

  it.each([
    `${"(".repeat(MAX_DEPTH + 1)}weight > 1${")".repeat(MAX_DEPTH + 1)}`,
    `${"not ".repeat(MAX_DEPTH + 1)}weight > 1`,
    `${"-".repeat(MAX_DEPTH + 1)}weight > 1`,
    `${Array(MAX_DEPTH + 2)
      .fill("weight")
      .join(" + ")} > 1`,
    `${"(".repeat(400)}weight > 1${")".repeat(400)}`,
  ])("test_deep_nesting_is_rejected_without_recursion_errors %#", (source) => {
    const { message } = compileError(source);
    expect(message.includes("nested too deeply") || message.includes("too many parts")).toBe(true);
  });

  it("test_nesting_within_the_limit_is_fine", () => {
    const depth = MAX_DEPTH - 3;
    expect(() =>
      compileExpression(`${"(".repeat(depth)}weight > 1${")".repeat(depth)}`, Scope.INSTRUMENT),
    ).not.toThrow();
  });

  it("test_huge_literals_and_argument_lists_are_rejected", () => {
    expect(compileError(`weight > ${"9".repeat(100)}`).message).toMatch(/Number is too long/);
    expect(compileError(`holding_has_tag("${"a".repeat(500)}")`).message).toMatch(
      /Text is too long/,
    );
    expect(compileError(`${"w".repeat(100)} > 1`).message).toMatch(/Name is too long/);
    const args = Array.from({ length: MAX_FUNCTION_ARGS + 1 }, (_, i) => `"t${i}"`).join(", ");
    expect(compileError(`tagged_weight(${args}) > 0`, Scope.PORTFOLIO).message).toMatch(
      /Too many arguments/,
    );
  });

  it("test_non_text_input_is_not_accepted", () => {
    let caught: unknown;
    try {
      compileExpression(null as unknown as string, Scope.INSTRUMENT);
    } catch (error) {
      caught = error;
    }
    expect(caught instanceof ExpressionError || caught instanceof TypeError).toBe(true);
  });

  it("test_unknown_scope_is_rejected", () => {
    let caught: unknown;
    try {
      compileExpression("weight > 1", "global");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(PyValueError);
    expect(caught).not.toBeInstanceOf(ExpressionError);
    expect((caught as PyValueError).message).toBe("'global' is not a valid Scope");
  });
});
