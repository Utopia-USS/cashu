"""Rule catalog and engine: order, error isolation (Skipped), empty rules (NotFired)."""

from __future__ import annotations

from collections.abc import Mapping

import pytest
from rules_fixtures import context, d, day, describe, h, instrument, portfolio, skip_reason

from cashu.modules.investments.rules import (
    BUILT_IN_KINDS,
    CashLevelParams,
    CashLevelRule,
    ContributionGapParams,
    ContributionPlan,
    DrawdownFromHighParams,
    NotFired,
    ParamErrors,
    PositionConcentrationParams,
    RuleCatalog,
    RuleContext,
    RulesEngine,
    RuleSpec,
    Skipped,
    UnrealizedThresholdParams,
)

PKN = instrument("PKN")
CTX = context(
    portfolio_value=portfolio(
        [h(PKN, value="9000", cost="10000")], cash="1000", deposits=(day("2026-09-30"),)
    ),
    contributions=ContributionPlan(monthly_amount=d("1000")),
)


class _Exploding:
    kind = "exploding"
    params_type = int

    def parse_params(self, raw: Mapping[str, object], errors: ParamErrors) -> int:
        return 0

    def evaluate(self, ctx: RuleContext, spec: RuleSpec[int]):
        raise RuntimeError("boom")


class _Confused(_Exploding):
    kind = "confused"

    def evaluate(self, ctx: RuleContext, spec: RuleSpec[int]):
        return [NotFired("someone_else")]


class TestCatalog:
    def test_built_in_kinds(self):
        assert RuleCatalog.built_in().kinds == BUILT_IN_KINDS
        assert BUILT_IN_KINDS == (
            "allocation_drift",
            "position_concentration",
            "loss_from_cost",
            "gain_from_cost",
            "drawdown_from_high",
            "cash_level",
            "contribution_gap",
            "tagged_weight",
            "custom",
        )

    def test_registering_twice_raises(self):
        catalog = RuleCatalog.built_in()
        with pytest.raises(ValueError, match="already registered"):
            catalog.register(CashLevelRule())
        assert catalog.get("nope") is None
        assert "cash_level" in catalog


class TestEngine:
    def test_runs_every_rule_in_order(self):
        engine = RulesEngine(
            [
                RuleSpec(
                    "concentration", "position_concentration", PositionConcentrationParams(0.5)
                ),
                RuleSpec("cash", "cash_level", CashLevelParams(max_weight=0.05)),
                RuleSpec("deposits", "contribution_gap", ContributionGapParams()),
                RuleSpec("loss", "loss_from_cost", UnrealizedThresholdParams(0.05)),
            ]
        )
        assert [describe(o) for o in engine.evaluate(CTX)] == [
            "fired concentration|i:i-PKN",
            "fired cash",
            "not_fired deposits",
            "fired loss|i:i-PKN",
        ]

    def test_broken_rules_become_whole_rule_skipped(self):
        catalog = RuleCatalog.built_in()
        catalog.register(_Exploding())
        catalog.register(_Confused())
        outcomes = RulesEngine(
            [
                RuleSpec("unknown", "nope", 1),
                RuleSpec("wrong_params", "cash_level", "not params"),
                RuleSpec("boom", "exploding", 0),
                RuleSpec("confused", "confused", 0),
                RuleSpec("cash", "cash_level", CashLevelParams(max_weight=0.05)),
            ],
            catalog,
        ).evaluate(CTX)
        assert [describe(o) for o in outcomes] == [
            "skipped unknown",
            "skipped wrong_params",
            "skipped boom",
            "skipped confused",
            "fired cash",
        ]
        assert skip_reason(outcomes[0]) == 'Unknown rule kind "nope"'
        assert (
            skip_reason(outcomes[1])
            == "Rule params have the wrong type (str, expected CashLevelParams)"
        )
        assert skip_reason(outcomes[2]) == "Rule failed: RuntimeError: boom"
        assert "someone_else" in skip_reason(outcomes[3])
        assert all(o.dedup_key is None for o in outcomes if isinstance(o, Skipped))

    def test_a_rule_with_nothing_to_check_yields_one_whole_rule_not_fired(self):
        outcomes = RulesEngine(
            [RuleSpec("dips", "drawdown_from_high", DrawdownFromHighParams(0.2))]
        ).evaluate(context())
        assert outcomes == [NotFired("dips", None, {"scopes": 0})]

    def test_build_takes_the_allocation_result(self):
        ctx = RuleContext.build(
            profile_id="p",
            as_of=CTX.as_of,
            portfolio=CTX.portfolio,
            market=CTX.market,
            allocation=None,
        )
        assert ctx.allocations == () and ctx.unclassified == ()
