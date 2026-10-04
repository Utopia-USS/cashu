"""Every metric of the expression catalog: its value on good data and Unknown (with the built-in rule's
reason) on stale or missing data."""

from __future__ import annotations

from decimal import Decimal
from pathlib import Path

import pytest
from rules_fixtures import (
    AS_OF,
    PLN,
    alloc,
    bars,
    context,
    d,
    day,
    h,
    instrument,
    portfolio,
)

from finanse.modules.investments.domain import AssetClass, CashHistoryGap, Currency
from finanse.modules.investments.rules import ContributionPlan, DataQualityPolicy, InstrumentFilter
from finanse.modules.investments.rules.expr import (
    METRICS,
    MetricRef,
    Scope,
    Unknown,
    names_in_scope,
)
from finanse.modules.investments.rules.expr.metrics import MetricEnv
from finanse.modules.investments.rules.kinds.support import positions_by_instrument

ETF = instrument("VWCE", asset_class=AssetClass.ETF, tags=("core", "global_equity"), mic="xetr")
PKN = instrument("PKN", tags=("satellite",))
BOND = instrument("EDO0536", asset_class=AssetClass.TREASURY_BOND, mic=None)
MMF = instrument("MMF", asset_class=AssetClass.CASH)
SPECS = [
    h(ETF, value="6000", cost="5000"),
    h(PKN, value="1500", cost="2000"),
    h(BOND, value="1000", cost="1000", at_cost=True),
    h(MMF, value="500", cost="500"),
]
ALLOCATIONS = [
    alloc("equity", weight=0.75, target=0.70, total=10000),
    alloc("bonds", weight=0.10, target=0.20, total=10000),
    alloc("cash", weight=0.15, target=0.10, total=10000),
    alloc("gold", weight=0.02, target=0.0, total=10000),
]
SERIES = {ETF: bars(ETF, ["100", "120", "110", "90", "96"])}
CTX = context(
    portfolio_value=portfolio(SPECS, cash="1000", deposits=(day("2026-09-01"), day("2026-08-01"))),
    allocations=ALLOCATIONS,
    series=SERIES,
    contributions=ContributionPlan(monthly_amount=d("1500")),
)


def env_for(ctx=CTX, symbol: str | None = None, bucket: str | None = None) -> MetricEnv:
    if symbol is not None:
        everything = InstrumentFilter(frozenset(AssetClass))
        position = next(p for p in positions_by_instrument(ctx, everything) if p.label == symbol)
        return MetricEnv(ctx, position=position)
    if bucket is not None:
        allocation = next((a for a in ctx.allocations if a.bucket_id == bucket), None)
        return MetricEnv(ctx, bucket_id=bucket, allocation=allocation)
    return MetricEnv(ctx)


def value(name: str, *args, env: MetricEnv | None = None):
    return (env or env_for()).resolve(MetricRef(name, tuple(args), 1))


def reasons(result) -> str:
    assert isinstance(result, Unknown), result
    return "; ".join(result.reasons)


def approx(result, expected: str) -> bool:
    assert isinstance(result, Decimal), result
    return abs(result - Decimal(expected)) < Decimal("1e-9")


def test_every_catalog_metric_is_documented_and_covered_here():
    doc = (
        Path(__file__).parents[3] / "src/finanse/modules/investments/rules/expr/EXPRESSIONS.md"
    ).read_text(encoding="utf-8")
    source = Path(__file__).read_text(encoding="utf-8")
    for name, spec in METRICS.items():
        assert f"`{spec.signature()}`" in doc, f"{name} missing from EXPRESSIONS.md"
        assert f'"{name}"' in source, f"{name} has no test in this module"


