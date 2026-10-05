"""System messages in tool answers under the privacy level (F5 R6).

Portfolio warnings and strategy / rule validation issues are English sentences built from data: a
history gap names the missing quantity, a cash gap the negative balance, a strategy issue may quote a
value from the owner's file. The redactor's text scrub is pattern-based (money words, currency codes,
decimals), so a bare quantity or a whole-number balance could pass it. In strict mode such a message
therefore loses every number except dates (``2026-03-02``), percentages and percentage points
(``37.3%``, ``5 pp``), list indexes (``rules[3]``) and positions in a file (``line 12``). The stable
code of the message (a warning's ``kind``, an issue's ``code``) travels next to it, so the agent still
knows what it is about. Amounts mode sends the message as it is (the redactor still runs).
"""

from __future__ import annotations

import re

from .. import labels as L
from ..registry import ToolContext

_NUMBER_OR_KEPT = re.compile(
    r"(?P<keep>"
    r"\b\d{4}-\d{2}-\d{2}\b"  # ISO dates
    r"|\[\d+\]"  # list indexes: rules[3]
    r"|\b(?:rows?|lines?|columns?)\s+\d+\b"  # positions in a file
    r"|(?<![\w.,])[-+]?\d+(?:[.,]\d+)?\s?(?:%|pp\b)"  # percentages / percentage points
    r")"
    r"|(?P<number>(?<![\w.,])[-+]?\d+(?:[  ,.]\d{3})*(?:[.,]\d+)?(?![\w%]))"
)


def scrub_numbers(text: str) -> str:
    """``text`` with every number replaced by ``#`` except dates, percentages, indexes and file
    positions."""
    return _NUMBER_OR_KEPT.sub(lambda m: m.group("keep") or "#", text)


def system_text(ctx: ToolContext, text: str | None) -> L.Labelled:
    """A system-built message as a text label: numbers scrubbed in strict mode."""
    if text is None or not ctx.strict:
        return L.text(text)
    return L.text(scrub_numbers(text))


def custom_condition(ctx: ToolContext, text: str | None, *, private: bool = False) -> L.Labelled:
    """A custom condition (alert ``expression``, custom signal ``when``) as text: in strict mode its
    number literals compared with amounts (or with an owner-named instrument's price) become
    ``[amount]``; percentages, ratios, day counts, window arguments and public price levels stay
    (F6 review V3)."""
    if text is None or not ctx.strict:
        return L.text(text)
    from finanse.modules.investments.rules.expr.privacy import scrub_amount_literals

    return L.text(scrub_amount_literals(str(text), private_prices=private))


def custom_signal_message(
    ctx: ToolContext, message: str | None, when: str | None, *, private: bool = False
) -> L.Labelled:
    """The message of a custom signal ("<title>: Condition met: <when> (<values>)."): in strict mode
    the condition inside it is scrubbed like :func:`custom_condition` and every other number outside
    dates and percentages is removed (the title and the owner's message are free text)."""
    if message is None or not ctx.strict:
        return L.text(message)
    from finanse.modules.investments.rules.expr.privacy import scrub_amount_literals

    text = str(message)
    if when:
        normalized = " ".join(str(when).split())
        scrubbed = scrub_amount_literals(normalized, private_prices=private)
        parts = text.split(normalized)
        return L.text(scrubbed.join(scrub_numbers(p) for p in parts))
    return L.text(scrub_numbers(text))
