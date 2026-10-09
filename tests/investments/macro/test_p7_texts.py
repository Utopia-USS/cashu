"""Macro card texts (P7), pure: a summary and an explanation for every regime and state (plain
Polish, within the length, no forecast words), the open-ended / unknown since, the dollar card with
the portfolio's weekly currency effect, the inverted curve, a missing card, the weekly USD/PLN change
and the summary vocabulary check. Synthetic input only."""

from __future__ import annotations

import datetime as dt

import pytest

from cashu.modules.investments.macro import regimes as rg
from cashu.modules.investments.macro import texts as tx

SINCE = dt.date(2025, 5, 12)
FORBIDDEN = ("wzrośnie", "spadnie", "będzie", "prognoz")

METRICS = {
    "risk": [("ACWI wobec 200 sesji", 0.04, "pct"), ("od szczytu", -0.017, "pct")],
    "dollar": [("DXY", 98.4, "level"), ("6 mies.", 0.041, "pct"), ("USD/PLN 6 mies.", 0.02, "pct")],
    "em": [("EEM wobec ACWI 6 mies.", 6.2, "pp"), ("EEM 6 mies.", 0.081, "pct")],
    "commodities": [("DBC 12 mies.", 0.5, "pct"), ("wobec ACWI 12 mies.", 32.1, "pp")],
    "rates": [
        ("USA 10 lat", 4.62, "level"),
        ("3 mies. zmiana", 45, "bp"),
        ("krzywa 10l-3m", 20, "bp"),
    ],
}


def regime(key: str, state: str, *, metrics=None, **changes) -> rg.Regime:
    label, tone = rg.STATES[key][state]
    data = {
        "key": key,
        "label": rg.LABELS[key],
        "state": state,
        "state_label": label,
        "tone": tone,
        "since": SINCE,
        "metrics": tuple(
            rg.Metric(lbl, v, unit)
            for lbl, v, unit in (METRICS[key] if metrics is None else metrics)
        ),
        "as_of": dt.date(2026, 10, 9),
        "stale": False,
        "missing": False,
        "meaning": rg.MEANINGS[key][state],
    }
    data.update(changes)
    return rg.Regime(**data)


ALL = [(key, state) for key, states in rg.STATES.items() for state in states]


@pytest.mark.parametrize(("key", "state"), ALL)
def test_every_state_has_a_short_plain_summary_and_a_full_explanation(key, state):
    r = regime(key, state, usdpln_1w=0.006)
    text = tx.summary(r, tx.CurrencyEffect(0.006, True))
    assert text.endswith(".") and "od maja 2025" in text
    assert len(text) <= tx.SUMMARY_MAX, text
    assert tx.summary_ok(text), text
    full = tx.explain(r)
    assert full.startswith(tx.INTRO[key]) and tx.RULE[key] in full
    assert full.endswith(f"Teraz: {r.state_label}. {r.meaning}")
    assert 4 <= full.count(". ") + 1 <= 8
    for word in FORBIDDEN:
        assert word not in text.lower() and word not in full.lower()
    assert "\u2014" not in text + full  # no em dash


def test_summaries_hand_checked():
    assert (
        tx.summary(regime("risk", "bull"))
        == "Akcje na świecie rosną od maja 2025: są 1,7 % pod rocznym szczytem."
    )
    weak = regime("risk", "weak", metrics=[("od szczytu", -0.062, "pct")])
    assert tx.summary(weak) == (
        "Akcje na świecie słabną od maja 2025: są pod średnią z 200 sesji i 6,2 % pod rocznym "
        "szczytem."
    )
    top = regime("risk", "bull", metrics=[("od szczytu", 0.0, "pct")])
    assert tx.summary(top) == "Akcje na świecie rosną od maja 2025: są na rocznym szczycie."
    bear = regime("risk", "bear", metrics=[("od szczytu", -0.241, "pct")])
    assert (
        tx.summary(bear) == "Akcje na świecie w bessie od maja 2025: są 24 % pod rocznym szczytem."
    )
    assert tx.summary(regime("commodities", "bull")) == (
        "Surowce drożeją od maja 2025: +50 % w rok, o 32,1 pp więcej niż akcje na świecie."
    )
    lagging = regime(
        "em",
        "lagging",
        metrics=[("EEM wobec ACWI 6 mies.", -7.0, "pp"), ("EEM 6 mies.", -0.02, "pct")],
    )
    assert tx.summary(lagging) == (
        "Rynki wschodzące radzą sobie gorzej niż świat od maja 2025: w pół roku -2,0 %, o 7,0 pp "
        "mniej niż akcje globalne."
    )
    assert tx.summary(regime("rates", "rising")) == (
        "Rentowności obligacji USA rosną od maja 2025: 10-letnie 4,62 %, +0,45 pp w 3 miesiące."
    )


