"""Static checks of a parsed expression against the metric catalog: names, scopes, argument literals,
types. Produces a :class:`CompiledExpression` the evaluator can run without further checks."""

from __future__ import annotations

from dataclasses import dataclass

from ..hints import did_you_mean
from .catalog import METRICS, ArgSpec, MetricSpec, Scope, ValueType, names_in_scope
from .lexer import KEYWORDS, ExpressionError
from .limits import MAX_FUNCTION_ARGS
from .parser import (
    Binary,
    Boolean,
    Call,
    Compare,
    Logical,
    Name,
    Node,
    Number,
    String,
    Unary,
    parse,
)


@dataclass(frozen=True, slots=True)
class MetricRef:
    """One metric use: a variable (``args == ()``) or a function call with literal arguments."""

    name: str
    args: tuple[int | str, ...]
    column: int

    @property
    def label(self) -> str:
        """Stable text form used as the payload key, e.g. ``drawdown_from_high(252)``."""
        spec = METRICS[self.name]
        if not spec.is_function:
            return self.name
        rendered = [f'"{arg}"' if isinstance(arg, str) else str(arg) for arg in self.args]
        return f"{self.name}({', '.join(rendered)})"


@dataclass(frozen=True, slots=True)
class CompiledExpression:
    """A checked expression of one scope. Build it with :func:`compile_expression`."""

    source: str
    scope: Scope
    tree: Node
    metrics: tuple[MetricRef, ...]
    """Metric uses in order of first appearance, one per distinct label."""

    @property
    def bucket_references(self) -> tuple[tuple[str, int], ...]:
        """(bucket id, column) of every literal naming a bucket, for the strategy loader's cross-check."""
        refs: list[tuple[str, int]] = []
        for ref in self.metrics:
            spec = METRICS[ref.name]
            if not spec.is_function:
                continue
            for arg_spec, value in zip(_expand(spec, len(ref.args)), ref.args, strict=True):
                if arg_spec.reference == "bucket" and isinstance(value, str):
                    refs.append((value, ref.column))
        return tuple(refs)

    @property
    def normalized(self) -> str:
        """The source with runs of whitespace collapsed (for messages)."""
        return " ".join(self.source.split())


def compile_expression(source: str, scope: Scope | str) -> CompiledExpression:
    """Parses and type-checks ``source`` for ``scope``. Raises :class:`ExpressionError` (1-based column)."""
    scope = Scope(scope)
    tree = parse(source)
    checker = _Checker(scope)
    result = checker.type_of(tree)
    if result != ValueType.BOOLEAN:
        raise ExpressionError(
            f"The expression must be a condition (true or false), e.g. weight > 10%; "
            f"this one gives {_article(result)}",
            tree.column,
        )
    if not checker.refs:
        raise ExpressionError(
            "The expression uses no metric, so it would always give the same answer", tree.column
        )
    return CompiledExpression(source, scope, tree, tuple(checker.refs.values()))


