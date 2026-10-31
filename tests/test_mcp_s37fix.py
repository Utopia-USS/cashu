"""S37fix: redaction rules that are not plain text vectors (those are in
``mcp_privacy_vectors.json``): count paths, money keys, the merchant the agent was shown, the
original text around masked spans, and the stem over-masking the name rule accepts."""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from cashu.core.mcp import labels as L
from cashu.core.mcp.names import NameGuard
from cashu.core.mcp.redaction import LeakDetected, Redactor, is_money_key, leak_check
from cashu.core.mcp.tools.budget import _shown_as


def test_count_percent_and_ref_labelled_numbers_pass_under_money_like_keys():
    redactor = Redactor("strict")
    tree = {
        "issues_by_kind": {"invalid_value": L.count(2), "amount_mismatch": L.count(1)},
        "fees_share": L.pct(0.25),
        "loan_id": L.ref(7),
        "rows": [L.amount(5), {"missing_value": L.count(3)}],
    }
    out = redactor.apply(tree)
    assert out == {
        "issues_by_kind": {"invalid_value": 2, "amount_mismatch": 1},
        "fees_share": 0.25,
        "loan_id": 7,
        "rows": [{"missing_value": 3}],
    }
    leak_check(out, strict=True, non_money=redactor.non_money)
    with pytest.raises(LeakDetected):  # the same numbers without their labels
        leak_check(out, strict=True)


@pytest.mark.parametrize(
    ("key", "money"),
    [
        ("amount_pln", True),
        ("value_base", True),
        ("saldo_koncowe", True),
        ("monthly_sum", True),
        ("net", True),
        ("summary_max", False),
        ("weight", False),
        ("last_value", False),
        ("network_count", False),
        # S37fix N7: a money word wins over a share / count word
        ("fees_share", True),
        ("cash_weight", True),
        ("income_expense_ratio", True),
        ("expense_vs_average", True),
        ("balances", True),
        ("account_balance", True),
        ("loan_id", True),
        ("limit_pln", True),
    ],
)
def test_money_keys(key, money):
    assert is_money_key(key) is money


def test_set_merchant_category_takes_the_masked_name_it_showed():
    guard = NameGuard(1, frozenset())
    keys = {"SKLEP 123 TEST", "SKLEP 7 TEST", "KIOSK 45", "KIOSK 46"}
    strict = SimpleNamespace(privacy="strict", guard=guard)
    assert _shown_as(strict, "SKLEP [amount] TEST", keys) == "SKLEP 123 TEST"
    assert _shown_as(strict, "KIOSK [amount]", keys) is None  # two merchants look the same
    amounts = SimpleNamespace(privacy="amounts", guard=guard)
    assert _shown_as(amounts, "SKLEP [amount] TEST", keys) is None


# Stem matches of the known name "ANNA NOWAK" / "JAN KOWALSKI" in ordinary words (over-masking the
# spec accepts; listed so a change is visible).
STEM_FALSE_POSITIVES = {
    "Janowi dziekuje": "[name] dziekuje",  # single token "JAN" is a profile token here
    "kowale kuja": "[name] kuja",
    "nowe nowaki": "nowe [name]",
}


@pytest.mark.parametrize(("text", "masked"), sorted(STEM_FALSE_POSITIVES.items()))
def test_stem_matches_mask_common_words_too(text, masked):
    guard = NameGuard(1, frozenset({"ANNA NOWAK", "JAN", "NOWAK", "KOWALSKI"}))
    assert guard.mask(text) == masked


@pytest.mark.parametrize(
    "text", ["nowa kanapa", "Annapurna", "Janusz Kowalczyk", "kowalski styl", "Anna Kowal"]
)
def test_unrelated_words_stay(text):
    guard = NameGuard(1, frozenset({"ANNA NOWAK", "JAN KOWALSKI"}))
    assert guard.mask(text) == text


# S37fix2 N11: a one-word known name of 4+ letters is matched inside letter runs too; these over-masks
# are accepted (listed so a change is visible). Three-letter names (LIS) are not matched inside runs.
GLUED_FALSE_POSITIVES = {
    "Joanna": "Jo[name]",
    "SAVANNA": "SAV[name]",
    "annapurna": "[name]purna",
    "LISTOPAD": "LISTOPAD",
}


@pytest.mark.parametrize(("text", "masked"), sorted(GLUED_FALSE_POSITIVES.items()))
def test_one_word_names_inside_letter_runs(text, masked):
    guard = NameGuard(1, frozenset({"ANNA", "LIS"}))
    assert guard.mask(text) == masked
