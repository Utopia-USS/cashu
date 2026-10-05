"""Alert evaluation on synthetic prices and portfolios, one block per kind: fires, does not fire, and
never fires on missing / stale / short data; candidates carry the alert's id, kind, polarity and
severity; messages are deterministic."""

from __future__ import annotations

from dataclasses import replace
from datetime import timedelta

from al_fixtures import AS_OF, alert, alloc, bars, check, context, h, instrument, portfolio

from finanse.modules.investments.domain import InstrumentStatus, SignalSeverity
from finanse.modules.investments.rules import Fired, NotFired, SignalPolarity, Skipped

VWCE = instrument("VWCE")


def fired(result) -> Fired:
    assert isinstance(result.outcome, Fired), result.outcome
    return result.outcome


def series(*closes: str, last_date=AS_OF):
    return {VWCE: bars(VWCE, list(closes), last_date=last_date)}


# --- price_above / price_below -------------------------------------------------------------------


def test_price_above_fires_with_the_alert_identity():
    result = check(
        alert("price_above", {"level": 100}, inst=VWCE, title="VWCE over 100"),
        series=series("98", "101.5"),
    )
    out = fired(result)
    c = out.candidate
    assert (c.rule_id, c.dedup_key, c.kind) == ("alert:7", "alert:7", "alert:price_above")
    assert (c.polarity, c.severity, c.instrument_id) == (
        SignalPolarity.NEGATIVE,
        SignalSeverity.ACTION,
        VWCE.id,
    )
    assert c.message == f"VWCE over 100: VWCE closed at 101.5 PLN on {AS_OF}, above 100 PLN."
    assert c.payload["close"] == "101.5" and c.payload["level"] == "100"
    assert result.value == 101.5


def test_price_above_equal_is_not_above_and_price_below():
    equal = check(alert("price_above", {"level": 100}, inst=VWCE), series=series("100"))
    assert isinstance(equal.outcome, NotFired) and equal.outcome.dedup_key == "alert:7"
    below = check(alert("price_below", {"level": 100}, inst=VWCE), series=series("99.99"))
    assert "below 100 PLN" in fired(below).candidate.message
    not_below = check(alert("price_below", {"level": 100}, inst=VWCE), series=series("100"))
    assert isinstance(not_below.outcome, NotFired)


def test_price_alerts_never_fire_on_missing_stale_or_unpriced_data():
    a = alert("price_above", {"level": 1}, inst=VWCE)
    none = check(a, series={})
    assert isinstance(none.outcome, Skipped) and "No prices for VWCE yet" in none.outcome.reason
    stale = check(a, series=series("50", last_date=AS_OF - timedelta(days=8)))
    assert isinstance(stale.outcome, Skipped) and "stale" in stale.outcome.reason
    assert isinstance(check(a, series=series("50"), max_age=5).outcome, Fired)
    frozen = replace(VWCE, status=InstrumentStatus.FROZEN)
    result = check(
        alert("price_above", {"level": 1}, inst=frozen), series={frozen: bars(frozen, ["9"])}
    )
    assert isinstance(result.outcome, Skipped) and "frozen" in result.outcome.reason
    short = check(
        alert("change_pct", {"window_days": 5, "threshold": 0.1}, inst=VWCE), series=series("1")
    )
    assert isinstance(short.outcome, Skipped)
    zero = check(a, series=series("0"))
    assert isinstance(zero.outcome, Skipped) and "non-positive" in zero.outcome.reason


# --- change_pct ----------------------------------------------------------------------------------


def test_change_pct_directions():
    up = series("100", "103", "112")  # +12% over 2 sessions
    a_up = alert("change_pct", {"window_days": 2, "threshold": 0.1, "direction": "up"}, inst=VWCE)
    result = check(a_up, series=up)
    c = fired(result).candidate
    assert "rose 12.0% over 2 sessions" in c.message and c.payload["change"] == 0.12
    a_down = alert(
        "change_pct", {"window_days": 2, "threshold": 0.1, "direction": "down"}, inst=VWCE
    )
    assert isinstance(check(a_down, series=up).outcome, NotFired)
    assert "fell 15.0%" in fired(check(a_down, series=series("100", "90", "85"))).candidate.message
    a_any = alert("change_pct", {"window_days": 2, "threshold": 0.1}, inst=VWCE)
    assert isinstance(check(a_any, series=series("100", "90", "85")).outcome, Fired)
    assert isinstance(check(a_any, series=series("100", "95", "105")).outcome, NotFired)
    short = check(a_any, series=series("100", "120"))
    assert isinstance(short.outcome, Skipped) and "Only 2 daily closes" in short.outcome.reason


# --- drawdown_from_high / new_high ---------------------------------------------------------------