class TestPortfolioMetrics:
    def test_values(self):
        assert value("total_value") == d("10000")
        assert value("cash_value") == d("1500")
        assert approx(value("cash_weight"), "0.15")
        assert value("stale_weight") == Decimal("0.0")
        assert value("unclassified_weight") == Decimal("0.0")
        assert approx(value("max_position_weight"), "0.6")
        assert value("holdings_count") == 3
        assert value("days_since_last_deposit") == 31
        assert value("monthly_contribution") == d("1500")
        assert approx(value("bucket_weight", "equity"), "0.75")
        assert approx(value("bucket_target", "bonds"), "0.2")
        assert approx(value("bucket_drift_pp", "bonds"), "-10")
        assert value("bucket_value", "cash") == d("1500.00")
        assert approx(value("tagged_weight", "core"), "0.6")
        assert approx(value("tagged_weight", "CORE", "global_equity"), "0.6")
        assert value("tagged_weight", "core", "satellite") == Decimal("0.0")
        assert approx(value("asset_class_weight", "etf"), "0.6")
        assert approx(value("asset_class_weight", "cash"), "0.15")
        assert approx(value("asset_class_weight", "treasury_bond"), "0.1")

    def test_weights_are_unknown_on_untrusted_portfolio_data(self):
        stale = context(
            portfolio_value=portfolio([h(ETF, value="9000", stale=True), h(PKN, value="1000")]),
            allocations=ALLOCATIONS,
        )
        env = env_for(stale)
        for name, args in [
            ("cash_weight", ()),
            ("unclassified_weight", ()),
            ("max_position_weight", ()),
            ("bucket_weight", ("equity",)),
            ("bucket_drift_pp", ("equity",)),
            ("bucket_value", ("equity",)),
            ("tagged_weight", ("core",)),
            ("asset_class_weight", ("etf",)),
            ("total_value", ()),
            ("cash_value", ()),
        ]:
            assert (
                reasons(value(name, *args, env=env))
                == "Stale prices cover 90.0% of the portfolio (max 5.0%)"
            )
        assert approx(value("stale_weight", env=env), "0.9")
        assert approx(value("bucket_target", "equity", env=env), "0.7"), (
            "targets do not depend on prices"
        )
        assert value("holdings_count", env=env) == 2

    def test_missing_fx_and_empty_portfolio(self):
        usd = instrument("VT", currency=Currency.USD, asset_class=AssetClass.ETF)
        no_fx = env_for(
            context(
                portfolio_value=portfolio(
                    [h(ETF), h(usd)], missing_fx_currencies=frozenset({Currency.USD})
                )
            )
        )
        assert reasons(value("total_value", env=no_fx)).startswith("No usable USD/PLN FX rate")
        empty = env_for(context())
        assert value("total_value", env=empty) == 0
        assert reasons(value("cash_weight", env=empty)) == "The portfolio has no value yet"
        assert value("holdings_count", env=empty) == 0

    def test_cash_history_gap_makes_cash_metrics_unknown(self):
        gap = CashHistoryGap(account_id="a", currency=PLN, amount=d("-50"), as_of=AS_OF)
        env = env_for(
            context(portfolio_value=portfolio(SPECS, cash="1000", snapshot_warnings=(gap,)))
        )
        assert reasons(value("cash_weight", env=env)).startswith("Cash history is incomplete")
        assert reasons(value("cash_value", env=env)).startswith("Cash history is incomplete")
        assert reasons(value("asset_class_weight", "cash", env=env)).startswith(
            "Cash history is incomplete"
        )
        assert approx(value("asset_class_weight", "etf", env=env), "0.6")

    def test_bucket_metrics_need_allocations_classification_and_known_cash(self):
        no_alloc = env_for(context(portfolio_value=portfolio(SPECS, cash="1000")))
        assert (
            reasons(value("bucket_weight", "equity", env=no_alloc))
            == "No bucket allocations were computed"
        )
        assert (
            reasons(value("unclassified_weight", env=no_alloc))
            == "No bucket allocations were computed"
        )
        assert reasons(value("bucket_weight", "nope")) == "No allocation computed for bucket nope"
        value_with_new = portfolio([*SPECS, h(instrument("NEW"), value="3000")], cash="1000")
        unclassified = context(
            portfolio_value=value_with_new,
            allocations=ALLOCATIONS,
            unclassified=[value_with_new.valued[-1]],
        )
        env = env_for(unclassified)
        assert reasons(value("bucket_drift_pp", "equity", env=env)).startswith(
            "Holdings that match no bucket are 23.1%"
        )
        assert reasons(value("tagged_weight", "core", env=env)).startswith(
            "Holdings that match no bucket"
        )
        assert approx(value("unclassified_weight", env=env), str(3000 / 13000))
        gap_alloc = context(
            portfolio_value=portfolio(SPECS, cash="1000"),
            allocations=[alloc("cash", weight=0.1, target=0.1, cash_history_gap=True)],
        )
        assert "holds negative cash" in reasons(
            value("bucket_weight", "cash", env=env_for(gap_alloc))
        )

    def test_deposit_and_plan_metrics_need_data(self):
        bare = env_for(context(portfolio_value=portfolio(SPECS)))
        assert reasons(value("days_since_last_deposit", env=bare)) == "No deposits recorded"
        assert (
            reasons(value("monthly_contribution", env=bare))
            == "The strategy has no contributions plan"
        )

    def test_max_position_weight_is_unknown_when_one_position_is_stale(self):
        env = env_for(
            context(
                portfolio_value=portfolio([h(ETF, value="9900"), h(PKN, value="100", stale=True)])
            )
        )
        assert (
            reasons(value("max_position_weight", env=env))
            == "Price of PKN is stale (last close 2026-09-22)"
        )


