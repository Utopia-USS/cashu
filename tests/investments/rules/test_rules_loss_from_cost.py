"""loss_from_cost: fires / not fired / skipped on stale, missing price, unknown cost, missing FX."""

from __future__ import annotations

from rules_fixtures import (
    ACCOUNT_B,
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

from finanse.modules.investments.domain import AssetClass, Currency
from finanse.modules.investments.rules import (
    InstrumentFilter,
    LossFromCostRule,
    UnrealizedThresholdParams,
)

KIND = LossFromCostRule()
PKN = instrument("PKN", tags=("satellite",))
CDR = instrument("CDR")
ETF = instrument("VWCE", asset_class=AssetClass.ETF)


def params(threshold=0.25, **filters) -> UnrealizedThresholdParams:
    return UnrealizedThresholdParams(threshold, InstrumentFilter(**filters))


class TestParseParams:
    def test_threshold_between_0_and_1(self):
        assert parse_ok(KIND, {"threshold": 0.25}) == params()
        assert "less than 1" in parse_issues(KIND, {"threshold": 1})[0].message
        assert parse_issues(KIND, {})[0].message == "threshold is required"

    def test_filters(self):
        parsed = parse_ok(KIND, {"threshold": 0.2, "tags": ["satellite"], "asset_class": "equity"})
        assert parsed.filter == InstrumentFilter(frozenset({AssetClass.EQUITY}), ("satellite",))


class TestEvaluate:
    def test_fires_at_or_below_minus_threshold_across_accounts(self):
        value = portfolio(
            [
                h(PKN, value="600", cost="1000"),
                h(PKN, value="900", cost="1000", account=ACCOUNT_B),
                h(CDR, value="800", cost="1000"),
            ]
        )
        outcomes = run(KIND, context(portfolio_value=value), params())
        assert [describe(o) for o in outcomes] == ["fired r|i:i-PKN", "not_fired r|i:i-CDR"]
        fired = candidate(outcomes[0])
        assert fired.message == "PKN: -25,0\u00a0% od kosztu (próg -25,0\u00a0%)."
        assert fired.payload["market_value_base"] == "1500"
        assert fired.payload["cost_basis_base"] == "2000"

    def test_tag_filter(self):
        value = portfolio([h(PKN, value="500", cost="1000"), h(CDR, value="500", cost="1000")])
        outcomes = run(KIND, context(portfolio_value=value), params(tags=("satellite",)))
        assert [describe(o) for o in outcomes] == ["fired r|i:i-PKN"]


class TestSkipsOnBadData:
    def test_stale_or_missing_price_and_unknown_or_zero_cost(self):
        value = portfolio(
            [
                h(PKN, value="500", cost="1000", stale=True),
                h(CDR, value=None, cost="1000"),
                h(ETF, value="500", cost=None),
                h(instrument("ZERO"), value="500", cost="0"),
            ]
        )
        outcomes = run(KIND, context(portfolio_value=value), params())
        assert [describe(o) for o in outcomes] == [
            "skipped r|i:i-PKN",
            "skipped r|i:i-CDR",
            "skipped r|i:i-VWCE",
            "skipped r|i:i-ZERO",
        ]
        assert skip_reason(outcomes[0]) == "Nieaktualna cena: PKN (ostatnie zamknięcie 2026-09-22)"
        assert skip_reason(outcomes[1]) == "Brak ceny: CDR"
        assert skip_reason(outcomes[2]) == (
            "Nieznany koszt: VWCE (niepełna historia lub transfer bez ceny)"
        )
        assert skip_reason(outcomes[3]) == "Zerowy koszt: ZERO"

    def test_an_instrument_in_a_currency_without_fx_is_skipped(self):
        usd = instrument("AAPL", currency=Currency.USD, mic="XNAS")
        value = portfolio(
            [h(PKN, value="500", cost="1000"), h(usd, value="500", cost="1000")],
            missing_fx_currencies=frozenset({Currency.USD}),
        )
        outcomes = run(KIND, context(portfolio_value=value), params())
        assert [describe(o) for o in outcomes] == ["fired r|i:i-PKN", "skipped r|i:i-AAPL"]
        assert skip_reason(outcomes[1]) == "Brak kursu USD: nie da się wycenić AAPL"

    def test_a_frozen_holding_valued_manually_at_zero_is_skipped_not_fired(self):
        claim = instrument("FTX", asset_class=AssetClass.CLAIM, mic=None)
        value = portfolio(
            [h(PKN, value="500", cost="1000"), h(claim, value="0", cost="3000", manual=True)]
        )
        outcomes = run(
            KIND,
            context(portfolio_value=value),
            params(asset_classes=frozenset({AssetClass.EQUITY, AssetClass.CLAIM})),
        )
        assert [describe(o) for o in outcomes] == ["fired r|i:i-PKN", "skipped r|i:i-FTX"]
        assert (
            skip_reason(outcomes[1])
            == "FTX: wycena ręczna, zmiana od kosztu nie jest wynikiem rynkowym"
        )

    def test_a_holding_valued_at_cost_is_evaluated_and_never_moves(self):
        bond = instrument("EDO0536", asset_class=AssetClass.TREASURY_BOND, mic=None)
        value = portfolio([h(bond, value="1000", cost="1000", at_cost=True)])
        assert [describe(o) for o in run(KIND, context(portfolio_value=value), params())] == [
            "not_fired r|i:i-EDO0536"
        ]
