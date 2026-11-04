"""Tokenizer of the custom-rule expression language (see EXPRESSIONS.md).

Hand-written, single pass, ASCII only. Every token carries its 1-based column in the expression text.
"""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal
from enum import StrEnum

from .limits import (
    MAX_EXPRESSION_LENGTH,
    MAX_NAME_LENGTH,
    MAX_NUMBER_LENGTH,
    MAX_STRING_LENGTH,
    MAX_TOKENS,
)


class ExpressionError(ValueError):
    """A syntax, type or limit error in an expression, at a 1-based ``column`` of the expression text."""

    def __init__(self, message: str, column: int) -> None:
        super().__init__(message)
        self.message = message
        self.column = column

    def __str__(self) -> str:
        return f"{self.message} (column {self.column})"


class TokenType(StrEnum):
    NUMBER = "number"
    PERCENT = "percent"
    STRING = "string"
    NAME = "name"
    KEYWORD = "keyword"
    OP = "operator"
    LPAREN = "("
    RPAREN = ")"
    COMMA = ","
    END = "end"


KEYWORDS = frozenset({"and", "or", "not", "true", "false"})
COMPARISON_OPERATORS = ("<=", ">=", "==", "!=", "<", ">")
ARITHMETIC_OPERATORS = ("+", "-", "*", "/")

# Two-character sequences that look like other languages' operators, with a hint.
_FOREIGN_OPERATORS = {
    "&&": "Use 'and' instead of '&&'",
    "||": "Use 'or' instead of '||'",
    "**": "Powers are not supported",
    "//": "Integer division is not supported; use '/'",
    "<>": "Use '!=' to compare for inequality",
    "=>": "Use '>=' for 'greater than or equal'",
    "=<": "Use '<=' for 'less than or equal'",
}

_SINGLE_CHAR_HINTS = {
    "=": "Use '==' to compare; assignment is not supported",
    "!": "Use 'not' instead of '!'",
    "&": "Use 'and' instead of '&'",
    "|": "Use 'or' instead of '|'",
    "%": "'%' must directly follow a number (5% = 0.05); the modulo operator is not supported",
    ".": "Attribute access is not supported",
    "[": "Indexing and lists are not supported",
    "]": "Indexing and lists are not supported",
    "{": "Braces are not supported",
    "}": "Braces are not supported",
    "^": "Powers and bit operations are not supported",
    "~": "Bit operations are not supported",
    "@": "The '@' operator is not supported",
    ";": "Only one expression is allowed; ';' is not supported",
    ":": "':' is not supported",
    "\\": "Backslashes are not supported",
    "#": "Comments are not supported",
    "$": "'$' is not supported",
    "?": "'?' is not supported",
    "`": "Backticks are not supported",
}

_WHITESPACE = " \t\r\n"


@dataclass(frozen=True, slots=True)
class Token:
    type: TokenType
    text: str
    column: int
    """1-based column of the first character."""
    value: Decimal | str | None = None
    """Decimal for NUMBER / PERCENT (a percentage already divided by 100), the content for STRING."""


def tokenize(source: str) -> list[Token]:
    """Splits ``source`` into tokens ending with an END token. Raises :class:`ExpressionError`."""
    if len(source) > MAX_EXPRESSION_LENGTH:
        raise ExpressionError(
            f"Expression is too long ({len(source)} characters, max {MAX_EXPRESSION_LENGTH})", 1
        )
    tokens: list[Token] = []
    i = 0
    n = len(source)
    while i < n:
        char = source[i]
        column = i + 1
        if char in _WHITESPACE:
            i += 1
            continue
        if len(tokens) >= MAX_TOKENS:
            raise ExpressionError(
                f"Expression has too many parts (max {MAX_TOKENS} tokens)", column
            )
        if char.isascii() and (char.isdigit() or (char == "." and _digit_at(source, i + 1))):
            token, i = _number(source, i)
            tokens.append(token)
            continue
        if char.isascii() and (char.isalpha() or char == "_"):
            token, i = _name(source, i)
            tokens.append(token)
            continue
        if char in "\"'":
            token, i = _string(source, i)
            tokens.append(token)
            continue
        pair = source[i : i + 2]
        if pair in _FOREIGN_OPERATORS:
            raise ExpressionError(_FOREIGN_OPERATORS[pair], column)
        if pair in COMPARISON_OPERATORS:
            tokens.append(Token(TokenType.OP, pair, column))
            i += 2
            continue
        if char in "<>" or char in ARITHMETIC_OPERATORS:
            tokens.append(Token(TokenType.OP, char, column))
            i += 1
            continue
        if char == "(":
            tokens.append(Token(TokenType.LPAREN, char, column))
            i += 1
            continue
        if char == ")":
            tokens.append(Token(TokenType.RPAREN, char, column))
            i += 1
            continue
        if char == ",":
            tokens.append(Token(TokenType.COMMA, char, column))
            i += 1
            continue
        if char in _SINGLE_CHAR_HINTS:
            raise ExpressionError(_SINGLE_CHAR_HINTS[char], column)
        raise ExpressionError(f"Unexpected character {_describe_char(char)}", column)
    tokens.append(Token(TokenType.END, "", n + 1))
    return tokens


