"""custom rules: params validation, per-scope evaluation, fired / not fired / skipped (missing data never
fires), messages and payloads, and the engine + lifecycle integration."""

from __future__ import annotations

from datetime import UTC, datetime

from rules_fixtures import (
    alloc,
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

from finanse.modules.investments.domain import AssetClass, SignalSeverity
from finanse.modules.investments.rules import (
    CustomParams,
    CustomRule,
    InstrumentFilter,
    NotFired,
    OpenSignal,
    RulesEngine,
    RuleSpec,
    reconcile_signals,
)
from finanse.modules.investments.rules.expr import Scope

KIND = CustomRule()
ETF = instrument("VWCE", asset_class=AssetClass.ETF, tags=("core",))
PKN = instrument("PKN", tags=("satellite",))
CDR = instrument("CDR", tags=("satellite",))


def params(when: str, scope: str = "portfolio", **extra) -> CustomParams:
    return parse_ok(KIND, {"when": when, "scope": scope, **extra})


class TestParseParams:
    def test_defaults_to_portfolio_scope(self):
        parsed = parse_ok(KIND, {"when": "cash_weight > 10%"})
        assert parsed.scope == Scope.PORTFOLIO
        assert parsed.expression is not None and parsed.expression.source == "cash_weight > 10%"
        assert parsed.message is None

    def test_reads_message_filters_and_buckets(self):
        parsed = params(
            "weight > 5%",
            "instrument",
            message="  Too big  ",
            tags=["satellite"],
            asset_class="equity",
        )
        assert parsed.message == "Too big"
        assert parsed.filter == InstrumentFilter(frozenset({AssetClass.EQUITY}), ("satellite",))
        bucket = params("drift_pp > 5", "bucket", buckets=["bonds"])
        assert bucket.buckets == ("bonds",)
        assert bucket.bucket_references == ("bonds",)

    def test_when_is_required_and_must_be_text(self):
        assert (
            parse_issues(KIND, {})[0].message
            == 'when is required: a condition such as "weight > 10%"'
        )
        assert parse_issues(KIND, {"when": 5})[0].message == "when must be text, got 5"

    def test_expression_errors_carry_the_column_and_offset(self):
        issue = parse_issues(KIND, {"when": "weight > 10%", "scope": "portfolio"})[0]
        assert issue.key == "when"
        assert issue.message == (
            "weight is not available in scope portfolio (available in: instrument, bucket) "
            "(column 1 of the expression)"
        )
        assert issue.offset == 0
        syntax = parse_issues(KIND, {"when": "cash_weight >> 1"})[0]
        assert syntax.offset == 13

    def test_unknown_scope_with_hint_and_no_misleading_expression_error(self):
        issues = parse_issues(KIND, {"when": "weight > 1", "scope": "instrumnet"})
        assert [i.key for i in issues] == ["scope"]
        assert 'did you mean "instrument"' in issues[0].message

    def test_filters_and_buckets_only_in_their_scope(self):
        issues = parse_issues(KIND, {"when": "cash_weight > 1", "tags": ["x"], "buckets": ["b"]})
        assert [(i.key, i.message) for i in issues] == [
            ("tags", "tags only applies to scope instrument"),
            ("buckets", "buckets only applies to scope bucket"),
        ]

    def test_message_limits_and_unknown_keys(self):
        assert (
            "one line of at most 200"
            in parse_issues(KIND, {"when": "cash_weight > 1", "message": "x" * 201})[0].message
        )
        assert (
            parse_issues(KIND, {"when": "cash_weight > 1", "message": " "})[0].message
            == "message must not be empty"
        )
        warning = parse_issues(KIND, {"when": "cash_weight > 1", "scop": "bucket"})[0]
        assert not warning.is_error and 'did you mean "scope"' in warning.message


class TestPortfolioScope:
    def test_fires_with_message_and_values(self):
        value = portfolio([h(ETF, value="8000")], cash="2000", deposits=(day("2026-09-01"),))
        outcomes = run(
            KIND,
            context(portfolio_value=value),
            params(
                "cash_weight >= 15% and days_since_last_deposit <= 45", message="Invest the cash"
            ),
            severity=SignalSeverity.ACTION,
        )
        assert [describe(o) for o in outcomes] == ["fired r"]
        fired = candidate(outcomes[0])
        assert fired.kind == "custom"
        assert fired.severity == SignalSeverity.ACTION
        assert fired.message == (
            "Invest the cash (cash_weight 20,0\u00a0%, days_since_last_deposit 31)."
        )
        assert fired.payload == {
            "scope": "portfolio",
            "when": "cash_weight >= 15% and days_since_last_deposit <= 45",
            "values": {"cash_weight": 0.2, "days_since_last_deposit": 31},
        }

    def test_default_message_and_not_fired(self):
        value = portfolio([h(ETF, value="9000")], cash="1000")
        fired = run(KIND, context(portfolio_value=value), params("total_value >= 10000"))
        assert (
            candidate(fired[0]).message
            == "Warunek spełniony: total_value >= 10000 (total_value 10\u00a0000 PLN)."
        )
        quiet = run(KIND, context(portfolio_value=value), params("cash_weight > 50%"))
        assert [describe(o) for o in quiet] == ["not_fired r"]
        assert isinstance(quiet[0], NotFired)
        assert quiet[0].details["values"] == {"cash_weight": 0.1}

    def test_missing_data_skips_never_fires(self):
        stale = portfolio([h(ETF, value="9000", stale=True)], cash="1000")
        outcomes = run(KIND, context(portfolio_value=stale), params("cash_weight < 50%"))
        assert [describe(o) for o in outcomes] == ["skipped r"]
        assert skip_reason(outcomes[0]) == (
            "Nieaktualne ceny: 90,0\u00a0% portfela (maks 5,0\u00a0%)"
        )

    def test_a_false_side_decides_even_with_missing_data(self):
        stale = portfolio([h(ETF, value="9000", stale=True)], cash="1000")
        outcomes = run(
            KIND,
            context(portfolio_value=stale),
            params("cash_weight < 50% and total_value > 1000000"),
        )
        assert [describe(o) for o in outcomes] == ["skipped r"], "total_value is untrusted too"
        decided = run(
            KIND, context(portfolio_value=stale), params("cash_weight < 50% and stale_weight < 10%")
        )
        assert [describe(o) for o in decided] == ["not_fired r"]
        assert decided[0].details["values"]["cash_weight"] is None


class TestInstrumentScope:
    def test_one_outcome_per_instrument_with_filters(self):
        value = portfolio(
            [
                h(ETF, value="7000", cost="5000"),
                h(PKN, value="2000", cost="4000"),
                h(CDR, value="1000", cost="900"),
            ]
        )
        rule = params(
            "unrealized_pct <= -25% and weight < 30%",
            "instrument",
            tags=["satellite"],
            message="Review the thesis",
        )
        outcomes = run(KIND, context(portfolio_value=value), rule)
        assert [describe(o) for o in outcomes] == ["fired r|i:i-PKN", "not_fired r|i:i-CDR"]
        fired = candidate(outcomes[0])
        assert fired.instrument_id == "i-PKN"
        assert fired.message == (
            "PKN: Review the thesis (unrealized_pct -50,0\u00a0%, weight 20,0\u00a0%)."
        )
        assert fired.payload["symbol"] == "PKN"
        assert fired.payload["values"] == {"unrealized_pct": -0.5, "weight": 0.2}

    def test_price_series_metrics_and_per_instrument_skips(self):
        value = portfolio([h(ETF), h(PKN)])
        ctx = context(
            portfolio_value=value, series={ETF: bars(ETF, ["100", "100", "100", "100", "70"])}
        )
        outcomes = run(KIND, ctx, params("drawdown_from_high(5) >= 20%", "instrument"))
        assert [describe(o) for o in outcomes] == ["fired r|i:i-VWCE", "skipped r|i:i-PKN"]
        assert skip_reason(outcomes[1]) == "Brak notowań: PKN"
        assert candidate(outcomes[0]).message == (
            "VWCE: Warunek spełniony: drawdown_from_high(5) >= 20% "
            "(drawdown_from_high(5) 30,0\u00a0%)."
        )

    def test_text_metrics(self):
        value = portfolio([h(ETF, value="6000"), h(PKN, value="4000")])
        outcomes = run(
            KIND,
            context(portfolio_value=value),
            params('asset_class == "equity" and weight > 30%', "instrument"),
        )
        assert [describe(o) for o in outcomes] == ["not_fired r|i:i-VWCE", "fired r|i:i-PKN"]

    def test_no_instrument_in_scope_gives_no_outcome(self):
        assert run(KIND, context(), params("weight > 1%", "instrument")) == []


class TestBucketScope:
    ALLOCATIONS = (
        alloc("equity", weight=0.78, target=0.70),
        alloc("bonds", weight=0.12, target=0.20),
        alloc("cash", weight=0.10, target=0.10),
    )

    def test_one_outcome_per_bucket(self):
        ctx = context(
            portfolio_value=portfolio([h(ETF, value="100000")]), allocations=self.ALLOCATIONS
        )
        outcomes = run(KIND, ctx, params("drift_pp <= -5 or drift_pp >= 5", "bucket"))
        assert [describe(o) for o in outcomes] == [
            "fired r|s:equity",
            "fired r|s:bonds",
            "not_fired r|s:cash",
        ]
        assert candidate(outcomes[1]).message == (
            "Koszyk bonds: Warunek spełniony: drift_pp <= -5 or drift_pp >= 5 (drift_pp -8,0\u00a0pp)."
        )
        assert candidate(outcomes[1]).payload["bucket_id"] == "bonds"

    def test_subset_missing_bucket_and_no_allocations(self):
        ctx = context(
            portfolio_value=portfolio([h(ETF, value="100000")]), allocations=self.ALLOCATIONS
        )
        subset = run(KIND, ctx, params("drift_value < -5000", "bucket", buckets=["bonds", "gold"]))
        assert [describe(o) for o in subset] == ["fired r|s:bonds", "skipped r|s:gold"]
        none = run(
            KIND, context(portfolio_value=portfolio([h(ETF)])), params("drift_pp > 1", "bucket")
        )
        assert [describe(o) for o in none] == ["skipped r"]
        assert skip_reason(subset[1]) == "Brak alokacji koszyka gold"
        assert skip_reason(none[0]) == "Brak wyliczonej alokacji koszyków"

    def test_bucket_scope_skips_on_unclassified_holdings(self):
        new = instrument("NEW", asset_class=AssetClass.ETF)
        value = portfolio([h(ETF, value="5000"), h(new, value="5000")])
        ctx = context(
            portfolio_value=value, allocations=self.ALLOCATIONS, unclassified=[value.valued[1]]
        )
        outcomes = run(KIND, ctx, params("weight > target", "bucket"))
        assert all(describe(o).startswith("skipped") for o in outcomes)
        assert skip_reason(outcomes[0]).startswith("Pozycje bez koszyka: 50,0\u00a0%")


def test_engine_and_lifecycle_integration():
    spec = RuleSpec(
        "dip", "custom", params("drawdown_from_high(5) >= 20%", "instrument"), cooldown_days=3
    )
    value = portfolio([h(ETF), h(PKN)])
    crash = context(
        portfolio_value=value, series={ETF: bars(ETF, ["100", "100", "100", "100", "70"])}
    )
    outcomes = RulesEngine([spec]).evaluate(crash)
    now = datetime(2026, 10, 2, tzinfo=UTC)
    first = reconcile_signals(open_signals=[], outcomes=outcomes, rules=[spec], clock=lambda: now)
    assert [a.candidate.dedup_key for a in first.created] == ["dip|i:i-VWCE"]
    # Next run: VWCE recovered, PKN still has no series -> VWCE resolves, nothing new.
    recovered = context(
        portfolio_value=value, series={ETF: bars(ETF, ["100", "100", "100", "100", "99"])}
    )
    second = reconcile_signals(
        open_signals=[OpenSignal("s1", "dip", "dip|i:i-VWCE", SignalSeverity.INFO)],
        outcomes=RulesEngine([spec]).evaluate(recovered),
        rules=[spec],
        clock=lambda: now,
    )
    assert [a.dedup_key for a in second.resolved] == ["dip|i:i-VWCE"]
    assert second.created == []
    # A run where VWCE data is stale: the open signal stays untouched.
    stale = context(
        portfolio_value=value, series={ETF: bars(ETF, ["100", "70"], last_date=day("2026-09-01"))}
    )
    third = reconcile_signals(
        open_signals=[OpenSignal("s1", "dip", "dip|i:i-VWCE", SignalSeverity.INFO)],
        outcomes=RulesEngine([spec]).evaluate(stale),
        rules=[spec],
        clock=lambda: now,
    )
    assert third.actions == ()
    assert [s.dedup_key for s in third.untouched] == ["dip|i:i-VWCE"]
