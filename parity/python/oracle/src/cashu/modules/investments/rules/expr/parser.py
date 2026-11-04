"""Recursive-descent parser of the custom-rule expression language (grammar in EXPRESSIONS.md).

Produces an immutable syntax tree. Precedence, lowest first: ``or``, ``and``, ``not``, comparisons
(non-associative: ``a < b < c`` is an error), ``+ -``, ``* /``, unary ``- +``, primaries.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from decimal import Decimal

from .lexer import COMPARISON_OPERATORS, ExpressionError, Token, TokenType, tokenize
from .limits import MAX_DEPTH, MAX_FUNCTION_ARGS


@dataclass(frozen=True, slots=True)
class Number:
    value: Decimal
    text: str
    column: int


@dataclass(frozen=True, slots=True)
class String:
    value: str
    column: int


@dataclass(frozen=True, slots=True)
class Boolean:
    value: bool
    column: int


@dataclass(frozen=True, slots=True)
class Name:
    name: str
    column: int


@dataclass(frozen=True, slots=True)
class Call:
    name: str
    args: tuple[Node, ...]
    column: int


@dataclass(frozen=True, slots=True)
class Unary:
    op: str
    """``-``, ``+`` or ``not``."""
    operand: Node
    column: int


@dataclass(frozen=True, slots=True)
class Binary:
    op: str
    """``+``, ``-``, ``*`` or ``/``."""
    left: Node
    right: Node
    column: int
    """Column of the operator."""


@dataclass(frozen=True, slots=True)
class Compare:
    op: str
    """``<``, ``<=``, ``>``, ``>=``, ``==`` or ``!=``."""
    left: Node
    right: Node
    column: int
    """Column of the operator."""


@dataclass(frozen=True, slots=True)
class Logical:
    op: str
    """``and`` or ``or``; n-ary so long chains stay shallow."""
    operands: tuple[Node, ...]
    column: int
    """Column of the first operator."""


Node = Number | String | Boolean | Name | Call | Unary | Binary | Compare | Logical


def parse(source: str) -> Node:
    """Tokenizes and parses ``source``. Raises :class:`ExpressionError` with a 1-based column."""
    tokens = tokenize(source)
    if tokens[0].type == TokenType.END:
        raise ExpressionError("Expression is empty", 1)
    node = _Parser(tokens).parse()
    _check_depth(node)
    return node


def children(node: Node) -> tuple[Node, ...]:
    """Direct sub-expressions of ``node``."""
    match node:
        case Call(args=args):
            return args
        case Unary(operand=operand):
            return (operand,)
        case Binary(left=left, right=right) | Compare(left=left, right=right):
            return (left, right)
        case Logical(operands=operands):
            return operands
        case _:
            return ()


def _check_depth(root: Node) -> None:
    stack: list[tuple[Node, int]] = [(root, 1)]
    while stack:
        node, depth = stack.pop()
        if depth > MAX_DEPTH:
            raise ExpressionError(
                f"Expression is nested too deeply (max {MAX_DEPTH} levels)", node.column
            )
        stack.extend((child, depth + 1) for child in children(node))


class _Parser:
    def __init__(self, tokens: list[Token]) -> None:
        self._tokens = tokens
        self._pos = 0
        self._depth = 0

    def parse(self) -> Node:
        node = self._or()
        token = self._peek()
        if token.type != TokenType.END:
            raise ExpressionError(
                f"Unexpected {_describe(token)} after a complete expression", token.column
            )
        return node

    # --- precedence levels ---------------------------------------------------------------------

    def _or(self) -> Node:
        return self._logical("or", self._and)

    def _and(self) -> Node:
        return self._logical("and", self._not)

    def _logical(self, op: str, operand: Callable[[], Node]) -> Node:
        first = operand()
        operands = [first]
        column = 0
        while self._is_keyword(op):
            token = self._advance()
            column = column or token.column
            operands.append(operand())
        if len(operands) == 1:
            return first
        return Logical(op, tuple(operands), column)

    def _not(self) -> Node:
        if self._is_keyword("not"):
            token = self._advance()
            self._enter(token.column)
            try:
                return Unary("not", self._not(), token.column)
            finally:
                self._depth -= 1
        return self._comparison()

    def _comparison(self) -> Node:
        left = self._additive()
        token = self._peek()
        if token.type != TokenType.OP or token.text not in COMPARISON_OPERATORS:
            return left
        self._advance()
        right = self._additive()
        node = Compare(token.text, left, right, token.column)
        following = self._peek()
        if following.type == TokenType.OP and following.text in COMPARISON_OPERATORS:
            raise ExpressionError(
                "Chained comparisons are not supported; combine them with 'and'", following.column
            )
        return node

    def _additive(self) -> Node:
        node = self._multiplicative()
        while self._is_op("+", "-"):
            token = self._advance()
            node = Binary(token.text, node, self._multiplicative(), token.column)
        return node

    def _multiplicative(self) -> Node:
        node = self._unary()
        while self._is_op("*", "/"):
            token = self._advance()
            node = Binary(token.text, node, self._unary(), token.column)
        return node

    def _unary(self) -> Node:
        if self._is_op("-", "+"):
            token = self._advance()
            self._enter(token.column)
            try:
                return Unary(token.text, self._unary(), token.column)
            finally:
                self._depth -= 1
        return self._primary()

    def _primary(self) -> Node:
        token = self._advance()
        match token.type:
            case TokenType.NUMBER | TokenType.PERCENT:
                assert isinstance(token.value, Decimal)
                return Number(token.value, token.text, token.column)
            case TokenType.STRING:
                assert isinstance(token.value, str)
                return String(token.value, token.column)
            case TokenType.KEYWORD if token.text in ("true", "false"):
                return Boolean(token.text == "true", token.column)
            case TokenType.KEYWORD if token.text == "not":
                raise ExpressionError(
                    "'not' must be put in parentheses here, e.g. 1 + (not x)", token.column
                )
            case TokenType.NAME:
                if self._peek().type == TokenType.LPAREN:
                    return self._call(token)
                return Name(token.text, token.column)
            case TokenType.LPAREN:
                self._enter(token.column)
                try:
                    inner = self._or()
                finally:
                    self._depth -= 1
                closing = self._peek()
                if closing.type != TokenType.RPAREN:
                    raise ExpressionError(
                        f"Missing ')' for the '(' at column {token.column}; found {_describe(closing)}",
                        closing.column,
                    )
                self._advance()
                return inner
            case TokenType.END:
                raise ExpressionError(
                    "Expression ended unexpectedly; expected a value", token.column
                )
            case _:
                raise ExpressionError(f"Expected a value, found {_describe(token)}", token.column)

    def _call(self, name: Token) -> Node:
        opening = self._advance()
        self._enter(opening.column)
        try:
            args: list[Node] = []
            if self._peek().type != TokenType.RPAREN:
                while True:
                    if len(args) >= MAX_FUNCTION_ARGS:
                        raise ExpressionError(
                            f"Too many arguments for {name.text} (max {MAX_FUNCTION_ARGS})",
                            self._peek().column,
                        )
                    args.append(self._or())
                    if self._peek().type != TokenType.COMMA:
                        break
                    self._advance()
        finally:
            self._depth -= 1
        closing = self._peek()
        if closing.type != TokenType.RPAREN:
            raise ExpressionError(
                f"Missing ')' to close {name.text}( at column {opening.column}; found {_describe(closing)}",
                closing.column,
            )
        self._advance()
        return Call(name.text, tuple(args), name.column)

    # --- helpers -------------------------------------------------------------------------------

    def _enter(self, column: int) -> None:
        self._depth += 1
        if self._depth > MAX_DEPTH:
            raise ExpressionError(
                f"Expression is nested too deeply (max {MAX_DEPTH} levels)", column
            )

    def _peek(self) -> Token:
        return self._tokens[self._pos]

    def _advance(self) -> Token:
        token = self._tokens[self._pos]
        if token.type != TokenType.END:
            self._pos += 1
        return token

    def _is_keyword(self, keyword: str) -> bool:
        token = self._peek()
        return token.type == TokenType.KEYWORD and token.text == keyword

    def _is_op(self, *ops: str) -> bool:
        token = self._peek()
        return token.type == TokenType.OP and token.text in ops


def _describe(token: Token) -> str:
    if token.type == TokenType.END:
        return "the end of the expression"
    return f"'{token.text}'"
