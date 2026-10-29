"""Engine text in English (localization): the same producers as test_rules_polish_text (custom rules,
allocation drift, expression metrics, the evaluator, alerts, plan checks, research signals) render
English with English number formatting under ``use_language("en")``; the strict MCP mode still
scrubs amounts out of the English text."""

from __future__ import annotations

from decimal import Decimal
from types import SimpleNamespace

from rules_fixtures import (
    alloc,
    candidate,
    context,
    h,
    instrument,
    parse_ok,
    portfolio,
    run,
    skip_reason,
)

from cashu.core.i18n import use_language
from cashu.core.mcp import labels as L
from cashu.core.mcp.redaction import Redactor
from cashu.core.mcp.tools.messages import custom_signal_message
from cashu.modules.investments.alerts import (
    AlertData,
    AlertDefinition,
    AlertKind,
    AlertScope,
    evaluate_alert,
)
from cashu.modules.investments.domain import AssetClass, plan_label
from cashu.modules.investments.plan.checks import PlanFacts, check_no_exit, check_vs_thesis
from cashu.modules.investments.rules import (
    AllocationDriftParams,
    AllocationDriftRule,
    CustomRule,
    Fired,
    Skipped,
)
from cashu.modules.investments.rules.expr import Scope, compile_expression
from cashu.modules.investments.rules.expr.evaluator import evaluate
from cashu.modules.investments.rules.expr.metrics import MetricEnv
from cashu.modules.investments.rules.kinds.support import (
    days_phrase,
    format_amount,
    format_decimal,
    format_pct,
    format_pp,
)

ETF = instrument("VWCE", asset_class=AssetClass.ETF)
BUCKETS = (alloc("equity", weight=0.78, target=0.70), alloc("bonds", weight=0.12, target=0.20))


def test_english_number_formatting():
    with use_language("en"):
        assert format_pct(0.1234) == "12.3%"
        assert format_pct(-0.05) == "-5.0%"
        assert format_pp(-8.0) == "-8.0 pp"
        assert format_amount(Decimal("-1234567.5")) == "-1,234,568"
        assert format_decimal(Decimal("1234.50")) == "1,234.5"
        assert (days_phrase(1), days_phrase(2)) == ("1 day", "2 days")


def test_custom_rule_and_allocation_drift_in_english():
    ctx = context(portfolio_value=portfolio([h(ETF, value="100000")]), allocations=BUCKETS)
    kind = CustomRule()
    with use_language("en"):
        outcomes = run(kind, ctx, parse_ok(kind, {"when": "drift_pp <= -5", "scope": "bucket"}))
        assert candidate(outcomes[1]).message == (
            "Bucket bonds: Condition met: drift_pp <= -5 (drift_pp -8.0 pp)."
        )
        gap = alloc("cash", weight=0, target=0.10, cash_history_gap=True)
        ctx = context(
            portfolio_value=portfolio([h(ETF, value="100000")]), allocations=[*BUCKETS, gap]
        )
        drift = run(AllocationDriftRule(), ctx, AllocationDriftParams())
    assert [candidate(o).message for o in drift[:2]] == [
        "Bucket equity above the target by 8.0 pp (78.0% vs 70.0%, 8,000 PLN over the target).",
        "Bucket bonds below the target by 8.0 pp (12.0% vs 20.0%, 8,000 PLN short of the target).",
    ]
    assert skip_reason(drift[2]) == (
        "Bucket cash: negative cash (contributions missing from the imported history), value unknown"
    )


def test_metric_and_evaluator_reasons_in_english():
    ctx = context(portfolio_value=portfolio([h(ETF)], cash="0"))
    kind = CustomRule()
    with use_language("en"):
        outcomes = run(kind, ctx, parse_ok(kind, {"when": "cash_value / cash_value > 1"}))
        assert skip_reason(outcomes[0]) == "Division by zero (column 12)"
        expression = compile_expression('bucket_weight("gold") > 5%', Scope.PORTFOLIO)
        evaluation = evaluate(expression, MetricEnv(ctx).resolve)
    assert evaluation.reasons == ("No bucket allocation computed",)


def test_alerts_in_english():
    ctx = context(
        portfolio_value=portfolio([h(ETF, value="9000")], cash="1000"), allocations=BUCKETS
    )

    def check(params: dict, data_ctx=ctx) -> object:
        definition = AlertDefinition(
            id=3, kind=AlertKind.WEIGHT_BELOW, scope=AlertScope.BUCKET, params=params, title="Low"
        )
        return evaluate_alert(definition, AlertData(as_of=ctx.as_of, bars={}, ctx=data_ctx)).outcome

    with use_language("en"):
        fired = check({"threshold": 0.2, "bucket": "bonds"})
        missing = check({"threshold": 0.2, "bucket": "gold"})
        unvalued = check({"threshold": 0.2, "bucket": "bonds"}, data_ctx=None)
    assert isinstance(fired, Fired)
    assert fired.candidate.message == "Low: Bucket bonds: 12.0% of the portfolio (below 20.0%)."
    assert isinstance(missing, Skipped)
    assert missing.reason == "No allocation for the bucket gold (is it in the strategy?)"
    assert isinstance(unvalued, Skipped) and unvalued.reason == "The portfolio could not be valued"


def test_plan_checks_in_english():
    facts = {"instrument_id": 1, "label": "CDR", "has_exit_plan": False, "held": True, "unrealized": 0.1}
    with use_language("en"):
        assert plan_label("buy_asap", held=True) == "buy more asap"
        assert plan_label("hold", held=False) == "wait"
        vs = check_vs_thesis(PlanFacts(plan="buy_asap", health="weakened", **facts))
        no_exit = check_no_exit(PlanFacts(plan="hold", health="fulfilled", **facts))
    assert candidate(vs).message == "Recommendation: buy more asap, thesis weakened"
    assert candidate(no_exit).message == "Thesis fulfilled, no exit plan"
    assert candidate(vs).payload["health"] == "weakened"  # codes, not words


def test_strict_mode_scrubs_amounts_from_the_english_text():
    when = "cash_value > 7000"
    message = f"Cash: Condition met: {when} (cash_value 12,345 PLN, cash_weight 20.0%)."
    strict = custom_signal_message(SimpleNamespace(strict=True), message, when)
    assert strict.value == (
        "Cash: Condition met: cash_value > [amount] (cash_value # PLN, cash_weight 20.0%)."
    )
    drift = "Bucket x above the target by 12.5 pp (62.5% vs 50.0%, 1,234 PLN over the target)."
    scrubbed = Redactor("strict").apply({"message": L.text(drift)})["message"]
    assert "1,234" not in scrubbed and "234" not in scrubbed
