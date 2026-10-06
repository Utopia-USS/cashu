"""Owner-facing text never names a non-generic bucket (F7 re-review B5): custom rule prefix, condition and
shown values, allocation_drift messages, skip reasons and bucket alert subjects. Generic buckets keep
their id in the text; every payload keeps the id for the agent (MCP structured fields)."""

from __future__ import annotations

from types import SimpleNamespace

from rules_fixtures import alloc, candidate, context, h, instrument, parse_ok, portfolio, run

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
)
from cashu.modules.investments.rules.kinds.support import (
    bucket_cash_gap_problem,
    bucket_named,
    no_allocation_problem,
)

NB = " "
ETF = instrument("VWCE", asset_class=AssetClass.ETF)
# "core" is the owner's own bucket, "bonds" a generic one
BUCKETS = (alloc("core", weight=0.78, target=0.70), alloc("bonds", weight=0.22, target=0.30))


def _ctx():
    return context(portfolio_value=portfolio([h(ETF, value="100000")]), allocations=BUCKETS)


def test_bucket_named():
    assert bucket_named("Koszyk", "bonds") == "Koszyk bonds"
    assert bucket_named("Koszyk", "core") == "Koszyk"
    assert bucket_named("koszyka", "Cash") == "koszyka"  # exact, case-sensitive match


def test_custom_bucket_scope_prefix_only_for_a_generic_bucket():
    kind = CustomRule()
    outcomes = run(
        kind, _ctx(), parse_ok(kind, {"when": "drift_pp >= 5 or drift_pp <= -5", "scope": "bucket"})
    )
    core, bonds = (candidate(o) for o in outcomes)
    assert core.message == (
        f"Warunek spełniony: drift_pp >= 5 or drift_pp <= -5 (drift_pp 8,0{NB}pp)."
    )
    assert "core" not in core.message and core.payload["bucket_id"] == "core"
    assert bonds.message == (
        f"Koszyk bonds: Warunek spełniony: drift_pp >= 5 or drift_pp <= -5 (drift_pp -8,0{NB}pp)."
    )


def test_custom_condition_and_values_naming_an_own_bucket_stay_out_of_the_text():
    kind = CustomRule()
    own = run(
        kind,
        _ctx(),
        parse_ok(kind, {"when": 'bucket_weight("core") > 50% and holdings_count >= 1'}),
    )
    (fired,) = own
    assert isinstance(fired, Fired)
    assert candidate(fired).message == "Warunek spełniony (holdings_count 1)."
    assert candidate(fired).payload["when"] == 'bucket_weight("core") > 50% and holdings_count >= 1'
    assert candidate(fired).payload["values"]['bucket_weight("core")'] == 0.78
    generic = candidate(
        run(kind, _ctx(), parse_ok(kind, {"when": 'bucket_weight("bonds") > 5%'}))[0]
    )
    assert generic.message == (
        f'Warunek spełniony: bucket_weight("bonds") > 5% (bucket_weight("bonds") 22,0{NB}%).'
    )
    # strict MCP still scrubs the message when the condition is not part of it
    ctx = SimpleNamespace(strict=True)
    assert custom_signal_message(
        ctx, candidate(fired).message, candidate(fired).payload["when"]
    ).value == ("Warunek spełniony (holdings_count #).")


def test_drift_messages_name_only_generic_buckets():
    outcomes = run(AllocationDriftRule(), _ctx(), AllocationDriftParams())
    core, bonds = (candidate(o) for o in outcomes)
    assert core.message == (
        f"Koszyk powyżej celu o 8,0{NB}pp (78,0{NB}% wobec 70,0{NB}%, 8{NB}000 PLN ponad cel)."
    )
    assert core.payload["bucket_id"] == "core" and core.payload["bucket_generic"] is False
    assert bonds.message.startswith(f"Koszyk bonds poniżej celu o 8,0{NB}pp")


def test_skip_reasons_name_only_generic_buckets():
    assert no_allocation_problem("core") == "Brak alokacji koszyka"
    assert no_allocation_problem("bonds") == "Brak alokacji koszyka bonds"
    assert bucket_cash_gap_problem("core").startswith("Koszyk: ujemna gotówka")
    assert bucket_cash_gap_problem("cash").startswith("Koszyk cash: ujemna gotówka")


def _alert(kind: AlertKind, params: dict) -> object:
    ctx = _ctx()
    definition = AlertDefinition(
        id=4, kind=kind, scope=AlertScope.BUCKET, params=params, title="Mój alert"
    )
    return evaluate_alert(definition, AlertData(as_of=ctx.as_of, bars={}, ctx=ctx)).outcome


def test_bucket_alert_subject_is_neutral_for_an_own_bucket():
    own = _alert(AlertKind.WEIGHT_BELOW, {"threshold": 0.9, "bucket": "core"})
    assert isinstance(own, Fired)
    assert own.candidate.message == f"Mój alert: Koszyk: 78,0{NB}% portfela (poniżej 90,0{NB}%)."
    assert own.candidate.payload["bucket_id"] == "core"
    generic = _alert(AlertKind.WEIGHT_ABOVE, {"threshold": 0.1, "bucket": "bonds"})
    assert generic.candidate.message == (
        f"Mój alert: Koszyk bonds: 22,0{NB}% portfela (powyżej 10,0{NB}%)."
    )
    missing = _alert(AlertKind.WEIGHT_BELOW, {"threshold": 0.9, "bucket": "satellite"})
    assert missing.reason == "Brak alokacji koszyka (czy jest w strategii?)"


def test_custom_bucket_alert_has_no_prefix_for_an_own_bucket():
    own = _alert(AlertKind.CUSTOM, {"expression": "drift_pp >= 5", "bucket": "core"})
    assert isinstance(own, Fired)
    assert (
        own.candidate.message
        == f"Mój alert: Warunek spełniony: drift_pp >= 5 (drift_pp 8,0{NB}pp)."
    )
    assert own.candidate.payload["bucket_id"] == "core"
