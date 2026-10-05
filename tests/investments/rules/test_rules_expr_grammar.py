"""Expression language: tokens, grammar, precedence, types, three-valued evaluation, error columns."""

from __future__ import annotations

from decimal import Decimal

import pytest

from finanse.modules.investments.rules.expr import (
    ExpressionError,
    Scope,
    Unknown,
    compile_expression,
    evaluate,
)
from finanse.modules.investments.rules.expr.lexer import TokenType, tokenize
from finanse.modules.investments.rules.expr.parser import (
    Binary,
    Compare,
    Logical,
    Name,
    Number,
    Unary,
    parse,
)


def run(source: str, scope: Scope = Scope.INSTRUMENT, **values):
    """Evaluates ``source`` with metric values given by label (``drawdown_from_high_252`` style keys are
    not needed: pass a dict via ``values['labels']`` for calls)."""
    labels = values.pop("labels", {})
    table = {**values, **labels}
    compiled = compile_expression(source, scope)
    return evaluate(compiled, lambda ref: table[ref.label])


def error(source: str, scope: Scope = Scope.INSTRUMENT) -> ExpressionError:
    with pytest.raises(ExpressionError) as caught:
        compile_expression(source, scope)
    return caught.value


class TestTokens:
    def test_numbers_percentages_text_names_operators(self):
        tokens = tokenize('weight >= 12.5% and .5 < 3 or holding_has_tag("core") != false')
        assert [(t.type, t.text) for t in tokens] == [
            (TokenType.NAME, "weight"),
            (TokenType.OP, ">="),
            (TokenType.PERCENT, "12.5%"),
            (TokenType.KEYWORD, "and"),
            (TokenType.NUMBER, ".5"),
            (TokenType.OP, "<"),
            (TokenType.NUMBER, "3"),
            (TokenType.KEYWORD, "or"),
            (TokenType.NAME, "holding_has_tag"),
            (TokenType.LPAREN, "("),
            (TokenType.STRING, '"core"'),
            (TokenType.RPAREN, ")"),
            (TokenType.OP, "!="),
            (TokenType.KEYWORD, "false"),
            (TokenType.END, ""),
        ]
        assert tokens[2].value == Decimal("0.125")
        assert tokens[10].value == "core"
        assert [t.column for t in tokens[:3]] == [1, 8, 11]

    def test_whitespace_and_newlines_are_free(self):
        assert run("weight\n  >\t5%", weight=Decimal("0.06")).result is True

    def test_text_in_single_quotes_and_unicode_inside_text(self):
        assert (
            run("holding_has_tag('złoto')", labels={'holding_has_tag("złoto")': True}).result
            is True
        )


class TestPrecedence:
    def test_arithmetic_before_comparison_before_not_before_and_before_or(self):
        tree = parse("not a > 1 + 2 * 3 and b or c")
        assert isinstance(tree, Logical) and tree.op == "or"
        left = tree.operands[0]
        assert isinstance(left, Logical) and left.op == "and"
        negation = left.operands[0]
        assert isinstance(negation, Unary) and negation.op == "not"
        comparison = negation.operand
        assert isinstance(comparison, Compare) and isinstance(comparison.left, Name)
        addition = comparison.right
        assert isinstance(addition, Binary) and addition.op == "+"
        assert isinstance(addition.right, Binary) and addition.right.op == "*"

    def test_left_associative_arithmetic_and_parentheses(self):
        assert run("weight - 0.1 - 0.05 == 0", weight=Decimal("0.15")).result is True
        assert run("weight / 2 / 2 == 0.25", weight=Decimal(1)).result is True
        assert run("(weight - 0.1) * 2 == 0.1", weight=Decimal("0.15")).result is True
        assert run("weight - 0.1 * 2 == -0.05", weight=Decimal("0.15")).result is True

    def test_unary_minus_and_exact_decimals(self):
        assert run("-unrealized_pct >= 25%", unrealized_pct=Decimal("-0.25")).result is True
        assert run("weight + 0.2 == 0.3", weight=Decimal("0.1")).result is True
        assert run("- - weight == weight", weight=Decimal("0.1")).result is True
        tree = parse("-1")
        assert isinstance(tree, Unary) and isinstance(tree.operand, Number)

    def test_comparison_tolerance(self):
        assert run("weight > 0.07", weight=Decimal("0.07000000000000001")).result is False
        assert run("weight <= 0.07", weight=Decimal("0.07000000000000001")).result is True
        assert run("weight == 0.07", weight=Decimal("0.0700000001")).result is True
        assert run("weight == 0.07", weight=Decimal("0.070000002")).result is False

    def test_text_and_boolean_equality(self):
        assert (
            run('asset_class == "etf" and symbol != "PKN"', asset_class="etf", symbol="VWCE").result
            is True
        )
        assert (
            run('holding_has_tag("x") == false', labels={'holding_has_tag("x")': False}).result
            is True
        )


