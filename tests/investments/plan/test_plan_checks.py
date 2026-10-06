"""Plan checks (P1), pure: ``plan_no_exit`` (fulfilled thesis or +100 % from cost without an exit plan
while the plan is not reduce / exit_asap; skipped when the gain branch has no usable price) and
``plan_vs_thesis`` (a buy plan on a weakened / invalidated thesis), their keys, messages, severities,
polarity and payload. Synthetic facts only."""

from __future__ import annotations

import pytest

from finanse.modules.investments.domain import (
    PLAN_VALUES,
    SignalSeverity,
    effective_plan,
    plan_label,
)
from finanse.modules.investments.plan import (
    GAIN_REVIEW,
    PlanFacts,
    check_no_exit,
    check_vs_thesis,
    evaluate,
    is_plan_key,
    plan_dedup_key,
    rule_specs,
)
from finanse.modules.investments.rules import Fired, NotFired, SignalPolarity, Skipped


def facts(**changes) -> PlanFacts:
    values = {
        "instrument_id": 7,
        "label": "XMPL",
        "symbol": "XMPL",
        "plan": None,
        "health": "current",
        "has_exit_plan": False,
        "unrealized": 0.2,
        "price_stale": False,
    }
    values.update(changes)
    return PlanFacts(**values)


@pytest.mark.parametrize(
    ("changes", "expected"),
    [
        # gain branch
        ({"unrealized": 1.0}, "+100 % od kosztu, brak planu wyjścia"),
        ({"unrealized": 2.5, "plan": "hold"}, "+100 % od kosztu, brak planu wyjścia"),
        ({"unrealized": 1.2, "plan": "buy"}, "+100 % od kosztu, brak planu wyjścia"),
        ({"unrealized": 1.2, "plan": "buy_asap"}, "+100 % od kosztu, brak planu wyjścia"),
        ({"unrealized": 0.99}, None),
        ({"unrealized": 1.5, "plan": "reduce"}, None),
        ({"unrealized": 1.5, "plan": "exit_asap"}, None),
        ({"unrealized": 1.5, "has_exit_plan": True}, None),
        # fulfilled branch (no price needed)
        ({"health": "fulfilled"}, "Teza spełniona, brak planu wyjścia"),
        ({"health": "fulfilled", "unrealized": None}, "Teza spełniona, brak planu wyjścia"),
        ({"health": "fulfilled", "has_exit_plan": True}, None),
        ({"health": "fulfilled", "plan": "exit_asap"}, None),
        # both: the fulfilled message wins
        ({"health": "fulfilled", "unrealized": 1.4}, "Teza spełniona, brak planu wyjścia"),
        # no thesis at +100 %: no exit plan either
        ({"health": "no_thesis", "unrealized": 1.0}, "+100 % od kosztu, brak planu wyjścia"),
    ],
)
def test_plan_no_exit_table(changes, expected):
    outcome = check_no_exit(facts(**changes))
    if expected is None:
        assert isinstance(outcome, NotFired)
        assert outcome.dedup_key == "plan:plan_no_exit|i:7"
        return
    assert isinstance(outcome, Fired)
    c = outcome.candidate
    assert c.message == expected
    assert (c.rule_id, c.kind, c.dedup_key) == (
        "plan:plan_no_exit",
        "plan:plan_no_exit",
        "plan:plan_no_exit|i:7",
    )
    assert c.severity is SignalSeverity.INFO and c.polarity is SignalPolarity.NEGATIVE
    assert c.instrument_id == "7"


def test_plan_no_exit_skips_without_a_usable_price():
    unknown = check_no_exit(facts(unrealized=None))
    stale = check_no_exit(facts(unrealized=1.5, price_stale=True))
    for outcome in (unknown, stale):
        assert isinstance(outcome, Skipped)
        assert outcome.dedup_key == "plan:plan_no_exit|i:7" and "XMPL" in outcome.reason
    # the outcome does not depend on the price: decided without it
    assert isinstance(check_no_exit(facts(unrealized=None, plan="reduce")), NotFired)
    assert isinstance(check_no_exit(facts(unrealized=None, has_exit_plan=True)), NotFired)


def test_plan_no_exit_payload_has_the_facts_used():
    gain = check_no_exit(facts(unrealized=1.23456, plan="hold"))
    assert gain.candidate.payload == {
        "check": "plan_no_exit",
        "plan": "hold",
        "health": "current",
        "has_exit_plan": False,
        "unrealized": 1.23,
        "symbol": "XMPL",
        "trigger": "gain",
        "threshold": GAIN_REVIEW,
    }
    fulfilled = check_no_exit(facts(health="fulfilled", unrealized=None))
    assert fulfilled.candidate.payload["trigger"] == "fulfilled"
    assert fulfilled.candidate.payload["unrealized"] is None


@pytest.mark.parametrize(
    ("plan", "health", "message", "severity"),
    [
        ("buy", "weakened", "Rekomendacja: dokup, teza osłabiona", SignalSeverity.INFO),
        ("buy_asap", "weakened", "Rekomendacja: dokup asap, teza osłabiona", SignalSeverity.INFO),
        ("buy", "invalidated", "Rekomendacja: dokup, teza podważona", SignalSeverity.ACTION),
        ("buy_asap", "invalidated", "Rekomendacja: dokup asap, teza podważona", SignalSeverity.ACTION),
    ],
)
def test_plan_vs_thesis_fires(plan, health, message, severity):
    outcome = check_vs_thesis(facts(plan=plan, health=health, unrealized=None))
    assert isinstance(outcome, Fired)
    c = outcome.candidate
    assert (c.message, c.severity, c.polarity) == (message, severity, SignalPolarity.NEGATIVE)
    assert c.dedup_key == "plan:plan_vs_thesis|i:7"
    assert c.payload["plan"] == plan and c.payload["health"] == health