class TestInstrumentMetrics:
    def test_text_metrics(self):
        env = env_for(symbol="VWCE")
        assert value("symbol", env=env) == "VWCE"
        assert value("asset_class", env=env) == "etf"
        assert value("currency", env=env) == "PLN"
        assert value("mic", env=env) == "XETR"
        assert (
            reasons(value("mic", env=env_for(symbol="EDO0536")))
            == "EDO0536 has no exchange code (mic)"
        )
        assert value("holding_has_tag", "Core", env=env) is True
        assert value("holding_has_tag", "satellite", env=env) is False

    def test_values_and_returns(self):
        env = env_for(symbol="PKN")
        assert approx(value("weight", env=env), "0.15")
        assert value("market_value", env=env) == d("1500")
        assert value("cost_basis", env=env) == d("2000")
        assert approx(value("unrealized_pct", env=env), "-0.25")
        assert value("unrealized_value", env=env) == d("-500")

    def test_price_series_metrics(self):
        env = env_for(symbol="VWCE")
        assert value("last_close", env=env) == d("96")
        assert approx(value("drawdown_from_high", 5, env=env), "0.2")
        assert approx(value("drawdown_from_high", 2, env=env), "0")
        assert approx(value("price_change", 5, env=env), "-0.04")
        assert approx(value("price_vs_sma", 5, env=env), str(Decimal(96) / Decimal("103.2") - 1))
        assert reasons(value("drawdown_from_high", 10, env=env)) == "Only 5 of 10 bars for VWCE"
        assert reasons(value("price_change", 6, env=env)) == "Only 5 of 6 bars for VWCE"

    def test_series_metrics_unknown_without_series_stale_or_at_cost(self):
        assert reasons(value("last_close", env=env_for(symbol="PKN"))) == "No price series for PKN"
        assert reasons(value("drawdown_from_high", 5, env=env_for(symbol="EDO0536"))) == (
            "EDO0536 is valued at cost, so it has no market price series"
        )
        old = context(
            portfolio_value=portfolio(SPECS, cash="1000"),
            series={ETF: bars(ETF, ["100", "90"], last_date=day("2026-09-20"))},
        )
        assert reasons(value("price_vs_sma", 2, env=env_for(old, symbol="VWCE"))) == (
            "Price of VWCE is stale (last close 2026-09-20, 12 days old)"
        )
        loose = context(
            portfolio_value=portfolio(SPECS, cash="1000"),
            series={ETF: bars(ETF, ["100", "90"], last_date=day("2026-09-20"))},
            data=DataQualityPolicy(max_price_age_days=14),
        )
        assert approx(value("price_change", 2, env=env_for(loose, symbol="VWCE")), "-0.1")

    def test_instrument_values_unknown_on_stale_price_unknown_cost_or_fx(self):
        stale = env_for(
            context(
                portfolio_value=portfolio([h(PKN, value="100", stale=True), h(ETF, value="9900")])
            ),
            symbol="PKN",
        )
        assert (
            reasons(value("weight", env=stale)) == "Price of PKN is stale (last close 2026-09-22)"
        )
        assert (
            reasons(value("market_value", env=stale))
            == "Price of PKN is stale (last close 2026-09-22)"
        )
        assert (
            reasons(value("unrealized_pct", env=stale))
            == "Price of PKN is stale (last close 2026-09-22)"
        )
        assert (
            reasons(value("unrealized_value", env=stale))
            == "Price of PKN is stale (last close 2026-09-22)"
        )
        no_cost = env_for(context(portfolio_value=portfolio([h(PKN, cost=None)])), symbol="PKN")
        assert reasons(value("cost_basis", env=no_cost)).startswith("Cost basis of PKN is unknown")
        assert reasons(value("unrealized_pct", env=no_cost)).startswith(
            "Cost basis of PKN is unknown"
        )
        assert reasons(value("unrealized_value", env=no_cost)).startswith(
            "Cost basis of PKN is unknown"
        )
        usd = instrument("AAPL", currency=Currency.USD, mic="XNAS")
        fx_ctx = context(
            portfolio_value=portfolio([h(usd)], missing_fx_currencies=frozenset({Currency.USD})),
            series={usd: bars(usd, ["1", "2"])},
        )
        fx = env_for(fx_ctx, symbol="AAPL")
        assert (
            reasons(value("last_close", env=fx))
            == "No usable USD FX rate, so AAPL cannot be valued"
        )
        assert reasons(value("weight", env=fx)).startswith("No usable USD/PLN FX rate")

    def test_manual_valuations_have_no_series_and_no_market_result(self):
        frozen = instrument("FTX", asset_class=AssetClass.CLAIM, mic=None)
        ctx = context(
            portfolio_value=portfolio(
                [h(ETF, value="10000"), h(frozen, value="0", cost="3000", manual=True)]
            ),
            series={frozen: bars(frozen, ["10", "10"])},
        )
        env = env_for(ctx, symbol="FTX")
        manual = "FTX is valued manually, so its change from cost is not a market result"
        assert reasons(value("unrealized_pct", env=env)) == manual
        assert reasons(value("unrealized_value", env=env)) == manual
        assert reasons(value("drawdown_from_high", 2, env=env)) == (
            "FTX is valued manually, so it has no market price series"
        )
        assert value("market_value", env=env) == 0, "the manual value itself is a known value"
        assert value("weight", env=env) == Decimal("0.0")
        assert value("cost_basis", env=env) == d("3000")

    def test_cash_like_position_in_scope_when_named(self):
        env = env_for(symbol="MMF")
        assert value("asset_class", env=env) == "cash"


