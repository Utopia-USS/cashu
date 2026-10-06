"""allocation_drift: fires / not fired / skipped on bad data (port of the Kompas tests + R1, R2, R4)."""

from __future__ import annotations

from decimal import Decimal

from rules_fixtures import (
    alloc,
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

from cashu.modules.investments.domain import AssetClass, Currency, SignalSeverity
from cashu.modules.investments.rules import (
    AllocationDriftParams,
    AllocationDriftRule,
    DataQualityPolicy,
    NotFired,
    RebalancePolicy,
)

KIND = AllocationDriftRule()
ETF = instrument("VWCE", asset_class=AssetClass.ETF)
GOOD = portfolio([h(ETF, value="100000")])


def params(abs_pp=5.0, rel=0.25, min_trade="0", buckets=()) -> AllocationDriftParams:
    return AllocationDriftParams(RebalancePolicy(abs_pp, rel, Decimal(min_trade)), tuple(buckets))


class TestParseParams:
    def test_defaults_to_the_5_25_bands(self):
        assert parse_ok(KIND, {}) == params()

    def test_reads_every_param(self):
        raw = {
            "absolute_band_pp": 3,
            "relative_band": 0.2,
            "min_trade_value": 500,
            "buckets": ["bonds"],
        }
        assert parse_ok(KIND, raw) == params(3, 0.2, "500", ["bonds"])

    def test_rejects_bad_values_and_warns_about_unknown_keys(self):
        issues = parse_issues(
            KIND, {"absolute_band_pp": -1, "relative_band": "x", "min_trade_valu": 5}
        )
        assert [i.key for i in issues if i.is_error] == ["absolute_band_pp", "relative_band"]
        warning = next(i for i in issues if not i.is_error)
        assert warning.key == "min_trade_valu"
        assert 'did you mean "min_trade_value"' in warning.message


class TestEvaluate:
    def test_fires_per_bucket_outside_the_absolute_band(self):
        outcomes = run(
            KIND,
            context(
                portfolio_value=GOOD,
                allocations=[
                    alloc("equity", weight=0.67, target=0.60),
                    alloc("bonds", weight=0.33, target=0.40),
                ],
            ),
            params(),
            severity=SignalSeverity.ACTION,
        )
        assert [describe(o) for o in outcomes] == ["fired r|s:equity", "fired r|s:bonds"]
        equity = candidate(outcomes[0])
        assert equity.severity == SignalSeverity.ACTION
        assert equity.kind == "allocation_drift"
        assert equity.message == (
            "Koszyk equity powyżej celu o 7,0\u00a0pp (67,0\u00a0% wobec 60,0\u00a0%, "
            "7\u00a0000 PLN ponad cel)."
        )
        assert equity.payload["direction"] == "overweight"
        assert equity.payload["drift_value_base"] == "7000"
        assert candidate(outcomes[1]).message == (
            "Koszyk bonds poniżej celu o 7,0\u00a0pp (33,0\u00a0% wobec 40,0\u00a0%, "
            "do celu brakuje 7\u00a0000 PLN)."
        )

    def test_fires_on_the_relative_band_alone(self):
        outcomes = run(
            KIND,
            context(portfolio_value=GOOD, allocations=[alloc("cash", weight=0.035, target=0.05)]),
            params(),
        )
        assert [describe(o) for o in outcomes] == ["fired r|s:cash"]

    def test_quiet_inside_the_bands_on_the_band_or_below_the_minimum_trade(self):
        outcomes = run(
            KIND,
            context(
                portfolio_value=GOOD,
                allocations=[
                    alloc("inside", weight=0.62, target=0.60),
                    alloc("on_band", weight=0.25, target=0.20),
                    alloc("small", weight=0.08, target=0.15, total=1000),
                ],
            ),
            params(rel=10, min_trade="500"),
        )
        assert [describe(o) for o in outcomes] == [
            "not_fired r|s:inside",
            "not_fired r|s:on_band",
            "not_fired r|s:small",
        ]
        first = outcomes[0]
        assert isinstance(first, NotFired)
        assert abs(first.details["drift_pp"] - 2) < 1e-9

    def test_target_zero_with_weight_fires_with_a_json_safe_payload(self):
        outcomes = run(
            KIND,
            context(portfolio_value=GOOD, allocations=[alloc("crypto", weight=0.06, target=0)]),
            params(),
        )
        assert [describe(o) for o in outcomes] == ["fired r|s:crypto"]
        assert candidate(outcomes[0]).payload["drift_rel"] is None

    def test_checks_only_requested_buckets_and_skips_one_without_allocation(self):
        outcomes = run(
            KIND,
            context(
                portfolio_value=GOOD,
                allocations=[
                    alloc("equity", weight=0.9, target=0.6),
                    alloc("bonds", weight=0.1, target=0.4),
                ],
            ),
            params(buckets=["bonds", "gold"]),
        )
        assert [describe(o) for o in outcomes] == ["fired r|s:bonds", "skipped r|s:gold"]


class TestSkipsOnBadData:
    ALLOCATIONS = (alloc("equity", weight=0.9, target=0.6),)

    def test_stale_share_above_max_stale_weight(self):
        stale = portfolio([h(ETF, value="90000", stale=True), h(instrument("PKN"), value="10000")])
        outcomes = run(KIND, context(portfolio_value=stale, allocations=self.ALLOCATIONS), params())
        assert [describe(o) for o in outcomes] == ["skipped r"]
        assert skip_reason(outcomes[0]) == (
            "Nieaktualne ceny: 90,0\u00a0% portfela (maks 5,0\u00a0%)"
        )

    def test_a_holding_without_any_price(self):
        unpriced = portfolio([h(ETF, value="100000"), h(instrument("XYZ"), value=None)])
        outcomes = run(
            KIND, context(portfolio_value=unpriced, allocations=self.ALLOCATIONS), params()
        )
        assert skip_reason(outcomes[0]) == "Brak ceny dla 1 pozycji (XYZ): wagi portfela niepełne"

    def test_unclassified_above_the_limit_skips_naming_them(self):
        untagged = instrument("VWRL", asset_class=AssetClass.ETF)
        mixed = portfolio([h(ETF), h(untagged, value="9000")])
        unclassified = [mixed.valued[-1]]
        outcomes = run(
            KIND,
            context(portfolio_value=mixed, allocations=self.ALLOCATIONS, unclassified=unclassified),
            params(),
        )
        assert [describe(o) for o in outcomes] == ["skipped r"]
        assert skip_reason(outcomes[0]) == (
            "Pozycje bez koszyka: 90,0\u00a0% portfela (maks 2,0\u00a0%): VWRL; "
            "sklasyfikuj je lub otaguj, by trafiły do koszyka"
        )
        loose = run(
            KIND,
            context(
                portfolio_value=mixed,
                allocations=self.ALLOCATIONS,
                unclassified=unclassified,
                data=DataQualityPolicy(max_unclassified_weight=0.95),
            ),
            params(),
        )
        assert [describe(o) for o in loose] == ["fired r|s:equity"]

    def test_a_bucket_holding_negative_cash_is_skipped_others_evaluated(self):
        gap = alloc("cash", weight=0, target=0.05, cash_history_gap=True)
        outcomes = run(
            KIND, context(portfolio_value=GOOD, allocations=[*self.ALLOCATIONS, gap]), params()
        )
        assert [describe(o) for o in outcomes] == ["fired r|s:equity", "skipped r|s:cash"]
        assert skip_reason(outcomes[1]) == (
            "Koszyk cash: ujemna gotówka (brak wpłat w zaimportowanej historii), wartość nieznana"
        )

    def test_a_currency_without_a_usable_fx_rate_skips_naming_it(self):
        usd = instrument("VT", asset_class=AssetClass.ETF, currency=Currency.USD, mic="ARCX")
        gap = portfolio([h(ETF), h(usd)], missing_fx_currencies=frozenset({Currency.USD}))
        outcomes = run(KIND, context(portfolio_value=gap, allocations=self.ALLOCATIONS), params())
        assert [describe(o) for o in outcomes] == ["skipped r"]
        reason = skip_reason(outcomes[0])
        assert reason == (
            "Brak kursu USD/PLN na 2026-10-02 (brak lub starszy niż 10 dni): nie da się wycenić "
            "1 pozycji (VT); wagi portfela niepełne"
        )

    def test_an_empty_portfolio_or_missing_allocations(self):
        assert skip_reason(run(KIND, context(allocations=self.ALLOCATIONS), params())[0]) == (
            "Portfel nie ma jeszcze wartości"
        )
        assert skip_reason(run(KIND, context(portfolio_value=GOOD), params())[0]) == (
            "Brak wyliczonej alokacji koszyków"
        )
