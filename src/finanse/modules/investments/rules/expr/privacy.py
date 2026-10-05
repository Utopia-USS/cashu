"""Which number literals of an expression are personal amounts (strict MCP privacy, F6 review V3). Pure.

A custom condition such as ``cash_value < 800`` carries the owner's buffer in its literal. A literal is
kept only when it is clearly not money:

- a percent literal (``20%``);
- a literal argument of a metric function (a window length, ``drawdown_from_high(252)``);
- a literal inside a comparison whose metrics are all ratios, percentage points, days or counts
  (``weight < 0.03``, ``days_since_last_deposit > 45``), or prices of a public instrument (a market
  level, ``last_close > 120``).

Everything else is treated as an amount: a comparison with any amount metric (``cash_value``,
``total_value``, ``value``, ...), with an owner-named instrument's price, or without a metric. An
expression that does not parse loses every bare number.
"""

from __future__ import annotations

import re

from .catalog import METRICS, Unit
from .lexer import ExpressionError
from .parser import Call, Compare, Name, Node, Number, children, parse

AMOUNT_PLACEHOLDER = "[amount]"
_NON_MONEY = frozenset({Unit.RATIO, Unit.PP, Unit.DAYS, Unit.COUNT, Unit.FLAG, Unit.TEXT})
_BARE_NUMBER = re.compile(r"(?<![\w.])\d+(?:\.\d+)?|(?<![\w.])\.\d+")


def _units(node: Node) -> list[Unit | None]:
    out: list[Unit | None] = []
    stack = [node]
    while stack:
        current = stack.pop()
        if isinstance(current, (Name, Call)):
            spec = METRICS.get(current.name)
            out.append(spec.unit if spec is not None else None)
            continue  # literal arguments of a call are never compared
        stack.extend(children(current))
    return out


def _numbers(node: Node) -> list[Number]:
    """Number literals under ``node`` that are not metric-function arguments."""
    out: list[Number] = []
    stack = [node]
    while stack:
        current = stack.pop()
        if isinstance(current, Number):
            out.append(current)
        elif not isinstance(current, Call):
            stack.extend(children(current))
    return out


def _safe(units: list[Unit | None], private_prices: bool) -> bool:
    if not units:
        return False
    for unit in units:
        if unit in _NON_MONEY:
            continue
        if unit == Unit.PRICE and not private_prices:
            continue
        return False
    return True


def amount_literals(source: str, *, private_prices: bool = False) -> list[Number] | None:
    """The number literals of ``source`` that count as amounts (None when it does not parse)."""
    try:
        tree = parse(source)
    except ExpressionError:
        return None
    flagged: list[Number] = []
    stack: list[tuple[Node, bool]] = [(tree, False)]
    while stack:
        node, in_compare = stack.pop()
        if isinstance(node, Compare):
            safe = _safe(_units(node), private_prices)
            flagged.extend(n for n in _numbers(node) if not safe and not n.text.endswith("%"))
            continue
        if isinstance(node, Number) and not in_compare and not node.text.endswith("%"):
            flagged.append(node)  # a bare literal outside any comparison: no context
            continue
        if isinstance(node, Call):
            continue
        stack.extend((child, in_compare) for child in children(node))
    return flagged


def scrub_amount_literals(
    source: str, *, private_prices: bool = False, placeholder: str = AMOUNT_PLACEHOLDER
) -> str:
    """``source`` with every amount literal replaced by ``placeholder`` (see the module doc)."""
    flagged = amount_literals(source, private_prices=private_prices)
    if flagged is None:
        return _BARE_NUMBER.sub(
            lambda m: m.group(0) if source[m.end() : m.end() + 1] == "%" else placeholder, source
        )
    out = source
    for number in sorted(flagged, key=lambda n: n.column, reverse=True):
        start = number.column - 1
        end = start + len(number.text)
        if out[start:end] == number.text:
            out = out[:start] + placeholder + out[end:]
    return out
