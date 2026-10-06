"""Hard limits of the custom-rule expression language. They bound parse and evaluation cost, so a hostile
or runaway expression is rejected with a clear error instead of exhausting memory or the stack."""

from __future__ import annotations

from decimal import Decimal

MAX_EXPRESSION_LENGTH = 1000
"""Characters in one ``when`` expression."""

MAX_TOKENS = 200
"""Tokens (numbers, names, operators, parentheses) in one expression."""

MAX_DEPTH = 24
"""Nesting depth of the syntax tree (parentheses, unary operators, function calls, operator chains)."""

MAX_NAME_LENGTH = 64
MAX_NUMBER_LENGTH = 24
MAX_STRING_LENGTH = 100
MAX_FUNCTION_ARGS = 10

MAX_WINDOW_DAYS = 2520
"""Largest price window (bars) a metric function accepts; about ten years of sessions."""

COMPARISON_TOLERANCE = Decimal("1e-9")
"""Numbers closer than this compare as equal, so a value exactly on a threshold does not fire because of
floating-point noise in derived ratios (the built-in rules use the same tolerance)."""
