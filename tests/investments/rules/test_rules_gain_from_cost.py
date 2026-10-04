"""gain_from_cost: fires / not fired / skipped (thresholds above 1 allowed)."""

from __future__ import annotations

from rules_fixtures import (
    candidate,
    context,
    describe,
    h,
    instrument,
    parse_issues,
    parse_ok,
    portfolio,
    run,
    skip_reason,
)

from finanse.modules.investments.domain import AssetClass
from finanse.modules.investments.rules import (
    GainFromCostRule,
    InstrumentFilter,
    UnrealizedThresholdParams,
)

KIND = GainFromCostRule()
PKN = instrument("PKN")
ETF = instrument("VWCE", asset_class=AssetClass.ETF)


def params(threshold=0.5, **filters) -> UnrealizedThresholdParams:
    return UnrealizedThresholdParams(threshold, InstrumentFilter(**filters))


def test_threshold_above_1_is_allowed_but_must_be_positive():
    assert parse_ok(KIND, {"threshold": 2}).threshold == 2
    assert "greater than 0" in parse_issues(KIND, {"threshold": 0})[0].message


def test_fires_at_or_above_threshold_and_respects_asset_class_filter():
    value = portfolio([h(PKN, value="1500", cost="1000"), h(ETF, value="1600", cost="1000")])
    outcomes = run(KIND, context(portfolio_value=value), params())
    assert [describe(o) for o in outcomes] == ["fired r|i:i-PKN", "fired r|i:i-VWCE"]
    assert candidate(outcomes[0]).message == "PKN is up 50.0% from cost (threshold 50.0%)."
    etf_only = run(
        KIND, context(portfolio_value=value), params(asset_classes=frozenset({AssetClass.ETF}))
    )
    assert [describe(o) for o in etf_only] == ["fired r|i:i-VWCE"]


def test_below_threshold_is_not_fired():
    value = portfolio([h(PKN, value="1400", cost="1000")])
    assert [describe(o) for o in run(KIND, context(portfolio_value=value), params())] == [
        "not_fired r|i:i-PKN"
    ]


def test_stale_price_is_skipped_never_fired():
    value = portfolio([h(PKN, value="3000", cost="1000", stale=True)], stale_weight=0.0)
    outcomes = run(KIND, context(portfolio_value=value), params())
    assert [describe(o) for o in outcomes] == ["skipped r|i:i-PKN"]
    assert "stale" in skip_reason(outcomes[0])


def test_a_manual_valuation_above_cost_is_skipped_not_fired():
    claim = instrument("CLAIM", asset_class=AssetClass.CLAIM, mic=None)
    value = portfolio([h(claim, value="5000", cost="1000", manual=True)])
    outcomes = run(
        KIND, context(portfolio_value=value), params(asset_classes=frozenset({AssetClass.CLAIM}))
    )
    assert [describe(o) for o in outcomes] == ["skipped r|i:i-CLAIM"]
    assert (
        skip_reason(outcomes[0])
        == "CLAIM is valued manually, so its change from cost is not a market result"
    )