class TestBucketMetrics:
    def test_values(self):
        env = env_for(bucket="bonds")
        assert value("bucket_id", env=env) == "bonds"
        assert approx(value("weight", env=env), "0.1")
        assert approx(value("target", env=env), "0.2")
        assert approx(value("drift_pp", env=env), "-10")
        assert approx(value("drift_rel", env=env), "-0.5")
        assert value("value", env=env) == d("1000.00")
        assert value("drift_value", env=env) == d("-1000.00")

    def test_drift_rel_is_unknown_for_a_zero_target(self):
        assert reasons(value("drift_rel", env=env_for(bucket="gold"))) == (
            "The relative drift of bucket gold is undefined (target 0)"
        )
        assert approx(value("drift_pp", env=env_for(bucket="gold")), "2")

    def test_bucket_values_unknown_on_untrusted_data(self):
        stale = context(
            portfolio_value=portfolio([h(ETF, value="9000", stale=True), h(PKN, value="1000")]),
            allocations=ALLOCATIONS,
        )
        env = env_for(stale, bucket="bonds")
        for name in ("weight", "drift_pp", "drift_rel", "value", "drift_value"):
            assert reasons(value(name, env=env)).startswith("Stale prices cover 90.0%"), name
        assert approx(value("target", env=env), "0.2")


@pytest.mark.parametrize("scope", list(Scope))
def test_names_in_scope_only_lists_usable_metrics(scope):
    for name in names_in_scope(scope):
        assert scope in METRICS[name].scopes
