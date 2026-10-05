"""Evaluation of a compiled expression with Kleene three-valued logic.

A metric whose data is missing or untrustworthy resolves to :class:`Unknown` with a reason. Unknown
propagates through arithmetic and comparisons; ``and`` is false as soon as one side is false, ``or`` is
true as soon as one side is true, regardless of unknown sides. So the result is only true (or false) when
it would be true (or false) for every possible value of the missing data; otherwise it is unknown and the
rule skips with the collected reasons. Numbers are Decimals in a bounded context; no Python ``eval``.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
from decimal import Context, Decimal, DivisionByZero, InvalidOperation, Overflow, localcontext

from .checker import CompiledExpression, MetricRef
from .limits import COMPARISON_TOLERANCE
from .parser import Binary, Boolean, Call, Compare, Logical, Name, Node, Number, String, Unary


@dataclass(frozen=True, slots=True)
class Unknown:
    """A value that cannot be computed on the current data; ``reasons`` say why (short Polish text, the
    skip reason the owner sees)."""

    reasons: tuple[str, ...]


Value = Decimal | bool | str | Unknown
"""What a resolver returns for one metric use."""

MetricResolver = Callable[[MetricRef], Value]


@dataclass(frozen=True, slots=True)
class Evaluation:
    """Result of one evaluation: ``result`` is None when unknown (then ``reasons`` is non-empty)."""

    result: bool | None
    reasons: tuple[str, ...] = ()
    values: dict[str, Value] = field(default_factory=dict)
    """Every metric use by label (``drawdown_from_high(252)``), resolved once."""


_CONTEXT = Context(
    prec=28, Emax=999_999, Emin=-999_999, traps=[DivisionByZero, InvalidOperation, Overflow]
)


def evaluate(expression: CompiledExpression, resolve: MetricResolver) -> Evaluation:
    """Evaluates ``expression``; ``resolve`` supplies metric values (it may return :class:`Unknown`)."""
    values: dict[str, Value] = {}
    for ref in expression.metrics:
        value = resolve(ref)
        if isinstance(value, float):  # a resolver bug would otherwise mix float and Decimal
            raise TypeError(f"resolver returned a float for {ref.label}")
        values[ref.label] = value
    with localcontext(_CONTEXT):
        result = _Evaluator(values).eval(expression.tree)
    if isinstance(result, Unknown):
        return Evaluation(None, _unique(result.reasons), values)
    assert isinstance(result, bool)
    return Evaluation(result, (), values)


class _Evaluator:
    def __init__(self, values: dict[str, Value]) -> None:
        self._values = values

    def eval(self, node: Node) -> Value:
        match node:
            case Number(value=value):
                return value
            case String(value=value):
                return value
            case Boolean(value=value):
                return value
            case Name(name=name):
                return self._values[name]
            case Call():
                return self._values[_label(node)]
            case Unary(op=op, operand=operand):
                value = self.eval(operand)
                if isinstance(value, Unknown):
                    return value
                if op == "not":
                    return not value
                assert isinstance(value, Decimal)
                return -value if op == "-" else +value
            case Binary():
                return self._binary(node)
            case Compare():
                return self._compare(node)
            case Logical(op=op, operands=operands):
                return self._logical(op, operands)
        raise AssertionError(f"unknown node {node!r}")  # pragma: no cover

    def _binary(self, node: Binary) -> Value:
        left = self.eval(node.left)
        right = self.eval(node.right)
        unknown = _merge_unknown(left, right)
        if unknown is not None:
            return unknown
        assert isinstance(left, Decimal) and isinstance(right, Decimal)
        try:
            match node.op:
                case "+":
                    return left + right
                case "-":
                    return left - right
                case "*":
                    return left * right
                case _:
                    if right == 0:
                        return Unknown((f"Dzielenie przez zero (kolumna {node.column})",))
                    return left / right
        except Overflow:
            return Unknown((f"Przepełnienie arytmetyczne (kolumna {node.column})",))
        except (InvalidOperation, DivisionByZero):
            return Unknown((f"Nieprawidłowe działanie (kolumna {node.column})",))

    def _compare(self, node: Compare) -> Value:
        left = self.eval(node.left)
        right = self.eval(node.right)
        unknown = _merge_unknown(left, right)
        if unknown is not None:
            return unknown
        if isinstance(left, Decimal) and isinstance(right, Decimal):
            diff = left - right
            tolerance = COMPARISON_TOLERANCE
            match node.op:
                case "<":
                    return diff < -tolerance
                case "<=":
                    return diff <= tolerance
                case ">":
                    return diff > tolerance
                case ">=":
                    return diff >= -tolerance
                case "==":
                    return abs(diff) <= tolerance
                case _:
                    return abs(diff) > tolerance
        return (left == right) if node.op == "==" else (left != right)

    def _logical(self, op: str, operands: tuple[Node, ...]) -> Value:
        # Every operand is evaluated (no side effects exist), so all unknown reasons are collected.
        results = [self.eval(operand) for operand in operands]
        decisive = op == "or"  # true decides an "or", false decides an "and"
        if any(result is decisive for result in results):
            return decisive
        unknown = _merge_unknown(*results)
        if unknown is not None:
            return unknown
        return not decisive


def _merge_unknown(*values: Value) -> Unknown | None:
    unknowns = [value for value in values if isinstance(value, Unknown)]
    if not unknowns:
        return None
    return Unknown(tuple(reason for unknown in unknowns for reason in unknown.reasons))


def _unique(reasons: tuple[str, ...]) -> tuple[str, ...]:
    return tuple(dict.fromkeys(reasons))


def _label(node: Call) -> str:
    rendered: list[str] = []
    for arg in node.args:
        if isinstance(arg, String):
            rendered.append(f'"{arg.value.strip()}"')
        else:
            assert isinstance(arg, Number)
            rendered.append(str(int(arg.value)))
    return f"{node.name}({', '.join(rendered)})"