def _digit_at(source: str, index: int) -> bool:
    return index < len(source) and source[index].isascii() and source[index].isdigit()


def _number(source: str, start: int) -> tuple[Token, int]:
    i = start
    n = len(source)
    while i < n and _digit_at(source, i):
        i += 1
    if i < n and source[i] == ".":
        if not _digit_at(source, i + 1):
            raise ExpressionError("A decimal point must be followed by digits (e.g. 0.5)", i + 1)
        i += 1
        while i < n and _digit_at(source, i):
            i += 1
        if i < n and source[i] == ".":
            raise ExpressionError("A number can have only one decimal point", i + 1)
    text = source[start:i]
    if len(text) > MAX_NUMBER_LENGTH:
        raise ExpressionError(f"Number is too long (max {MAX_NUMBER_LENGTH} characters)", start + 1)
    if (
        i < n
        and source[i] in "eE"
        and (_digit_at(source, i + 1) or source[i + 1 : i + 2] in ("+", "-"))
    ):
        raise ExpressionError("Scientific notation is not supported; write the number out", i + 1)
    if i < n and source[i].isascii() and (source[i].isalnum() or source[i] == "_"):
        raise ExpressionError(f'Invalid number "{text}{source[i]}..."', start + 1)
    value = Decimal(text)
    if i < n and source[i] == "%":
        return Token(TokenType.PERCENT, text + "%", start + 1, value / 100), i + 1
    return Token(TokenType.NUMBER, text, start + 1, value), i


def _name(source: str, start: int) -> tuple[Token, int]:
    i = start
    n = len(source)
    while i < n and source[i].isascii() and (source[i].isalnum() or source[i] == "_"):
        i += 1
    text = source[start:i]
    if text.startswith("_"):
        raise ExpressionError(
            f'Names cannot start with "_" (got "{text[:MAX_NAME_LENGTH]}")', start + 1
        )
    if len(text) > MAX_NAME_LENGTH:
        raise ExpressionError(f"Name is too long (max {MAX_NAME_LENGTH} characters)", start + 1)
    kind = TokenType.KEYWORD if text in KEYWORDS else TokenType.NAME
    return Token(kind, text, start + 1), i


def _string(source: str, start: int) -> tuple[Token, int]:
    quote = source[start]
    i = start + 1
    n = len(source)
    while i < n and source[i] != quote:
        char = source[i]
        if char in "\r\n":
            raise ExpressionError(
                "Text must end on the same line (missing closing quote)", start + 1
            )
        if char == "\\":
            raise ExpressionError("Backslash escapes are not supported in text", i + 1)
        if not char.isprintable():
            raise ExpressionError(f"Unexpected character {_describe_char(char)} in text", i + 1)
        i += 1
    if i >= n:
        raise ExpressionError(f"Missing closing quote {quote}", start + 1)
    content = source[start + 1 : i]
    if len(content) > MAX_STRING_LENGTH:
        raise ExpressionError(f"Text is too long (max {MAX_STRING_LENGTH} characters)", start + 1)
    return Token(TokenType.STRING, source[start : i + 1], start + 1, content), i + 1


def _describe_char(char: str) -> str:
    if char.isascii() and char.isprintable():
        return f'"{char}"'
    return f"U+{ord(char):04X}"
