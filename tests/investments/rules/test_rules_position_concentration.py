"""position_concentration: fires / not fired / skipped, plus the 2.1-A2 filters (tags, instrument_ids)."""

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
    PositionConcentrationParams,
    PositionConcentrationRule,
)

KIND = PositionConcentrationRule()
PKN = instrument("PKN", tags=("energy", "pl"))
CDR = instrument("CDR", tags=("pl",))
ETF = instrument("VWCE", asset_class=AssetClass.ETF, tags=("core",))
MMF = instrument("MMF", asset_class=AssetClass.CASH)


def params(max_weight=0.10, **filters) -> PositionConcentrationParams:
    return PositionConcentrationParams(max_weight, InstrumentFilter(**filters))


class TestParseParams:
    def test_reads_max_weight_and_filters(self):
        parsed = parse_ok(
            KIND,
            {
                "max_weight": 0.1,
                "asset_class": ["equity", "etf"],
                "tags": "pl",
                "instrument_ids": ["i-PKN"],
            },
        )
        assert parsed == params(
            asset_classes=frozenset({AssetClass.EQUITY, AssetClass.ETF}),
            tags=("pl",),
            instrument_ids=frozenset({"i-PKN"}),
        )

    def test_max_weight_is_required_and_a_fraction(self):
        assert parse_issues(KIND, {})[0].message == "max_weight is required"
        assert "(fractions: 0.15 = 15%)" in parse_issues(KIND, {"max_weight": 10})[0].message
        bad_class = parse_issues(KIND, {"max_weight": 0.1, "asset_class": "stock"})
        assert bad_class[0].key == "asset_class"
        assert "Unknown asset class" in bad_class[0].message


class TestEvaluate:
    def test_sums_accounts_and_fires_above_max(self):
        value = portfolio(
            [h(PKN, value="1000"), h(PKN, value="1000", account=ACCOUNT_B), h(ETF, value="8000")]
        )
        outcomes = run(
            KIND,
            context(portfolio_value=value),
            params(asset_classes=frozenset({AssetClass.EQUITY})),
        )
        assert [describe(o) for o in outcomes] == ["fired r|i:i-PKN"]
        fired = candidate(outcomes[0])
        assert fired.message == "PKN: 20,0\u00a0% portfela (maks 10,0\u00a0%)."
        assert fired.instrument_id == "i-PKN"
        assert fired.payload["accounts"] == 2

    def test_exactly_on_the_limit_does_not_fire(self):
        outcomes = run(
            KIND,
            context(portfolio_value=portfolio([h(PKN, value="1000"), h(ETF, value="9000")])),
            params(),
        )
        assert [describe(o) for o in outcomes] == ["not_fired r|i:i-PKN", "fired r|i:i-VWCE"]

    def test_cash_like_instruments_are_left_out_unless_named(self):
        value = portfolio([h(MMF, value="9000"), h(PKN, value="1000")])
        assert [describe(o) for o in run(KIND, context(portfolio_value=value), params())] == [
            "not_fired r|i:i-PKN"
        ]
        cash_only = run(
            KIND, context(portfolio_value=value), params(asset_classes=frozenset({AssetClass.CASH}))
        )
        assert [describe(o) for o in cash_only] == ["fired r|i:i-MMF"]

    def test_tags_filter_needs_every_tag(self):
        value = portfolio([h(PKN, value="3000"), h(CDR, value="3000"), h(ETF, value="4000")])
        outcomes = run(KIND, context(portfolio_value=value), params(tags=("PL", "energy")))
        assert [describe(o) for o in outcomes] == ["fired r|i:i-PKN"]

    def test_instrument_ids_filter_and_asset_class_combine_with_and(self):
        value = portfolio([h(PKN, value="3000"), h(CDR, value="3000"), h(ETF, value="4000")])
        pinned = run(
            KIND,
            context(portfolio_value=value),
            params(instrument_ids=frozenset({"i-CDR", "i-VWCE"})),
        )
        assert [describe(o) for o in pinned] == ["fired r|i:i-CDR", "fired r|i:i-VWCE"]
        both = run(
            KIND,
            context(portfolio_value=value),
            params(
                instrument_ids=frozenset({"i-CDR", "i-VWCE"}),
                asset_classes=frozenset({AssetClass.ETF}),
            ),
        )
        assert [describe(o) for o in both] == ["fired r|i:i-VWCE"]

    def test_nothing_in_scope_gives_no_outcome(self):
        assert run(KIND, context(), params()) == []
        value = portfolio([h(ETF, value="1000")])
        assert run(KIND, context(portfolio_value=value), params(tags=("missing",))) == []


class TestSkipsOnBadData:
    def test_untrusted_portfolio_weights_skip_the_whole_rule(self):
        stale = portfolio([h(PKN, value="9000", stale=True), h(CDR, value="1000")])
        outcomes = run(KIND, context(portfolio_value=stale), params())
        assert [describe(o) for o in outcomes] == ["skipped r"]
        assert "Nieaktualne ceny: 90,0\u00a0%" in skip_reason(outcomes[0])

    def test_one_stale_instrument_is_skipped_within_the_stale_limit(self):
        value = portfolio([h(PKN, value="200", stale=True), h(CDR, value="9800")])
        outcomes = run(KIND, context(portfolio_value=value), params())
        assert [describe(o) for o in outcomes] == ["skipped r|i:i-PKN", "fired r|i:i-CDR"]
        assert skip_reason(outcomes[0]) == "Nieaktualna cena: PKN (ostatnie zamknięcie 2026-09-22)"

    def test_missing_fx_skips_the_whole_rule(self):
        usd = instrument("AAPL", currency=Currency.USD, mic="XNAS")
        value = portfolio([h(PKN), h(usd)], missing_fx_currencies=frozenset({Currency.USD}))
        outcomes = run(KIND, context(portfolio_value=value), params())
        assert skip_reason(outcomes[0]).startswith("Brak kursu USD/PLN")
