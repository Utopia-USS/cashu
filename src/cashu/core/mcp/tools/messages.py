"""System messages in tool answers under the privacy level (F5 R6).

Portfolio warnings and strategy / rule validation issues are English sentences built from data: a
history gap names the missing quantity, a cash gap the negative balance, a strategy issue may quote a
value from the owner's file. The redactor's text scrub is pattern-based (money words, currency codes,
decimals), so a bare quantity or a whole-number balance could pass it. In strict mode such a message
therefore loses every number except dates (``2026-03-02``), percentages and percentage points
(``37.3%``, ``5 pp``), list indexes (``rules[3]``) and positions in a file (``line 12``). The stable
code of the message (a warning's ``kind``, an issue's ``code``) travels next to it, so the agent still
knows what it is about. Amounts mode sends the message as it is (the redactor still runs).

S37fix3 E2: in strict mode a message never quotes a number: a quoted part with a digit becomes
``"#"`` (``Invalid number "800k..."`` -> ``Invalid number "#"``, the column stays), a number glued to
letters (``800k``, ``_800000``) is a number when it has 2+ digits (the N9 rule: ``IS3N`` stays), and only a percentage with at most 3
integer digits is kept (the R1 / N1 rule). E4: the quoted text of a custom condition (a tag, a
symbol) goes through the free-text scrub (identifiers and strict amounts).
"""

from __future__ import annotations

import re

from .. import labels as L
from ..redaction import scrub_text
from ..registry import ToolContext

_NUMBER_OR_KEPT = re.compile(
    r"(?P<keep>"
    r"\b\d{4}-\d{2}-\d{2}\b"  # ISO dates
    r"|\[\d+\]"  # list indexes: rules[3]
    r"|\b(?:rows?|lines?|columns?)\s+\d+\b"  # positions in a file
    r"|(?<![\w.,])[-+]?\d{1,3}(?:[.,]\d+)?\s?(?:%|pp\b)"  # percentages / percentage points
    r")"
    r"|(?P<number>(?:(?<![\w.,])[-+])?(?<!\d)(?<!\d[.,])\d+(?:[  ,.]\d{3})*(?:[.,]\d+)?(?:[eE][-+]?\d+)?(?!\d))"
)
_QUOTED = re.compile(r'"[^"]*"')
_DIGIT = re.compile(r"\d")
# a text literal of a custom condition (the lexer has no escapes: a quote ends it)
_CONDITION_TEXT = re.compile(r"\"[^\"]*\"|'[^']*'")


def scrub_numbers(text: str) -> str:
    """``text`` with every number replaced by ``#`` except dates, percentages, indexes and file
    positions; a quoted part with a digit becomes ``"#"``."""
    text = _QUOTED.sub(lambda m: '"#"' if _DIGIT.search(m.group(0)) else m.group(0), text)

    def glued(i: int) -> bool:
        return 0 <= i < len(text) and (text[i].isalpha() or text[i] == "_")

    def replace(m: re.Match) -> str:
        if m.group("keep"):
            return m.group("keep")
        if (glued(m.start() - 1) or glued(m.end())) and len(_DIGIT.findall(m.group(0))) < 2:
            return m.group(0)  # one digit in a word ("IS3N", "rules_3") is not a quantity
        return "#"

    return _NUMBER_OR_KEPT.sub(replace, text)


def _scrub_condition(text: str, private: bool) -> str:
    """A custom condition in strict mode: amount literals (see :func:`custom_condition`), then the
    free-text scrub inside each text literal (E4)."""
    from cashu.modules.investments.rules.expr.privacy import scrub_amount_literals

    scrubbed = scrub_amount_literals(text, private_prices=private)
    return _CONDITION_TEXT.sub(
        lambda m: m.group(0)[0] + str(scrub_text(m.group(0)[1:-1], strict=True)) + m.group(0)[-1],
        scrubbed,
    )


def system_text(ctx: ToolContext, text: str | None) -> L.Labelled:
    """A system-built message as a text label: numbers scrubbed in strict mode."""
    if text is None or not ctx.strict:
        return L.text(text)
    return L.text(scrub_numbers(text))


def custom_condition(ctx: ToolContext, text: str | None, *, private: bool = False) -> L.Labelled:
    """A custom condition (alert ``expression``, custom signal ``when``) as text: in strict mode its
    number literals compared with amounts (or with an owner-named instrument's price) become
    ``[amount]``; percentages, ratios, day counts, window arguments and public price levels stay
    (F6 review V3); the quoted text inside goes through the free-text scrub (S37fix3 E4)."""
    if text is None or not ctx.strict:
        return L.text(text)
    return L.text(_scrub_condition(str(text), private))


def custom_signal_message(
    ctx: ToolContext, message: str | None, when: str | None, *, private: bool = False
) -> L.Labelled:
    """The message of a custom signal ("<title>: Warunek spełniony: <when> (<values>).", the rule
    engine's Polish text; the condition is the normalized ``when`` verbatim, so the message splits on
    it): in strict mode the condition inside it is scrubbed like :func:`custom_condition` and every
    other number outside dates and percentages (``12,3 %``, ``7,5 pp``) is removed (the title and the
    owner's message are free text)."""
    if message is None or not ctx.strict:
        return L.text(message)
    text = str(message)
    if when:
        normalized = " ".join(str(when).split())
        scrubbed = _scrub_condition(normalized, private)
        parts = text.split(normalized)
        return L.text(scrubbed.join(scrub_numbers(p) for p in parts))
    return L.text(scrub_numbers(text))
