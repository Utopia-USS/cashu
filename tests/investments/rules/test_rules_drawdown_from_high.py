"""drawdown_from_high: fires / not fired / skipped (short series, stale close, no series, FX, cost)."""

from __future__ import annotations

from rules_fixtures import (
    bars,
    candidate,
    context,
    day,
    describe,
    h,
    instrument,
    parse_issues,
    parse_ok,
    portfolio,
    run,
    skip_reason,
)

from cashu.modules.investments.domain import AssetClass, Currency
from cashu.modules.investments.rules import (
    DataQualityPolicy,
    DrawdownFromHighParams,
    DrawdownFromHighRule,
    InstrumentFilter,
)

KIND = DrawdownFromHighRule()
PKN = instrument("PKN")
CDR = instrument("CDR")
ETF = instrument("VWCE", asset_class=AssetClass.ETF, tags=("core",))
PARAMS = DrawdownFromHighParams(threshold=0.15, window_days=5)


def ctx_with(series, holdings=None, **kwargs):
    specs = holdings if holdings is not None else [h(inst) for inst in series]
    return context(portfolio_value=portfolio(specs), series=series, **kwargs)


class TestParseParams:
    def test_window_days_defaults_to_252(self):
        assert parse_ok(KIND, {"threshold": 0.15}) == DrawdownFromHighParams(threshold=0.15)

    def test_validates_threshold_and_window(self):
        assert "(fractions: 0.15 = 15%)" in parse_issues(KIND, {"threshold": 15})[0].message
        assert "at least 2" in parse_issues(KIND, {"threshold": 0.1, "window_days": 1})[0].message
        assert (
            "whole number" in parse_issues(KIND, {"threshold": 0.1, "window_days": 2.5})[0].message
        )


class TestEvaluate:
    def test_fires_when_last_close_is_threshold_below_window_high(self):
        outcomes = run(
            KIND,
            ctx_with(
                {
                    PKN: bars(PKN, ["90", "100", "95", "85", "80"]),
                    CDR: bars(CDR, ["100", "100", "100", "95", "90"]),
                }
            ),
            PARAMS,
        )
        assert [describe(o) for o in outcomes] == ["fired r|i:i-PKN", "not_fired r|i:i-CDR"]
        fired = candidate(outcomes[0])
        assert fired.message == (
            "PKN: -20,0\u00a0% od szczytu z 5 sesji (zamknięcie 80 2026-10-02, szczyt 100 2026-09-29; "
            "próg -15,0\u00a0%)."
        )
        assert abs(fired.payload["drawdown"] - 0.2) < 1e-9
        assert fired.payload["high_date"] == "2026-09-29"

    def test_exactly_at_threshold_fires_and_older_highs_are_ignored(self):
        outcomes = run(
            KIND, ctx_with({PKN: bars(PKN, ["200", "100", "95", "90", "88", "85"])}), PARAMS
        )
        assert [describe(o) for o in outcomes] == ["fired r|i:i-PKN"]
        assert candidate(outcomes[0]).payload["high_close"] == "100"

    def test_filters_and_cash_like_instruments(self):
        mmf = instrument("MMF", asset_class=AssetClass.CASH)
        crash = ["100", "100", "100", "100", "50"]
        series = {PKN: bars(PKN, crash), ETF: bars(ETF, crash), mmf: bars(mmf, crash)}
        etf_only = DrawdownFromHighParams(0.15, 5, InstrumentFilter(frozenset({AssetClass.ETF})))
        assert [describe(o) for o in run(KIND, ctx_with(series), etf_only)] == ["fired r|i:i-VWCE"]
        tagged = DrawdownFromHighParams(0.15, 5, InstrumentFilter(tags=("core",)))
        assert [describe(o) for o in run(KIND, ctx_with(series), tagged)] == ["fired r|i:i-VWCE"]
        everything = run(KIND, ctx_with(series), PARAMS)
        assert [describe(o) for o in everything] == ["fired r|i:i-PKN", "fired r|i:i-VWCE"]


class TestSkipsOnBadData:
    def test_short_series_stale_close_no_series(self):
        outcomes = run(
            KIND,
            ctx_with(
                {
                    PKN: bars(PKN, ["100", "50"]),
                    CDR: bars(CDR, ["100", "100", "100", "100", "50"], last_date=day("2026-09-25")),
                },
                holdings=[h(PKN), h(CDR), h(ETF)],
            ),
            PARAMS,
        )
        assert [describe(o) for o in outcomes] == [
            "skipped r|i:i-PKN",
            "skipped r|i:i-CDR",
            "skipped r|i:i-VWCE",
        ]
        assert skip_reason(outcomes[0]) == "Tylko 2 z 5 notowań: PKN"
        assert (
            skip_reason(outcomes[1])
            == "Nieaktualna cena: CDR (ostatnie zamknięcie 2026-09-25, 7 dni temu)"
        )
        assert skip_reason(outcomes[2]) == "Brak notowań: VWCE"

    def test_max_price_age_days_is_respected(self):
        series = {CDR: bars(CDR, ["100", "100", "100", "100", "50"], last_date=day("2026-09-25"))}
        loose = run(KIND, ctx_with(series, data=DataQualityPolicy(max_price_age_days=7)), PARAMS)
        assert [describe(o) for o in loose] == ["fired r|i:i-CDR"]

    def test_currency_without_fx_is_skipped(self):
        usd = instrument("AAPL", currency=Currency.USD, mic="XNAS")
        crash = ["100", "100", "100", "100", "50"]
        outcomes = run(
            KIND,
            context(
                portfolio_value=portfolio(
                    [h(PKN), h(usd)], missing_fx_currencies=frozenset({Currency.USD})
                ),
                series={PKN: bars(PKN, crash), usd: bars(usd, crash)},
            ),
            PARAMS,
        )
        assert [describe(o) for o in outcomes] == ["fired r|i:i-PKN", "skipped r|i:i-AAPL"]
        assert skip_reason(outcomes[1]) == "Brak kursu USD: nie da się wycenić AAPL"

    def test_holdings_valued_at_cost_or_manually_are_skipped_never_fired(self):
        bond = instrument("EDO0536", asset_class=AssetClass.TREASURY_BOND, mic=None)
        claim = instrument("CLAIM", asset_class=AssetClass.CLAIM, mic=None)
        crash = ["100", "100", "100", "100", "50"]
        outcomes = run(
            KIND,
            ctx_with(
                # Even with a (stale-looking) series present, a manual or cost valuation is never judged.
                {PKN: bars(PKN, crash), bond: bars(bond, crash), claim: bars(claim, crash)},
                holdings=[
                    h(PKN),
                    h(bond, value="800", at_cost=True),
                    h(claim, value="0", manual=True),
                ],
            ),
            PARAMS,
        )
        assert [describe(o) for o in outcomes] == [
            "fired r|i:i-PKN",
            "skipped r|i:i-EDO0536",
            "skipped r|i:i-CLAIM",
        ]
        assert skip_reason(outcomes[1]) == "EDO0536: wycena po koszcie, brak notowań rynkowych"
        assert skip_reason(outcomes[2]) == "CLAIM: wycena ręczna, brak notowań rynkowych"

    def test_one_manually_valued_account_skips_the_whole_instrument(self):
        crash = ["100", "100", "100", "100", "50"]
        outcomes = run(
            KIND,
            ctx_with(
                {PKN: bars(PKN, crash)}, holdings=[h(PKN), h(PKN, manual=True, account="account-b")]
            ),
            PARAMS,
        )
        assert [describe(o) for o in outcomes] == ["skipped r|i:i-PKN"]