class TestThreeValuedLogic:
    def test_and_is_false_when_one_side_is_false_whatever_the_unknown(self):
        result = run(
            "weight > 10% and unrealized_pct < 0",
            weight=Decimal("0.05"),
            unrealized_pct=Unknown(("x",)),
        )
        assert result.result is False

    def test_or_is_true_when_one_side_is_true(self):
        result = run(
            "weight > 10% or unrealized_pct < 0",
            weight=Decimal("0.2"),
            unrealized_pct=Unknown(("x",)),
        )
        assert result.result is True

    def test_otherwise_unknown_with_all_reasons(self):
        result = run(
            "weight > 10% and unrealized_pct < 0 and market_value > 0",
            weight=Unknown(("stale",)),
            unrealized_pct=Unknown(("no cost",)),
            market_value=Decimal(5),
        )
        assert result.result is None
        assert result.reasons == ("stale", "no cost")
        negated = run("not (weight > 10%)", weight=Unknown(("stale",)))
        assert negated.result is None

    def test_unknown_propagates_through_arithmetic_and_division_by_zero_is_unknown(self):
        assert run("weight * 2 > 1", weight=Unknown(("stale",))).reasons == ("stale",)
        division = run(
            "market_value / cost_basis > 1", market_value=Decimal(1), cost_basis=Decimal(0)
        )
        assert division.result is None
        assert division.reasons == ("Dzielenie przez zero (kolumna 14)",)

    def test_metric_values_are_reported_by_label(self):
        result = run(
            "drawdown_from_high(252) >= 15% and weight < 5%",
            weight=Decimal("0.01"),
            labels={"drawdown_from_high(252)": Decimal("0.2")},
        )
        assert result.result is True
        assert list(result.values) == ["drawdown_from_high(252)", "weight"]