class _Checker:
    def __init__(self, scope: Scope) -> None:
        self.scope = scope
        self.refs: dict[str, MetricRef] = {}

    def type_of(self, node: Node) -> ValueType:
        match node:
            case Number():
                return ValueType.NUMBER
            case String():
                return ValueType.TEXT
            case Boolean():
                return ValueType.BOOLEAN
            case Name():
                return self._name(node)
            case Call():
                return self._call(node)
            case Unary(op="not", operand=operand):
                self._expect(operand, ValueType.BOOLEAN, "'not' needs a condition")
                return ValueType.BOOLEAN
            case Unary(op=op, operand=operand):
                self._expect(operand, ValueType.NUMBER, f"'{op}' needs a number")
                return ValueType.NUMBER
            case Binary(op=op, left=left, right=right):
                self._expect(left, ValueType.NUMBER, f"'{op}' needs numbers on both sides")
                self._expect(right, ValueType.NUMBER, f"'{op}' needs numbers on both sides")
                return ValueType.NUMBER
            case Compare():
                return self._compare(node)
            case Logical(op=op, operands=operands):
                for operand in operands:
                    self._expect(
                        operand, ValueType.BOOLEAN, f"'{op}' needs conditions on both sides"
                    )
                return ValueType.BOOLEAN
        raise AssertionError(f"unknown node {node!r}")  # pragma: no cover

    def _expect(self, node: Node, expected: ValueType, message: str) -> None:
        actual = self.type_of(node)
        if actual != expected:
            raise ExpressionError(f"{message}; {_show(node)} is {_article(actual)}", node.column)

    def _lookup(self, name: str, column: int) -> MetricSpec:
        if name.lower() in KEYWORDS:
            raise ExpressionError(f'Write "{name.lower()}" in lowercase', column)
        spec = METRICS.get(name)
        if spec is None:
            known = names_in_scope(self.scope) + sorted(KEYWORDS)
            hint = did_you_mean(name, known)
            raise ExpressionError(
                f'Unknown name "{name}"{hint}; see the metric catalog for scope {self.scope}',
                column,
            )
        if self.scope not in spec.scopes:
            available = ", ".join(scope.value for scope in Scope if scope in spec.scopes)
            raise ExpressionError(
                f"{name} is not available in scope {self.scope} (available in: {available})", column
            )
        return spec

    def _name(self, node: Name) -> ValueType:
        spec = self._lookup(node.name, node.column)
        if spec.is_function:
            raise ExpressionError(
                f"{node.name} is a function; call it with arguments: {spec.signature()}",
                node.column,
            )
        self._record(MetricRef(node.name, (), node.column))
        return spec.type

    def _call(self, node: Call) -> ValueType:
        spec = self._lookup(node.name, node.column)
        if not spec.is_function:
            raise ExpressionError(
                f"{node.name} is not a function; write it without parentheses", node.column
            )
        assert spec.args is not None
        variadic = bool(spec.args) and spec.args[-1].variadic
        fixed = len(spec.args) - (1 if variadic else 0)
        count = len(node.args)
        if (not variadic and count != len(spec.args)) or (variadic and count < len(spec.args)):
            raise ExpressionError(
                f"{node.name} takes {_arity(spec)}; usage: {spec.signature()}", node.column
            )
        if count > MAX_FUNCTION_ARGS:  # pragma: no cover - the parser enforces it first
            raise ExpressionError(f"Too many arguments for {node.name}", node.column)
        values: list[int | str] = []
        for index, arg in enumerate(node.args):
            arg_spec = spec.args[min(index, fixed)] if variadic else spec.args[index]
            values.append(self._literal_arg(node.name, arg_spec, arg))
        if variadic and len(set(values[fixed:])) != len(values[fixed:]):
            raise ExpressionError(f"{node.name} lists the same value twice", node.column)
        self._record(MetricRef(node.name, tuple(values), node.column))
        return spec.type

    def _literal_arg(self, function: str, spec: ArgSpec, node: Node) -> int | str:
        if spec.type == ValueType.NUMBER:
            if not isinstance(node, Number) or node.text.endswith("%"):
                raise ExpressionError(
                    f"{spec.name} of {function} must be a whole number{_range_text(spec)}, "
                    "written as a literal",
                    node.column,
                )
            value = node.value
            if value != value.to_integral_value():
                raise ExpressionError(
                    f"{spec.name} of {function} must be a whole number, got {node.text}",
                    node.column,
                )
            number = int(value)
            if (spec.minimum is not None and number < spec.minimum) or (
                spec.maximum is not None and number > spec.maximum
            ):
                raise ExpressionError(
                    f"{spec.name} of {function} must be{_range_text(spec)}, got {number}",
                    node.column,
                )
            return number
        if not isinstance(node, String):
            raise ExpressionError(
                f'{spec.name} of {function} must be text in quotes, e.g. {function}("x")',
                node.column,
            )
        text = node.value.strip()
        if not text:
            raise ExpressionError(f"{spec.name} of {function} must not be empty", node.column)
        if spec.choices is not None and text not in spec.choices:
            raise ExpressionError(
                f'Unknown {spec.name} "{text}"{did_you_mean(text, spec.choices)}; '
                f"known: {', '.join(spec.choices)}",
                node.column,
            )
        return text

    def _compare(self, node: Compare) -> ValueType:
        left = self.type_of(node.left)
        right = self.type_of(node.right)
        if node.op in ("==", "!="):
            if left != right:
                raise ExpressionError(
                    f"'{node.op}' compares values of the same type; {_show(node.left)} is "
                    f"{_article(left)}, {_show(node.right)} is {_article(right)}",
                    node.column,
                )
            if left == ValueType.TEXT:
                self._check_choice(node.left, node.right)
                self._check_choice(node.right, node.left)
            return ValueType.BOOLEAN
        for side, side_type in ((node.left, left), (node.right, right)):
            if side_type != ValueType.NUMBER:
                raise ExpressionError(
                    f"'{node.op}' compares numbers; {_show(side)} is {_article(side_type)}",
                    side.column,
                )
        return ValueType.BOOLEAN

    def _check_choice(self, variable: Node, literal: Node) -> None:
        if not isinstance(variable, Name) or not isinstance(literal, String):
            return
        choices = METRICS[variable.name].choices
        if choices is not None and literal.value not in choices:
            raise ExpressionError(
                f'{variable.name} is never "{literal.value}"{did_you_mean(literal.value, choices)}; '
                f"known: {', '.join(choices)}",
                literal.column,
            )

    def _record(self, ref: MetricRef) -> None:
        self.refs.setdefault(ref.label, ref)


def _expand(spec: MetricSpec, count: int) -> list[ArgSpec]:
    assert spec.args is not None
    if spec.args and spec.args[-1].variadic:
        fixed = list(spec.args[:-1])
        return fixed + [spec.args[-1]] * (count - len(fixed))
    return list(spec.args)


def _arity(spec: MetricSpec) -> str:
    assert spec.args is not None
    if spec.args and spec.args[-1].variadic:
        return f"at least {len(spec.args)} argument(s)"
    if not spec.args:
        return "no arguments"
    return f"{len(spec.args)} argument(s)"


def _range_text(spec: ArgSpec) -> str:
    if spec.minimum is not None and spec.maximum is not None:
        return f" between {spec.minimum} and {spec.maximum}"
    if spec.minimum is not None:
        return f" of at least {spec.minimum}"
    return ""


def _article(value_type: ValueType) -> str:
    return {
        ValueType.NUMBER: "a number",
        ValueType.BOOLEAN: "a condition (true/false)",
        ValueType.TEXT: "text",
    }[value_type]


def _show(node: Node) -> str:
    match node:
        case Name(name=name) | Call(name=name):
            return name
        case Number(text=text):
            return text
        case String(value=value):
            return f'"{value}"'
        case Boolean(value=value):
            return "true" if value else "false"
        case _:
            return f"the part at column {node.column}"