def test_dollar_folds_in_the_currency_effect():
    strong = regime("dollar", "strong", usdpln_1w=0.006)
    assert tx.summary(strong, tx.CurrencyEffect(0.006, True)) == (
        "Dolar umacnia się od maja 2025: indeks dolara +4,1 % w pół roku. W tym tygodniu "
        "USD/PLN +0,6 %, a kursy walut dodały portfelowi 0,6 pp."
    )
    flat = regime("dollar", "flat", usdpln_1w=0.006)  # 146 characters with the half-year detail
    assert tx.summary(flat, tx.CurrencyEffect(0.006, True)) == (
        "Dolar bez wyraźnego trendu od maja 2025. W tym tygodniu USD/PLN +0,6 %, a kursy walut "
        "dodały portfelowi 0,6 pp."
    )
    assert tx.summary(flat, tx.CurrencyEffect(-0.0042, True)).endswith(
        "a kursy walut odjęły portfelowi 0,4 pp."
    )
    assert tx.summary(flat, tx.CurrencyEffect(0.0001, True)).endswith(
        "a kursy walut prawie nie zmieniły wyniku portfela."
    )
    # no foreign assets or no portfolio: the market fact only
    assert tx.summary(flat, tx.CurrencyEffect(0.0, False)).endswith(
        "W tym tygodniu USD/PLN +0,6 %."
    )
    assert tx.summary(flat).endswith("W tym tygodniu USD/PLN +0,6 %.")
    # no weekly rate: the currency effect alone
    no_rate = regime("dollar", "strong")
    assert tx.summary(no_rate, tx.CurrencyEffect(0.006, True)).endswith(
        "W tym tygodniu kursy walut dodały portfelowi 0,6 pp."
    )
    assert tx.summary(no_rate) == "Dolar umacnia się od maja 2025: indeks dolara +4,1 % w pół roku."
    # too long with the half-year detail: it gives way
    long = regime(
        "dollar",
        "flat",
        since=None,
        since_open=True,
        since_min=dt.date(2021, 10, 4),
        usdpln_1w=0.006,
    )
    text = tx.summary(long, tx.CurrencyEffect(0.006, True))
    assert "w pół roku" not in text and len(text) <= tx.SUMMARY_MAX
    assert text.startswith("Dolar bez wyraźnego trendu co najmniej od października 2021.")


def test_inverted_curve_open_since_and_missing():
    inverted = regime("rates", "stable", flags=(rg.INVERTED,))
    text = tx.summary(inverted)
    assert text.endswith(tx.INVERTED_SENTENCE) and len(text) <= tx.SUMMARY_MAX
    open_ended = regime("risk", "bull", since=None, since_open=True, since_min=dt.date(2022, 10, 3))
    assert tx.summary(open_ended).startswith(
        "Akcje na świecie rosną co najmniej od października 2022:"
    )
    unknown = regime("em", "inline", since=None)
    assert tx.summary(unknown).startswith("Rynki wschodzące idą podobnie jak świat: ")
    missing = rg.evaluate({}, dt.date(2026, 10, 9))
    assert {tx.summary(r) for r in missing} == {tx.UNKNOWN_SUMMARY}
    assert all(tx.explain(r).endswith(rg.UNKNOWN_MEANING) for r in missing)
    no_metrics = regime("commodities", "flat", metrics=[])
    assert tx.summary(no_metrics) == "Surowce bez wyraźnego trendu od maja 2025."