class TestScopesAndTypes:
    def test_portfolio_metrics_work_in_every_scope(self):
        for scope in Scope:
            assert compile_expression("cash_weight > 10%", scope).scope == scope

    def test_scope_specific_metrics(self):
        assert error("weight > 1", Scope.PORTFOLIO).message == (
            "weight is not available in scope portfolio (available in: instrument, bucket)"
        )
        assert (
            "not available in scope bucket"
            in error("drawdown_from_high(5) > 0", Scope.BUCKET).message
        )
        assert compile_expression('drift_pp > 5 and bucket_id == "bonds"', Scope.BUCKET)

    def test_type_errors_name_the_offending_part(self):
        assert error("weight").message.startswith("The expression must be a condition")
        assert error("weight and true").message == (
            "'and' needs conditions on both sides; weight is a number"
        )
        assert error("symbol > 1").message == "'>' compares numbers; symbol is text"
        assert error('weight == "x"').message.startswith("'==' compares values of the same type")
        assert error("not weight").message == "'not' needs a condition; weight is a number"
        assert error("weight + true > 1").message.startswith("'+' needs numbers on both sides")
        assert error('-holding_has_tag("x")').message.startswith("'-' needs a number")

    def test_function_arguments_are_checked_literals(self):
        assert error("drawdown_from_high > 1").message.startswith(
            "drawdown_from_high is a function"
        )
        assert (
            error("weight() > 1").message
            == "weight is not a function; write it without parentheses"
        )
        assert error("drawdown_from_high() > 1").message.startswith(
            "drawdown_from_high takes 1 argument(s)"
        )
        assert error("drawdown_from_high(252, 5) > 1").message.startswith(
            "drawdown_from_high takes 1"
        )
        assert "between 2 and 2520" in error("drawdown_from_high(1) > 1").message
        assert "between 2 and 2520" in error("drawdown_from_high(5000) > 1").message
        assert "whole number, got 2.5" in error("drawdown_from_high(2.5) > 1").message
        assert "written as a literal" in error("drawdown_from_high(weight) > 1").message
        assert "written as a literal" in error("drawdown_from_high(10%) > 1").message
        assert "must be text in quotes" in error("holding_has_tag(core)").message
        assert "must not be empty" in error('holding_has_tag("  ")').message
        assert (
            error('tagged_weight("a", "a") > 0').message
            == "tagged_weight lists the same value twice"
        )
        assert compile_expression('tagged_weight("a", "b", "c") > 0', Scope.PORTFOLIO)
        unknown_class = error('asset_class_weight("stocks") > 0', Scope.PORTFOLIO)
        assert unknown_class.message.startswith('Unknown asset_class "stocks"')

    def test_text_literals_compared_with_asset_class_are_checked(self):
        assert error('asset_class == "etff"').message.startswith(
            'asset_class is never "etff" (did you mean "etf"?)'
        )
        assert compile_expression('"etf" == asset_class', Scope.INSTRUMENT)

    def test_unknown_names_get_hints_and_keywords_must_be_lowercase(self):
        assert error("wieght > 1").message.startswith(
            'Unknown name "wieght" (did you mean "weight"?)'
        )
        assert (
            error("weight > 1 AND weight < 2").message
            == "Unexpected 'AND' after a complete expression"
        )
        assert error("True").message == 'Write "true" in lowercase'

    def test_constant_expressions_are_rejected(self):
        assert error("1 > 0").message.startswith("The expression uses no metric")
        assert error("true").message.startswith("The expression uses no metric")

    def test_metric_references_and_bucket_references(self):
        compiled = compile_expression(
            'bucket_drift_pp("bonds") < -5 and bucket_weight("bonds") > 0 and weight > 1',
            Scope.INSTRUMENT,
        )
        assert [ref.label for ref in compiled.metrics] == [
            'bucket_drift_pp("bonds")',
            'bucket_weight("bonds")',
            "weight",
        ]
        assert compiled.bucket_references == (("bonds", 1), ("bonds", 35))
        assert compile_expression("weight  >\n 1", Scope.INSTRUMENT).normalized == "weight > 1"


class TestSyntaxErrorsCarryColumns:
    @pytest.mark.parametrize(
        ("source", "message", "column"),
        [
            ("", "Expression is empty", 1),
            ("   ", "Expression is empty", 1),
            ("weight >", "Expression ended unexpectedly; expected a value", 9),
            (
                "(weight > 1",
                "Missing ')' for the '(' at column 1; found the end of the expression",
                12,
            ),
            ("weight > 1)", "Unexpected ')' after a complete expression", 11),
            (
                "weight > 1 > 2",
                "Chained comparisons are not supported; combine them with 'and'",
                12,
            ),
            ("weight >> 1", "Expected a value, found '>'", 9),
            ("weight > 1 weight", "Unexpected 'weight' after a complete expression", 12),
            (
                'holding_has_tag("x" , 1',
                "Missing ')' to close holding_has_tag( at column 16; found the end of the expression",
                24,
            ),
            ("weight > 1.", "A decimal point must be followed by digits (e.g. 0.5)", 11),
            ("weight > 1.2.3", "A number can have only one decimal point", 13),
            ("weight > 1e5", "Scientific notation is not supported; write the number out", 11),
            ("weight > 5abc", 'Invalid number "5a..."', 10),
            (
                "weight > 5 %",
                "'%' must directly follow a number (5% = 0.05); the modulo operator is not supported",
                12,
            ),
            ('holding_has_tag("x)', 'Missing closing quote "', 17),
            ("weight = 1", "Use '==' to compare; assignment is not supported", 8),
            ("weight > 1 && weight < 2", "Use 'and' instead of '&&'", 12),
            ("weight > 1 || weight < 2", "Use 'or' instead of '||'", 12),
            ("!holding_has_tag('x')", "Use 'not' instead of '!'", 1),
            ("weight ** 2 > 1", "Powers are not supported", 8),
            (
                "weight > 1 + not true",
                "'not' must be put in parentheses here, e.g. 1 + (not x)",
                14,
            ),
            ("weight <> 1", "Use '!=' to compare for inequality", 8),
        ],
    )
    def test_error_message_and_column(self, source, message, column):
        caught = error(source)
        assert (caught.message, caught.column) == (message, column)
        assert str(caught) == f"{message} (column {column})"
