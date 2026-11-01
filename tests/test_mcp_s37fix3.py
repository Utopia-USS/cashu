"""S37fix3: long input (the scrub cap and linear time) and the expression literal rules that are not
plain vectors (those are in ``mcp_privacy_vectors.json``). Synthetic text only."""

from __future__ import annotations

import time
from types import SimpleNamespace

import pytest

from cashu.core.mcp.names import NameGuard
from cashu.core.mcp.redaction import (
    MAX_SCRUB_CHARS,
    TRUNCATED,
    identifier_in,
    scrub_text,
)
from cashu.core.mcp.tools.messages import custom_signal_message, scrub_numbers
from cashu.modules.investments.rules.expr.privacy import scrub_amount_literals

GUARD = NameGuard(1, frozenset({"ANNA NOWAK", "JAN KOWALSKI"}))
WORD = "a" * 40_000


def _cpu(fn) -> float:
    """The smallest CPU time of three runs (the first warms the per-character caches)."""
    best = float("inf")
    for _ in range(3):
        start = time.process_time()
        fn()
        best = min(best, time.process_time() - start)
    return best


@pytest.mark.parametrize("strict", [True, False])
@pytest.mark.parametrize("guard", [None, GUARD], ids=["no-guard", "guard"])
def test_a_40k_letter_word_scrubs_in_well_under_100_ms(strict, guard):
    assert scrub_text(WORD, strict=strict, guard=guard) == WORD
    assert _cpu(lambda: scrub_text(WORD, strict=strict, guard=guard)) < 0.1


def test_the_leak_check_and_messages_read_a_40k_letter_word_in_well_under_100_ms():
    assert _cpu(lambda: identifier_in(WORD)) < 0.1
    assert _cpu(lambda: scrub_numbers(WORD)) < 0.1


@pytest.mark.parametrize(
    "unit",
    ["a1 ", "Anna Nowak ", "https://x.pl/a1 ", "a@b.pl ", "dwa lub ", "x.", "ł", "x", "*", "x1"],
)
def test_long_texts_of_repeated_shapes_stay_linear(unit):
    # each of these took seconds (or, "x", far longer) at 40k characters before S37fix3
    text = (unit * 40_000)[:40_000]
    assert _cpu(lambda: scrub_text(text, strict=True, guard=GUARD)) < 1.0


def test_a_string_over_the_cap_is_cut_before_scrubbing():
    head = "x " * (MAX_SCRUB_CHARS // 2 - 10)
    text = head + "karta 4532 0151 1283 0366 dalej"
    out = scrub_text(text, strict=False)
    assert out.endswith(TRUNCATED)
    # the cut drops the split word and the digits before it: no half of the card is left
    assert "4532" not in out
    assert "0151" not in out
    assert len(out) <= MAX_SCRUB_CHARS + len(TRUNCATED)
    assert scrub_text("x" * MAX_SCRUB_CHARS, strict=True) == "x" * MAX_SCRUB_CHARS
    assert scrub_text("x" * (MAX_SCRUB_CHARS + 1), strict=True) == TRUNCATED


def test_names_full_of_a_text_are_all_masked():
    text = "Anna Nowak, " * 3000
    assert scrub_text(text, strict=False, guard=GUARD) == "[name], " * 3000


@pytest.mark.parametrize(
    ("source", "expected"),
    [
        ("weight < 20%", "weight < 20%"),
        ("weight < 999%", "weight < 999%"),
        ("value < 999%", "value < 999%"),
        ("value < 1000%", "value < [amount]"),
        ("weight < 1000%", "weight < 1000%"),  # a ratio comparison keeps any literal, as before
        ("weight * 100% > 5", "weight * 100% > 5"),
        ("weight * 1000% > 5", "weight * [amount] > [amount]"),
        ("weight > .5%", "weight > .5%"),
        # does not parse: the fallback keeps small percentages only
        ("weight < 20% and (", "weight < 20% and ("),
        ("weight < 2000% and (", "weight < [amount]% and ("),
    ],
)
def test_the_percent_exemption_needs_at_most_three_integer_digits(source, expected):
    assert scrub_amount_literals(source) == expected


def test_the_condition_inside_a_custom_signal_message_scrubs_its_text_literals():
    when = 'holding_has_tag("buffer 800") and cash_value > 80000%'
    message = f"bufor: Warunek spełniony: {when} (cash_value 7 312,00 zł)."
    out = custom_signal_message(SimpleNamespace(strict=True), message, when).value
    assert "800" not in out
    assert "7 312" not in out
    assert 'holding_has_tag("buffer [amount]") and cash_value > [amount]' in out


@pytest.mark.parametrize("unit", ["12 pp ", "5 x ", "row 12 "])
def test_many_small_kept_numbers_stay_linear(unit):
    # S37fix3 D1: the currency check before each kept number read the whole text before it
    # ("12 pp " * 33000: 301 s); it now reads a bounded window. The whole strict scrub of these
    # ~200k characters costs ~1 s of CPU (the per-character passes), not the 100 ms of a 40k word.
    text = unit * (198_000 // len(unit))
    out = scrub_text(text, strict=True)
    assert "[amount]" not in out
    assert _cpu(lambda: scrub_text(text, strict=True)) < 3.0


def test_a_cut_never_leaves_the_first_half_of_a_name():
    head = "x " * (MAX_SCRUB_CHARS // 2 - 4)
    out = scrub_text(head + "Anna Nowak dalej", strict=False)
    assert "Anna" not in out
    assert out.endswith(TRUNCATED)