OPEN_OCTOBER = {"since": None, "since_open": True, "since_min": dt.date(2025, 10, 1)}
LONG_METRICS = {
    "risk": [("od szczytu", -0.099, "pct")],
    "dollar": [("6 mies.", -0.099, "pct")],
    "em": [("EEM 6 mies.", -0.099, "pct"), ("EEM wobec ACWI 6 mies.", -32.15, "pp")],
    "commodities": [("DBC 12 mies.", -0.099, "pct"), ("wobec ACWI 12 mies.", -32.15, "pp")],
    "rates": [("USA 10 lat", 14.62, "level"), ("3 mies. zmiana", -125, "bp")],
}


@pytest.mark.parametrize(("key", "state"), ALL)
@pytest.mark.parametrize("flags", [(), (rg.INVERTED,)])
@pytest.mark.parametrize(
    "currency", [None, tx.CurrencyEffect(0.0, True), tx.CurrencyEffect(-0.0123, True)]
)
def test_open_ended_summaries_stay_within_the_length_in_every_state(key, state, flags, currency):
    r = regime(
        key, state, metrics=LONG_METRICS[key], flags=flags, usdpln_1w=-0.0123, **OPEN_OCTOBER
    )
    text = tx.summary(r, currency)
    assert len(text) <= tx.SUMMARY_MAX, text
    assert tx.summary_ok(text), text
    assert "od października 2025" not in text or "co najmniej od października 2025" in text


def test_a_long_open_ended_summary_drops_its_since_phrase():
    # rates + inverted curve: 149 characters with "co najmniej od października 2025"
    rates = regime("rates", "stable", flags=(rg.INVERTED,), **OPEN_OCTOBER)
    assert tx.summary(rates) == (
        "Rentowności obligacji USA stabilne: 10-letnie 4,62 %, +0,45 pp w 3 miesiące. "
        + tx.INVERTED_SENTENCE
    )
    # the dollar with the ~0 currency effect: 142 characters with the since phrase
    dollar = regime("dollar", "flat", usdpln_1w=-0.0123, **OPEN_OCTOBER)
    text = tx.summary(dollar, tx.CurrencyEffect(0.0, True))
    assert text == (
        "Dolar bez wyraźnego trendu. W tym tygodniu USD/PLN -1,2 %, a kursy walut prawie nie "
        "zmieniły wyniku portfela."
    )
    # short enough: the open-ended phrase stays
    risk = regime("risk", "weak", metrics=LONG_METRICS["risk"], **OPEN_OCTOBER)
    assert "co najmniej od października 2025" in tx.summary(risk)


def test_weekly_usdpln_change_on_the_dollar_card():
    as_of = dt.date(2026, 10, 9)
    days = [as_of - dt.timedelta(days=i) for i in range(400, -1, -1)]
    closes = {
        "dxy": [(d, 100.0) for d in days],
        "usdpln": [(d, 4.0 if d <= as_of - dt.timedelta(days=7) else 4.1) for d in days],
    }
    dollar = rg.evaluate(closes, as_of)[1]
    assert round(dollar.usdpln_1w, 6) == 0.025
    stale = {
        "dxy": closes["dxy"],
        "usdpln": [(d, v) for d, v in closes["usdpln"] if d < as_of - dt.timedelta(days=10)],
    }
    assert rg.evaluate(stale, as_of)[1].usdpln_1w is None


def test_vocabulary_check():
    assert tx.summary_ok(tx.UNKNOWN_SUMMARY)
    assert not tx.summary_ok("1234567")
    assert not tx.summary_ok("Jan Kowalski rosną.")
    assert not tx.summary_ok("Dolar słabnie: 12 400 zł.")
    assert not tx.summary_ok(None)
