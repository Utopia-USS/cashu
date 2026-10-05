"""cash_level: fires / not fired / skipped (stale, unpriced, empty, negative cash R2, missing FX R4)."""

from __future__ import annotations

from rules_fixtures import (
    ACCOUNT_B,
    AS_OF,
    PLN,
    candidate,
    context,
    d,
    describe,
    h,
    instrument,
    parse_issues,
    parse_ok,
    portfolio,
    run,
    skip_reason,
)

from finanse.modules.investments.domain import AssetClass, CashHistoryGap, Currency
from finanse.modules.investments.rules import CashLevelParams, CashLevelRule

KIND = CashLevelRule()
ETF = instrument("VWCE", asset_class=AssetClass.ETF)
MMF = instrument("MMF", asset_class=AssetClass.CASH)
PARAMS = CashLevelParams(min_weight=0.02, max_weight=0.15)


class TestParseParams:
    def test_reads_one_or_both_bounds(self):
        assert parse_ok(KIND, {"max_weight": 0.15}) == CashLevelParams(max_weight=0.15)
        assert parse_ok(KIND, {"min_weight": 0.02, "max_weight": 0.15}) == PARAMS

    def test_needs_a_bound_and_min_below_max(self):
        assert (
            parse_issues(KIND, {})[0].message == "cash_level needs min_weight, max_weight or both"
        )
        assert parse_issues(KIND, {"min_weight": 0.2, "max_weight": 0.1})[0].key == "min_weight"


class TestEvaluate:
    def test_fires_above_max_counting_cash_like_instruments(self):
        outcomes = run(
            KIND,
            context(portfolio_value=portfolio([h(ETF, value="8000"), h(MMF)], cash="1000")),
            PARAMS,
        )
        assert [describe(o) for o in outcomes] == ["fired r"]
        fired = candidate(outcomes[0])
        assert fired.message == "Gotówka: 20,0\u00a0% portfela, powyżej maksimum 15,0\u00a0%."
        assert fired.payload["direction"] == "above_max"
        assert fired.payload["cash_base"] == "2000"

    def test_fires_below_min_and_is_quiet_inside(self):
        low = run(
            KIND, context(portfolio_value=portfolio([h(ETF, value="9900")], cash="100")), PARAMS
        )
        assert candidate(low[0]).message == (
            "Gotówka: 1,0\u00a0% portfela, poniżej minimum 2,0\u00a0%."
        )
        inside = run(
            KIND, context(portfolio_value=portfolio([h(ETF, value="9000")], cash="1000")), PARAMS
        )
        assert [describe(o) for o in inside] == ["not_fired r"]


class TestSkipsOnBadData:
    def test_stale_unpriced_empty(self):
        stale = portfolio([h(ETF, value="9000", stale=True)], cash="1000")
        assert "Nieaktualne ceny: 90,0\u00a0%" in skip_reason(
            run(KIND, context(portfolio_value=stale), PARAMS)[0]
        )
        unpriced = portfolio([h(ETF, value=None)], cash="1000")
        assert "Brak ceny dla 1 pozycji (VWCE)" in skip_reason(
            run(KIND, context(portfolio_value=unpriced), PARAMS)[0]
        )
        assert skip_reason(run(KIND, context(), PARAMS)[0]) == "Portfel nie ma jeszcze wartości"

    def test_negative_cash_in_any_account_skips(self):
        gap = CashHistoryGap(account_id=ACCOUNT_B, currency=PLN, amount=d("-30000"), as_of=AS_OF)
        outcomes = run(
            KIND,
            context(
                portfolio_value=portfolio(
                    [h(ETF, value="9000")], cash="1000", snapshot_warnings=(gap,)
                )
            ),
            PARAMS,
        )
        assert [describe(o) for o in outcomes] == ["skipped r"]
        assert skip_reason(outcomes[0]) == (
            "Niepełna historia gotówki (ujemne saldo: -30\u00a0000 PLN na koncie account-b; brak wpłat "
            "w zaimportowanej historii?): udział gotówki nieznany"
        )

    def test_a_cash_balance_without_fx_skips(self):
        outcomes = run(
            KIND,
            context(
                portfolio_value=portfolio(
                    [h(ETF, value="9000")],
                    cash="1000",
                    missing_fx_currencies=frozenset({Currency.USD}),
                )
            ),
            PARAMS,
        )
        assert skip_reason(outcomes[0]) == (
            "Brak kursu USD/PLN na 2026-10-02 (brak lub starszy niż 10 dni): nie da się wycenić "
            "części kwot; wagi portfela niepełne"
        )
