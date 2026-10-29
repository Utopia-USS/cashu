"""Macro card texts in English (localization): labels, state labels, meanings, metric labels and
numbers, summaries within the length, plain sentences and explanations; the Polish vocabulary check
stays Polish whatever the current language. Synthetic input only."""

from __future__ import annotations

from dataclasses import replace

import pytest
from test_p7_texts import ALL, regime

from cashu.core.i18n import use_language
from cashu.modules.investments.macro import regimes as rg
from cashu.modules.investments.macro import service
from cashu.modules.investments.macro import texts as tx

POLISH_LETTERS = set("ąćęłńóśźżĄĆĘŁŃÓŚŹŻ")


@pytest.mark.parametrize(("key", "state"), ALL)
def test_every_state_reads_in_english(key, state):
    r = regime(key, state, usdpln_1w=0.006)
    with use_language("en"):
        card = service.regime_dict(r, tx.CurrencyEffect(0.006, True))
    assert card["label"] == rg.LABELS_EN[key]
    assert card["state_label"] == rg.STATES_EN[key][state]
    assert card["meaning"] == rg.MEANINGS_EN[key][state]
    for text in (card["summary"], card["plain"], card["explain"]):
        assert text.endswith(".") and not POLISH_LETTERS & set(text), text
    assert len(card["summary"]) <= tx.SUMMARY_MAX
    assert "since May 2025" in card["summary"] or len(card["summary"]) > 100
    assert card["explain"].startswith(tx.INTRO_EN[key])


def test_hand_checked_english():
    with use_language("en"):
        assert tx.summary(regime("risk", "bull")) == (
            "Global stocks rising since May 2025: 1.7% below the yearly peak."
        )
        assert tx.summary(regime("em", "leading")) == (
            "Emerging markets doing better than the world since May 2025: +8.1% in six months, "
            "6.2 pp more than global stocks."
        )
        assert tx.summary(regime("rates", "rising")) == (
            "US bond yields rising since May 2025: 10-year 4.62%, +0.45 pp in 3 months."
        )
        r = regime("dollar", "weak")
        assert [service.metric_dict(m)["label"] for m in r.metrics] == [
            "DXY",
            "6 mo.",
            "USD/PLN 6 mo.",
        ]
        assert [m.text for m in r.metrics] == ["98.4", "+4.1%", "+2.0%"]


def test_inverted_curve_and_missing_in_english():
    inverted = regime("rates", "stable", flags=(rg.INVERTED,))
    missing = replace(regime("risk", "bull", metrics=()), missing=True, state=rg.UNKNOWN)
    with use_language("en"):
        assert rg.display_state_label(inverted) == "yields stable · inverted curve"
        assert rg.display_meaning(inverted).endswith(rg.INVERTED_MEANING_EN)
        assert tx.summary(inverted).endswith(tx.INVERTED_SENTENCE_EN)
        assert rg.display_state_label(missing) == "no data"
        assert tx.summary(missing) == tx.UNKNOWN_SUMMARY_EN
        assert tx.plain(missing) == tx.PLAIN_UNKNOWN_EN
    assert rg.display_state_label(inverted) == "rentowności stabilne · krzywa odwrócona"


def test_the_vocabulary_stays_polish():
    tx.vocabulary.cache_clear()
    r = regime("risk", "bull")
    with use_language("en"):
        english = tx.summary(r)
        assert not tx.summary_ok(english)
        assert tx.summary_ok(tx.summary(r)) is False
    assert tx.summary_ok(tx.summary(r))