@pytest.mark.parametrize(
    ("plan", "health"),
    [
        ("hold", "invalidated"),
        ("reduce", "weakened"),
        (None, "invalidated"),
        ("buy", "supported"),
        ("buy", "fulfilled"),
        ("buy_asap", "no_thesis"),
        ("buy", "current"),
    ],
)
def test_plan_vs_thesis_does_not_fire(plan, health):
    assert isinstance(check_vs_thesis(facts(plan=plan, health=health)), NotFired)


def test_evaluate_runs_both_checks_per_instrument():
    outcomes = evaluate([facts(), facts(instrument_id=8, plan="buy", health="invalidated")])
    assert [o.dedup_key for o in outcomes] == [
        "plan:plan_no_exit|i:7",
        "plan:plan_vs_thesis|i:7",
        "plan:plan_no_exit|i:8",
        "plan:plan_vs_thesis|i:8",
    ]
    assert [type(o) for o in outcomes] == [NotFired, NotFired, NotFired, Fired]
    assert evaluate([]) == []


def test_keys_and_specs():
    assert is_plan_key("plan:plan_no_exit") and is_plan_key(plan_dedup_key("plan_vs_thesis", 3))
    assert not is_plan_key("research:news") and not is_plan_key(None)
    assert [s.id for s in rule_specs()] == ["plan:plan_no_exit", "plan:plan_vs_thesis"]
    assert GAIN_REVIEW == 1.0


def test_plan_values_labels_and_stale_rule():
    assert PLAN_VALUES == ("buy_asap", "buy", "hold", "reduce", "exit_asap")
    assert [plan_label(p, held=True) for p in PLAN_VALUES] == [
        "dokup asap",
        "dokup",
        "trzymaj",
        "redukuj",
        "pozbądź się asap",
    ]
    assert [plan_label(p, held=False) for p in PLAN_VALUES] == [
        "kup asap",
        "kup",
        "czekam",
        None,
        None,
    ]
    assert effective_plan("reduce", held=False) is None
    assert effective_plan("exit_asap", held=False) is None
    assert effective_plan("hold", held=False) == "hold"
    assert effective_plan("reduce", held=True) == "reduce"
    assert effective_plan("reduce", held=None) == "reduce"
    assert effective_plan("bogus", held=True) is None and effective_plan(None, held=True) is None


def test_a_held_only_plan_written_before_the_holding_opened_is_stale():
    """P1 review BE-2: sold out and bought again after the plan."""
    import datetime as dt

    at = dt.datetime(2026, 2, 1, 23, 30, tzinfo=dt.UTC)
    for plan in ("reduce", "exit_asap"):
        assert effective_plan(plan, held=True, plan_at=at, opened=dt.date(2026, 2, 2)) is None
        assert effective_plan(plan, held=True, plan_at=at, opened=dt.date(2026, 2, 1)) == plan
        assert effective_plan(plan, held=True, plan_at=at, opened=dt.date(2026, 1, 5)) == plan
        assert effective_plan(plan, held=True, plan_at=None, opened=dt.date(2026, 3, 1)) == plan
    # buy / hold are not about a position: never stale by date
    assert effective_plan("hold", held=True, plan_at=at, opened=dt.date(2026, 3, 1)) == "hold"


def test_opened_on_is_the_last_reopening_from_zero():
    """Review follow-up: closed lot parts that bridge the gap move the date back; a sell-out then a
    later re-buy does not."""
    import datetime as dt
    from types import SimpleNamespace as NS

    from finanse.modules.investments.domain import opened_on

    def holding(*dates):
        return NS(instrument_id="1", lots=tuple(NS(open_date=d) for d in dates))

    def closed(opened, closed_on, instrument_id="1"):
        return NS(instrument_id=instrument_id, open_date=opened, close_date=closed_on)

    jan, feb5, feb10, feb15 = (
        dt.date(2026, 1, 7),
        dt.date(2026, 2, 5),
        dt.date(2026, 2, 10),
        dt.date(2026, 2, 15),
    )
    assert opened_on([holding(feb5)]) == feb5
    assert opened_on([holding(feb5)], [closed(jan, feb10)]) == jan  # partial FIFO sell
    assert opened_on([holding(feb15)], [closed(jan, feb10)]) == feb15  # sold out, bought again
    assert opened_on([holding(feb15)], [closed(jan, feb15)]) == jan  # same-day: continuous
    assert opened_on([holding(feb5)], [closed(jan, feb10, "2")]) == feb5  # another instrument
    chain = [closed(jan, dt.date(2026, 1, 20)), closed(dt.date(2026, 1, 15), feb10)]
    assert opened_on([holding(feb5)], chain) == jan  # bridged twice
    assert opened_on([]) is None


def test_a_watched_instrument_gets_plan_vs_thesis_only():
    """P2: the checks run for watched instruments too; ``plan_no_exit`` never fires without a
    position (no gain, no exit to plan), ``plan_vs_thesis`` does."""
    for health in ("fulfilled", "current"):
        out = check_no_exit(facts(held=False, health=health, unrealized=None))
        assert isinstance(out, NotFired)
    vs = check_vs_thesis(facts(held=False, plan="buy_asap", health="invalidated", unrealized=None))
    assert isinstance(vs, Fired) and vs.candidate.severity is SignalSeverity.ACTION
    assert vs.candidate.payload["unrealized"] is None
    assert isinstance(check_vs_thesis(facts(held=False, plan="hold", health="weakened")), NotFired)
