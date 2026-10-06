"""Engine text the owner sees is Polish (F7-INT I1): one test per producer of signal messages and skip
reasons (custom rules, allocation drift, expression metrics, the evaluator, alerts), the Polish number
formatting they share, and the strict MCP mode still scrubbing amounts out of the Polish text."""

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
from cashu.modules.investments.domain import AssetClass
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

NB = " "
ETF = instrument("VWCE", asset_class=AssetClass.ETF)
BUCKETS = (alloc("equity", weight=0.78, target=0.70), alloc("bonds", weight=0.12, target=0.20))


def test_polish_number_formatting():
    assert format_pct(0.1234) == f"12,3{NB}%"
    assert format_pct(-0.05) == f"-5,0{NB}%"
    assert format_pp(-8.0) == f"-8,0{NB}pp"
    assert format_amount(Decimal("-1234567.5")) == f"-1{NB}234{NB}568"
    assert format_amount(Decimal(999)) == "999"
    assert format_decimal(Decimal("1234.50")) == f"1{NB}234,5"
    assert format_decimal(Decimal("0.0001")) == "0,0001"
    assert (days_phrase(1), days_phrase(2), days_phrase(12)) == ("1 dzień", "2 dni", "12 dni")


def test_custom_rule_default_message_and_bucket_prefix():
    kind = CustomRule()
    ctx = context(portfolio_value=portfolio([h(ETF, value="100000")]), allocations=BUCKETS)
    outcomes = run(kind, ctx, parse_ok(kind, {"when": "drift_pp <= -5", "scope": "bucket"}))
    assert isinstance(outcomes[1], Fired)
    assert candidate(outcomes[1]).message == (
        f"Koszyk bonds: Warunek spełniony: drift_pp <= -5 (drift_pp -8,0{NB}pp)."
    )
    assert candidate(outcomes[1]).payload["when"] == "drift_pp <= -5"


def test_allocation_drift_messages_and_negative_cash_skip():
    gap = alloc("cash", weight=0, target=0.10, cash_history_gap=True)
    ctx = context(portfolio_value=portfolio([h(ETF, value="100000")]), allocations=[*BUCKETS, gap])
    outcomes = run(AllocationDriftRule(), ctx, AllocationDriftParams())
    assert [candidate(o).message for o in outcomes[:2]] == [
        f"Koszyk equity powyżej celu o 8,0{NB}pp (78,0{NB}% wobec 70,0{NB}%, 8{NB}000 PLN ponad cel).",
        (
            f"Koszyk bonds poniżej celu o 8,0{NB}pp (12,0{NB}% wobec 20,0{NB}%, "
            f"do celu brakuje 8{NB}000 PLN)."
        ),
    ]
    assert candidate(outcomes[0]).payload["direction"] == "overweight"  # payload values unchanged
    assert skip_reason(outcomes[2]) == (
        "Koszyk cash: ujemna gotówka (brak wpłat w zaimportowanej historii), wartość nieznana"
    )


def test_metric_reason_for_a_bucket_holding_negative_cash():
    gap = alloc("cash", weight=0.1, target=0.1, cash_history_gap=True)
    ctx = context(portfolio_value=portfolio([h(ETF)], cash="1000"), allocations=[gap])
    expression = compile_expression('bucket_weight("cash") > 5%', Scope.PORTFOLIO)
    evaluation = evaluate(expression, MetricEnv(ctx).resolve)
    assert evaluation.result is None
    assert evaluation.reasons == (
        "Koszyk cash: ujemna gotówka (brak wpłat w zaimportowanej historii), wartość nieznana",
    )


def test_evaluator_reason_for_a_division_by_zero():
    kind = CustomRule()
    ctx = context(portfolio_value=portfolio([h(ETF)], cash="0"))
    outcomes = run(kind, ctx, parse_ok(kind, {"when": "cash_value / cash_value > 1"}))
    assert skip_reason(outcomes[0]) == "Dzielenie przez zero (kolumna 12)"


def test_alert_bucket_subject_and_skip_reasons():
    ctx = context(
        portfolio_value=portfolio([h(ETF, value="9000")], cash="1000"), allocations=BUCKETS
    )

    def check(params: dict, data_ctx=ctx) -> object:
        definition = AlertDefinition(
            id=3, kind=AlertKind.WEIGHT_BELOW, scope=AlertScope.BUCKET, params=params, title="Mało"
        )
        return evaluate_alert(definition, AlertData(as_of=ctx.as_of, bars={}, ctx=data_ctx)).outcome

    fired = check({"threshold": 0.2, "bucket": "bonds"})
    assert isinstance(fired, Fired)
    assert fired.candidate.message == f"Mało: Koszyk bonds: 12,0{NB}% portfela (poniżej 20,0{NB}%)."
    missing = check({"threshold": 0.2, "bucket": "gold"})
    assert isinstance(missing, Skipped)
    assert missing.reason == "Brak alokacji koszyka gold (czy jest w strategii?)"
    unvalued = check({"threshold": 0.2, "bucket": "bonds"}, data_ctx=None)
    assert isinstance(unvalued, Skipped) and unvalued.reason == "Nie udało się wycenić portfela"


def test_strict_mode_still_scrubs_amounts_from_the_polish_text():
    when = "cash_value > 7000"
    message = (
        f"Gotówka: Warunek spełniony: {when} (cash_value 12{NB}345 PLN, cash_weight 20,0{NB}%)."
    )
    strict = custom_signal_message(SimpleNamespace(strict=True), message, when)
    assert strict.value == (
        f"Gotówka: Warunek spełniony: cash_value > [amount] (cash_value # PLN, cash_weight 20,0{NB}%)."
    )
    drift = (
        f"Koszyk x powyżej celu o 12,5{NB}pp (62,5{NB}% wobec 50,0{NB}%, 1{NB}234 PLN ponad cel)."
    )
    scrubbed = Redactor("strict").apply({"message": L.text(drift)})["message"]
    assert scrubbed == (
        f"Koszyk x powyżej celu o 12,5{NB}pp (62,5{NB}% wobec 50,0{NB}%, [amount] ponad cel)."
    )
