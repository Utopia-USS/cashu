"""The F8 alert kinds for a changed situation (home v3 Q12): ``range_breakout`` (the close leaves a
narrow range of the previous sessions) and ``volume_spike`` (volume vs its average). Catalog defaults
and limits, evaluation on synthetic daily bars (fires, does not fire, skips on stale / short / missing
volume data), Polish messages and the message codes. Every value is invented."""

from __future__ import annotations

from dataclasses import replace
from datetime import timedelta

import pytest
from al_fixtures import AS_OF, alert, bars, check, instrument

from finanse.modules.investments.alerts import (
    CATALOG,
    PRICE_KINDS,
    AlertKind,
    AlertValidationError,
    catalog_dicts,
    validate,
)
from finanse.modules.investments.alerts.messages import alert_message
from finanse.modules.investments.rules import Fired, NotFired, Skipped

QUBT = instrument("QUBT", currency="USD")


def flat(n: int, close: str = "10") -> list[str]:
    return [close] * n


def series(closes: list[str], volumes: list[int | None] | None = None, *, last_date=AS_OF):
    out = bars(QUBT, closes, last_date=last_date)
    if volumes is not None:
        out = tuple(replace(b, volume=v) for b, v in zip(out, volumes, strict=True))
    return {QUBT: out}


# --- catalog ------------------------------------------------------------------------------------


def test_catalog_defaults_and_scopes():
    breakout = validate("range_breakout", {}, has_instrument=True)
    assert breakout.params == {"window_days": 30, "max_range_pct": 0.08, "direction": "any"}
    volume = validate("volume_spike", {}, has_instrument=True)
    assert volume.params == {"window_days": 20, "multiple": 2.5}
    assert AlertKind.RANGE_BREAKOUT in PRICE_KINDS and AlertKind.VOLUME_SPIKE in PRICE_KINDS
    listed = {k["kind"]: k for k in catalog_dicts()}
    assert listed["range_breakout"]["unit"] == "price"
    assert listed["volume_spike"]["unit"] == "ratio"
    assert listed["range_breakout"]["scopes"] == ["instrument"]
    params = {p["name"]: p for p in listed["range_breakout"]["params"]}
    assert (params["window_days"]["minimum"], params["window_days"]["maximum"]) == (10, 260)
    assert params["max_range_pct"]["default"] == 0.08
    assert params["direction"]["choices"] == ["up", "down", "any"]
    vparams = {p["name"]: p for p in listed["volume_spike"]["params"]}
    assert (vparams["multiple"]["minimum"], vparams["multiple"]["default"]) == (1.5, 2.5)
    assert CATALOG[AlertKind.VOLUME_SPIKE].scopes[0].value == "instrument"


@pytest.mark.parametrize(
    ("kind", "params", "field"),
    [
        ("range_breakout", {"window_days": 9}, "params.window_days"),
        ("range_breakout", {"window_days": 261}, "params.window_days"),
        ("range_breakout", {"max_range_pct": 0.005}, "params.max_range_pct"),
        ("range_breakout", {"max_range_pct": 8}, "params.max_range_pct"),
        ("range_breakout", {"direction": "sideways"}, "params.direction"),
        ("volume_spike", {"window_days": 4}, "params.window_days"),
        ("volume_spike", {"multiple": 1.2}, "params.multiple"),
        ("volume_spike", {"multiple": 25}, "params.multiple"),
        ("volume_spike", {"multipel": 3}, "params.multipel"),
    ],
)
def test_catalog_limits(kind, params, field):
    with pytest.raises(AlertValidationError) as info:
        validate(kind, params, has_instrument=True)
    assert field in [key for key, _ in info.value.issues]


def test_new_kinds_need_an_instrument():
    with pytest.raises(AlertValidationError, match="need an instrument"):
        validate("range_breakout", {}, has_instrument=False)
    with pytest.raises(AlertValidationError, match="apply to scope instrument"):
        validate("volume_spike", {}, scope="portfolio", has_instrument=False)


# --- range_breakout -----------------------------------------------------------------------------


def breakout(**params):
    return alert(
        "range_breakout", {"window_days": 10, **params}, inst=QUBT, title="QUBT konsolidacja"
    )


def test_breakout_up_out_of_a_narrow_range_fires():
    closes = ["10.50", "11.00", "11.20", "10.80", "10.60", "11.10", "10.90", "11.00", "10.70",
              "10.80", "11.90"]  # fmt: skip
    result = check(breakout(), series=series(closes))
    assert isinstance(result.outcome, Fired), result.outcome
    c = result.outcome.candidate
    assert (c.kind, c.dedup_key) == ("alert:range_breakout", "alert:7")
    p = c.payload
    assert (p["range_low"], p["range_high"], p["close"]) == ("10.5", "11.2", "11.9")
    assert p["breakout_pct"] == pytest.approx(11.9 / 11.2 - 1)
    assert p["range_pct"] == pytest.approx(0.7 / 10.5)
    assert (p["window_days"], p["max_range_pct"], p["direction"]) == (10, 0.08, "any")
    assert (p["currency"], p["price_date"], p["unit"]) == ("USD", AS_OF.isoformat(), "price")
    assert c.message == (
        "QUBT konsolidacja: QUBT: wybicie z konsolidacji 10 sesji, +6,3 % nad 11,2 USD "
        f"(zamknięcie 11,9 USD, {AS_OF})."
    )
    assert float(result.value) == 11.9
    code, params = alert_message(c.kind, c.payload, c.message, "QUBT")
    assert code == "alert.range_breakout"
    assert params["range_high"] == "11.2" and params["date"] == AS_OF.isoformat()
    assert params["breakout_pct"] == p["breakout_pct"] and params["label"] == "QUBT"