def test_drawdown_from_high():
    a = alert("drawdown_from_high", {"window_days": 4, "threshold": 0.2}, inst=VWCE)
    result = check(a, series=series("90", "100", "95", "80"))
    c = fired(result).candidate
    assert "20.0% below its 4-session high" in c.message and c.payload["high"] == "100"
    assert isinstance(check(a, series=series("90", "100", "95", "81")).outcome, NotFired)
    # the high outside the window does not count
    assert isinstance(check(a, series=series("200", "90", "100", "95", "81")).outcome, NotFired)


def test_new_high_needs_a_strictly_higher_close():
    a = alert("new_high", {"window_days": 3}, inst=VWCE)
    assert (
        "new 3-session high of 105"
        in fired(check(a, series=series("100", "104", "105"))).candidate.message
    )
    assert isinstance(check(a, series=series("100", "105", "105")).outcome, NotFired)
    assert isinstance(check(a, series=series("110", "100", "105")).outcome, NotFired)


# --- sma_cross -----------------------------------------------------------------------------------


def test_sma_cross_is_a_state_on_one_side_of_the_average():
    above = alert("sma_cross", {"window_days": 4, "direction": "above"}, inst=VWCE)
    result = check(above, series=series("100", "100", "100", "108"))  # sma 102
    c = fired(result).candidate
    assert "above its 4-session average of 102" in c.message and c.payload["sma"] == "102"
    assert isinstance(check(above, series=series("100", "100", "100", "96")).outcome, NotFired)
    below = alert("sma_cross", {"window_days": 4, "direction": "below"}, inst=VWCE)
    assert isinstance(check(below, series=series("100", "100", "100", "96")).outcome, Fired)


# --- weights -------------------------------------------------------------------------------------


def test_weight_of_an_instrument_and_of_a_bucket():
    abc, xyz = instrument("ABC"), instrument("XYZ")
    ctx = context(
        portfolio_value=portfolio([h(abc, value="4000"), h(xyz, value="1000")], cash="5000"),
        allocations=[alloc("stocks", weight=0.5, target=0.6)],
    )
    above = check(alert("weight_above", {"threshold": 0.3}, inst=abc), ctx=ctx)
    assert "ABC is 40.0% of the portfolio (above 30.0%)." in fired(above).candidate.message
    assert isinstance(
        check(alert("weight_above", {"threshold": 0.4}, inst=abc), ctx=ctx).outcome, NotFired
    )
    # a watched instrument that is not held weighs 0
    other = instrument("NEW")
    below = check(alert("weight_below", {"threshold": 0.05}, inst=other), ctx=ctx)
    assert fired(below).candidate.payload["held"] is False
    bucket = check(alert("weight_below", {"threshold": 0.55, "bucket": "stocks"}), ctx=ctx)
    assert fired(bucket).candidate.message.endswith(
        "Bucket stocks is 50.0% of the portfolio (below 55.0%)."
    )
    missing = check(alert("weight_below", {"threshold": 0.55, "bucket": "bonds"}), ctx=ctx)
    assert isinstance(missing.outcome, Skipped)


def test_weights_skip_on_unreliable_portfolio_weights():
    abc = instrument("ABC")
    stale = context(portfolio_value=portfolio([h(abc, value="1000", stale=True)], cash="10"))
    result = check(alert("weight_above", {"threshold": 0.1}, inst=abc), ctx=stale)
    assert isinstance(result.outcome, Skipped) and "Stale prices" in result.outcome.reason
    no_ctx = check(alert("weight_above", {"threshold": 0.1}, inst=abc), ctx=None)
    assert isinstance(no_ctx.outcome, Skipped)


# --- custom --------------------------------------------------------------------------------------


def test_custom_alert_scopes():
    abc = instrument("ABC")
    ctx = context(portfolio_value=portfolio([h(abc, value="4000", cost="2000")], cash="1000"))
    cash = check(
        alert("custom", {"expression": "cash_weight >= 15%"}, title="Cash waiting"), ctx=ctx
    )
    c = fired(cash).candidate
    assert (c.rule_id, c.dedup_key, c.kind) == ("alert:7", "alert:7", "alert:custom")
    assert c.message.startswith("Cash waiting: Condition met: cash_weight >= 15%")
    assert c.polarity == SignalPolarity.NEGATIVE
    gain = check(alert("custom", {"expression": "unrealized_pct > 50%"}, inst=abc), ctx=ctx)
    assert fired(gain).candidate.instrument_id == abc.id
    # instrument scope looks at a held position: not held cannot hold
    other = check(alert("custom", {"expression": "weight > 1%"}, inst=instrument("NEW")), ctx=ctx)
    assert isinstance(other.outcome, NotFired)
    unknown = check(
        alert("custom", {"expression": 'bucket_drift_pp("stocks") > 1', "bucket": "stocks"}),
        ctx=ctx,
    )
    assert isinstance(unknown.outcome, Skipped)


def test_a_broken_alert_is_skipped_not_raised():
    a = alert("price_above", {"level": 1}, inst=VWCE)
    broken = replace(a, params={})
    result = check(broken, series=series("5"))
    assert isinstance(result.outcome, Skipped) and result.outcome.reason.startswith("Alert failed")
