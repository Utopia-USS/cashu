"""Malicious and runaway expressions are rejected safely: no code runs, no attribute access, bounded cost."""

from __future__ import annotations

import builtins
import time

import pytest

from finanse.modules.investments.rules.expr import ExpressionError, Scope, compile_expression
from finanse.modules.investments.rules.expr.limits import (
    MAX_DEPTH,
    MAX_EXPRESSION_LENGTH,
    MAX_FUNCTION_ARGS,
    MAX_TOKENS,
)

MALICIOUS = [
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
    "weight > \u0661",  # Arabic-Indic digit one
    "weight\u200b > 1",  # zero-width space
    "ｗｅｉｇｈｔ > 1",  # full-width letters
    "weight > 1 \u2014 0",  # em dash character
    "holding_has_tag('a\\'b')",
    'holding_has_tag("\\x41")',
    "holding_has_tag('line\nbreak')",
]


@pytest.mark.parametrize("source", MALICIOUS)
def test_malicious_inputs_are_rejected_without_running_anything(source, monkeypatch):
    def forbidden(*args, **kwargs):
        raise AssertionError("the expression language must never call eval/exec/compile/__import__")

    monkeypatch.setattr(builtins, "eval", forbidden)
    monkeypatch.setattr(builtins, "exec", forbidden)
    monkeypatch.setattr(builtins, "compile", forbidden)
    with pytest.raises(ExpressionError) as caught:
        compile_expression(source, Scope.INSTRUMENT)
    assert 1 <= caught.value.column <= len(source) + 1


def test_underscore_names_are_rejected_before_any_lookup():
    with pytest.raises(ExpressionError, match='Names cannot start with "_"'):
        compile_expression("__class__ > 1", Scope.PORTFOLIO)


def test_attribute_access_is_a_syntax_error():
    with pytest.raises(ExpressionError, match="Attribute access is not supported") as caught:
        compile_expression("weight.real > 1", Scope.INSTRUMENT)
    assert caught.value.column == 7


def test_a_huge_expression_is_rejected_quickly():
    source = "weight > 1 and " * 10_000 + "weight > 1"
    started = time.perf_counter()
    with pytest.raises(ExpressionError, match="Expression is too long"):
        compile_expression(source, Scope.INSTRUMENT)
    assert time.perf_counter() - started < 0.5


def test_too_many_tokens():
    source = " or ".join(["weight>1"] * 60)
    assert len(source) <= MAX_EXPRESSION_LENGTH
    with pytest.raises(ExpressionError, match=f"too many parts \\(max {MAX_TOKENS} tokens\\)"):
        compile_expression(source, Scope.INSTRUMENT)


@pytest.mark.parametrize(
    "source",
    [
        "(" * (MAX_DEPTH + 1) + "weight > 1" + ")" * (MAX_DEPTH + 1),
        "not " * (MAX_DEPTH + 1) + "weight > 1",
        "-" * (MAX_DEPTH + 1) + "weight > 1",
        " + ".join(["weight"] * (MAX_DEPTH + 2)) + " > 1",
        "(" * 400 + "weight > 1" + ")" * 400,
    ],
)
def test_deep_nesting_is_rejected_without_recursion_errors(source):
    with pytest.raises(ExpressionError) as caught:
        compile_expression(source, Scope.INSTRUMENT)
    assert "nested too deeply" in caught.value.message or "too many parts" in caught.value.message


def test_nesting_within_the_limit_is_fine():
    depth = MAX_DEPTH - 3
    compile_expression("(" * depth + "weight > 1" + ")" * depth, Scope.INSTRUMENT)


def test_huge_literals_and_argument_lists_are_rejected():
    with pytest.raises(ExpressionError, match="Number is too long"):
        compile_expression("weight > " + "9" * 100, Scope.INSTRUMENT)
    with pytest.raises(ExpressionError, match="Text is too long"):
        compile_expression(f'holding_has_tag("{"a" * 500}")', Scope.INSTRUMENT)
    with pytest.raises(ExpressionError, match="Name is too long"):
        compile_expression("w" * 100 + " > 1", Scope.INSTRUMENT)
    args = ", ".join(f'"t{i}"' for i in range(MAX_FUNCTION_ARGS + 1))
    with pytest.raises(ExpressionError, match="Too many arguments"):
        compile_expression(f"tagged_weight({args}) > 0", Scope.PORTFOLIO)


def test_non_text_input_is_not_accepted():
    with pytest.raises((ExpressionError, TypeError)):
        compile_expression(None, Scope.INSTRUMENT)  # type: ignore[arg-type]


def test_unknown_scope_is_rejected():
    with pytest.raises(ValueError):
        compile_expression("weight > 1", "global")