def test_a_hair_width_breakout_reads_tuz_not_zero_percent():
    # F8 review BE-7
    closes = ["10.00", "10.40", "10.20", "10.30", "10.10", "10.40", "10.00", "10.20", "10.30",
              "10.10", "10.401"]  # fmt: skip
    result = check(breakout(), series=series(closes))
    assert isinstance(result.outcome, Fired), result.outcome
    assert "sesji, tuż nad 10,4 USD" in result.outcome.candidate.message
    assert "0,0 %" not in result.outcome.candidate.message


def test_breakout_down_and_the_direction_filter():
    closes = [*flat(10, "10"), "9.40"]
    down = check(breakout(), series=series(closes))
    assert isinstance(down.outcome, Fired)
    assert down.outcome.candidate.payload["breakout_pct"] == pytest.approx(-0.06)
    assert "-6,0\u00a0% pod 10 USD" in down.outcome.candidate.message
    only_up = check(breakout(direction="up"), series=series(closes))
    assert isinstance(only_up.outcome, NotFired)
    assert only_up.outcome.details["breakout_pct"] == pytest.approx(-0.06)
    only_down = check(breakout(direction="down"), series=series(closes))
    assert isinstance(only_down.outcome, Fired)


def test_breakout_needs_a_narrow_range_and_a_close_outside_it():
    wide = ["10", "12", *flat(8, "11"), "12.50"]  # range 20 % > 8 %
    result = check(breakout(), series=series(wide))
    assert isinstance(result.outcome, NotFired)
    assert result.outcome.details["range_pct"] == pytest.approx(0.2)
    wider_limit = check(breakout(max_range_pct=0.25), series=series(wide))
    assert isinstance(wider_limit.outcome, Fired)
    inside = check(breakout(), series=series([*flat(10, "10"), "10"]))
    assert isinstance(inside.outcome, NotFired)
    assert inside.outcome.details["breakout_pct"] is None


def test_breakout_never_fires_on_short_or_stale_data():
    short = check(breakout(), series=series(flat(10)))
    assert isinstance(short.outcome, Skipped)
    assert short.outcome.reason == "Tylko 10 z 11 notowań: QUBT"
    stale = check(breakout(), series=series([*flat(10), "12"], last_date=AS_OF - timedelta(days=9)))
    assert isinstance(stale.outcome, Skipped) and "Nieaktualna cena" in stale.outcome.reason


# --- volume_spike -------------------------------------------------------------------------------


def spike(**params):
    return alert("volume_spike", {"window_days": 5, **params}, inst=QUBT, title="QUBT wolumen")


def test_volume_spike_fires_at_the_multiple():
    volumes = [1000, 1200, 800, 1000, 1000, 3400]  # average 1000, ratio 3.4
    result = check(spike(), series=series([*flat(5), "12.10"], volumes))
    assert isinstance(result.outcome, Fired), result.outcome
    c = result.outcome.candidate
    p = c.payload
    assert (p["volume"], p["average_volume"], p["ratio"]) == (3400, 1000.0, 3.4)
    assert (p["multiple"], p["window_days"], p["close"], p["unit"]) == (2.5, 5, "12.1", "ratio")
    assert c.message == (
        f"QUBT wolumen: QUBT: wolumen 3,4x średniej z 5 sesji (zamknięcie 12,1 USD, {AS_OF})."
    )
    assert float(result.value) == pytest.approx(3.4)
    code, params = alert_message(c.kind, c.payload, c.message, "QUBT")
    assert code == "alert.volume_spike"
    assert (params["ratio"], params["multiple"], params["window_days"]) == (3.4, 2.5, 5)
    assert "volume" not in params and "average_volume" not in params


def test_volume_spike_below_the_multiple_does_not_fire():
    volumes = [1000, 1000, 1000, 1000, 1000, 2400]
    result = check(spike(), series=series(flat(6), volumes))
    assert isinstance(result.outcome, NotFired)
    assert result.outcome.details["ratio"] == pytest.approx(2.4)
    exact = check(spike(multiple=2.4), series=series(flat(6), volumes))
    assert isinstance(exact.outcome, Fired)


def test_volume_spike_skips_without_volume_or_with_a_zero_average():
    missing = check(spike(), series=series(flat(6), [1000, None, 1000, 1000, 1000, 5000]))
    assert isinstance(missing.outcome, Skipped)
    assert missing.outcome.reason == "Brak wolumenu w oknie: QUBT (źródło cen go nie podaje)"
    zero = check(spike(), series=series(flat(6), [0, 0, 0, 0, 0, 5000]))
    assert isinstance(zero.outcome, Skipped) and "Zerowy" in zero.outcome.reason
    short = check(spike(), series=series(flat(5), [1] * 5))
    assert isinstance(short.outcome, Skipped)
