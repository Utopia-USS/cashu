"""Pure strategy hints (P2, P3 freshness hints first): every code of the held and watched tables, their order (main first),
params as fractions, the strongest signal per rule kind, alert and plan signals never matched as
rule kinds, missing data and instruments research never covers. Synthetic facts only."""

from __future__ import annotations

import pytest

from finanse.modules.investments.plan import (
    Freshness,
    FreshnessState,
    HintFacts,
    OpenSignal,
    TriggeredAlert,
    instrument_hints,
)
from finanse.modules.investments.plan.freshness import Reason
from finanse.modules.investments.plan.hints import CODES, HELD_ORDER, WATCHED_ORDER

GAIN = OpenSignal("gain_from_cost", {"unrealized_pct": 4.5512, "threshold": 1.0})
LOSS = OpenSignal("loss_from_cost", {"unrealized_pct": -0.27, "threshold": 0.25})
DRAWDOWN = OpenSignal("drawdown_from_high", {"drawdown": 0.31, "threshold": 0.3})
CONCENTRATION = OpenSignal("position_concentration", {"weight": 0.22, "max_weight": 0.2})
PLAN_VS = OpenSignal("plan:plan_vs_thesis", {"plan": "buy", "health": "invalidated"})


def held(**kw) -> HintFacts:
    base = {"held": True, "health": "current", "has_thesis": True, "has_exit_plan": True}
    return HintFacts(**(base | kw))


def watched(**kw) -> HintFacts:
    base = {"held": False, "health": "current", "has_thesis": True, "has_exit_plan": True}
    return HintFacts(**(base | kw))


def codes(facts: HintFacts) -> list[str]:
    return [h.code for h in instrument_hints(facts)]


def dicts(facts: HintFacts) -> list[dict]:
    return [h.to_dict() for h in instrument_hints(facts)]


# --------------------------------------------------------------------------- #
# Held
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize(
    ("facts", "expected"),
    [
        (
            held(health="invalidated"),
            {
                "code": "thesis_invalidated",
                "severity": "rule",
                "params": {"predates_thesis": False},
            },
        ),
        (
            held(health="fulfilled", has_exit_plan=False),
            {
                "code": "thesis_fulfilled",
                "severity": "review",
                "params": {"has_exit_plan": False, "predates_thesis": False},
            },
        ),
        (
            held(signals=(GAIN,)),
            {
                "code": "gain_review",
                "severity": "review",
                "params": {"gain": 4.5512, "threshold": 1.0, "has_exit_plan": True},
            },
        ),
        (
            held(signals=(LOSS,)),
            {
                "code": "loss_review",
                "severity": "review",
                "params": {"loss": 0.27, "threshold": 0.25},
            },
        ),
        (
            held(signals=(DRAWDOWN,)),
            {
                "code": "drawdown_review",
                "severity": "review",
                "params": {"drawdown": 0.31, "threshold": 0.3},
            },
        ),
        (
            held(signals=(CONCENTRATION,)),
            {
                "code": "concentration",
                "severity": "review",
                "params": {"weight": 0.22, "max_weight": 0.2},
            },
        ),
        (
            held(health="weakened", predates_thesis=True),
            {"code": "thesis_weakened", "severity": "review", "params": {"predates_thesis": True}},
        ),
        (
            held(health="no_thesis", has_thesis=False, has_exit_plan=False),
            {"code": "no_thesis", "severity": "review", "params": {}},
        ),
        (
            held(has_exit_plan=False),
            {"code": "no_exit_plan", "severity": "info", "params": {}},
        ),
    ],
)
def test_every_held_code_alone(facts, expected):
    assert dicts(facts) == [expected]


def test_held_order_when_everything_applies():
    facts = held(
        plan="buy",
        health="invalidated",
        has_exit_plan=False,
        signals=(CONCENTRATION, DRAWDOWN, LOSS, GAIN),
    )
    # gain_review carries has_exit_plan: no separate no_exit_plan hint
    assert codes(facts) == [
        "thesis_invalidated",
        "plan_vs_thesis",
        "gain_review",
        "loss_review",
        "drawdown_review",
        "concentration",
    ]
    assert codes(held(health="fulfilled", has_exit_plan=False, signals=(GAIN,))) == [
        "thesis_fulfilled",
        "gain_review",
    ]
    assert codes(held(health="weakened", has_exit_plan=False, signals=(DRAWDOWN,))) == [
        "drawdown_review",
        "thesis_weakened",
        "no_exit_plan",
    ]
    assert codes(held(health="no_thesis", has_thesis=False, has_exit_plan=False)) == ["no_thesis"]


def test_held_without_anything_to_say():
    for health in ("current", "supported", "no_research"):
        assert codes(held(health=health)) == []


def test_the_strongest_signal_of_a_kind_wins_and_kinds_not_ids_match():
    lower = OpenSignal("gain_from_cost", {"unrealized_pct": 4.5, "threshold": 0.5})
    higher = OpenSignal("gain_from_cost", {"unrealized_pct": 4.5, "threshold": 2.0})
    found = dicts(held(signals=(lower, higher)))
    assert len(found) == 1 and found[0]["params"]["threshold"] == 2.0
    # an alert signal, a research signal, a P1 plan_no_exit signal and other rule kinds: no hint
    others = (
        OpenSignal("alert:drawdown_from_high", {"drawdown": 0.4}),
        OpenSignal("research:note", {}),
        OpenSignal("plan:plan_no_exit", {"trigger": "gain"}),
        OpenSignal("cash_level", {"weight": 0.3}),
        OpenSignal("allocation_drift", {}),
    )
    assert codes(held(signals=others)) == []


def test_missing_payload_values_are_none_and_concentration_falls_back_to_the_weight():
    bare = (
        OpenSignal("gain_from_cost", {}),
        OpenSignal("loss_from_cost", {"unrealized_pct": "x"}),
        OpenSignal("drawdown_from_high", {"drawdown": None}),
        OpenSignal("position_concentration", {"max_weight": 0.2}),
    )
    found = {h["code"]: h["params"] for h in dicts(held(signals=bare, weight=0.25))}
    assert found == {
        "gain_review": {"gain": None, "threshold": None, "has_exit_plan": True},
        "loss_review": {"loss": None, "threshold": None},
        "drawdown_review": {"drawdown": None, "threshold": None},
        "concentration": {"weight": 0.25, "max_weight": 0.2},
    }


def test_plan_vs_thesis_follows_the_live_facts_not_the_signal():
    for facts in (held, watched):
        for plan in ("buy", "buy_asap"):
            for health in ("weakened", "invalidated"):
                found = dicts(facts(plan=plan, health=health))
                vs = [h for h in found if h["code"] == "plan_vs_thesis"]
                assert vs == [
                    {
                        "code": "plan_vs_thesis",
                        "severity": "rule",
                        "params": {"plan": plan, "health": health},
                    }
                ]
        # a still open signal (the note behind it was dismissed): no hint
        assert codes(facts(plan="buy", health="supported", signals=(PLAN_VS,))) == []
        for plan in ("hold", None):
            assert "plan_vs_thesis" not in codes(facts(plan=plan, health="invalidated"))
    assert "plan_vs_thesis" not in codes(held(plan="reduce", health="invalidated"))


def test_the_highest_crossed_concentration_limit_wins_in_any_order():
    low = OpenSignal("position_concentration", {"weight": 0.25, "max_weight": 0.1})
    high = OpenSignal("position_concentration", {"weight": 0.25, "max_weight": 0.2})
    for signals in ((low, high), (high, low)):
        found = dicts(held(signals=signals))
        assert found == [
            {
                "code": "concentration",
                "severity": "review",
                "params": {"weight": 0.25, "max_weight": 0.2},
            }
        ]


# --------------------------------------------------------------------------- #
# Watched
# --------------------------------------------------------------------------- #


ALERT = TriggeredAlert(alert_id=7, kind="drawdown_from_high", title="-30 % od szczytu")


@pytest.mark.parametrize(
    ("facts", "expected"),
    [
        (
            watched(alerts=(ALERT,)),
            [
                {
                    "code": "alert_triggered",
                    "severity": "review",
                    "params": {
                        "alert_id": 7,
                        "kind": "drawdown_from_high",
                        "title": "-30 % od szczytu",
                    },
                }
            ],
        ),
        (
            watched(plan="buy", health="weakened"),
            [
                {
                    "code": "plan_vs_thesis",
                    "severity": "rule",
                    "params": {"plan": "buy", "health": "weakened"},
                },
                {
                    "code": "thesis_weakened",
                    "severity": "review",
                    "params": {"predates_thesis": False},
                },
            ],
        ),
        (
            watched(health="invalidated", predates_thesis=True),
            [
                {
                    "code": "thesis_invalidated",
                    "severity": "rule",
                    "params": {"predates_thesis": True},
                }
            ],
        ),
        (
            watched(health="fulfilled", has_exit_plan=False),
            [
                {
                    "code": "thesis_fulfilled",
                    "severity": "review",
                    "params": {"has_exit_plan": False, "predates_thesis": False},
                }
            ],
        ),
        (
            watched(plan="buy_asap", health="no_thesis", has_thesis=False, has_exit_plan=False),
            [
                {"code": "plan_without_thesis", "severity": "rule", "params": {"plan": "buy_asap"}},
                {"code": "no_thesis", "severity": "info", "params": {}},
            ],
        ),
        (
            watched(plan="hold", health="no_thesis", has_thesis=False, has_exit_plan=False),
            [{"code": "no_thesis", "severity": "info", "params": {}}],
        ),
    ],
)
def test_every_watched_code(facts, expected):
    assert dicts(facts) == expected


def test_watched_order_and_no_held_only_hints():
    alerts = (
        TriggeredAlert(alert_id=9, kind="price_below", title="b"),
        TriggeredAlert(alert_id=3, kind="new_high", title="a"),
    )
    facts = watched(
        plan="buy",
        health="no_thesis",
        has_thesis=False,
        has_exit_plan=False,
        alerts=alerts,
        signals=(GAIN, LOSS, DRAWDOWN, CONCENTRATION, OpenSignal("plan:plan_vs_thesis")),
    )
    # the open plan signal does not make a hint without a weakened / invalidated thesis
    assert codes(facts) == [
        "alert_triggered",
        "alert_triggered",
        "plan_without_thesis",
        "no_thesis",
    ]
    assert [h.params["alert_id"] for h in instrument_hints(facts)[:2]] == [3, 9]
    # a watched instrument with a thesis but no exit plan: nothing to say (exit plans are held-only)
    assert codes(watched(has_exit_plan=False)) == []


def test_instruments_research_never_covers_keep_only_rule_and_alert_hints():
    untracked = held(
        health="no_thesis",
        has_thesis=False,
        has_exit_plan=False,
        signals=(CONCENTRATION,),
        thesis_tracked=False,
    )
    assert codes(untracked) == ["concentration"]
    assert codes(
        watched(
            plan="buy",
            health="no_thesis",
            has_thesis=False,
            alerts=(ALERT,),
            thesis_tracked=False,
        )
    ) == ["alert_triggered"]
    # a thesis the owner wrote anyway is tracked
    assert codes(held(health="weakened", thesis_tracked=False)) == ["thesis_weakened"]


# --------------------------------------------------------------------------- #
# Recommendation freshness (P3): first in both tables
# --------------------------------------------------------------------------- #

OUTDATED = Freshness(
    FreshnessState.OUTDATED,
    (Reason("note_invalidates", None, note_id=1), Reason("age", None)),
)
MAYBE = Freshness(
    FreshnessState.MAYBE_OUTDATED,
    (Reason("alert_triggered", None, alert_id=1), Reason("alert_triggered", None, alert_id=2)),
)


def test_freshness_hints_lead_held_and_watched():
    found = dicts(held(health="invalidated", signals=(GAIN,), freshness=OUTDATED))
    assert found[0] == {
        "code": "recommendation_outdated",
        "severity": "rule",
        "params": {"reasons": ["note_invalidates", "age"]},
    }
    assert [h["code"] for h in found[1:]] == ["thesis_invalidated", "gain_review"]
    found = dicts(watched(alerts=(ALERT,), freshness=MAYBE))
    assert found[0] == {
        "code": "recommendation_maybe_outdated",
        "severity": "review",
        "params": {"reasons": ["alert_triggered"]},
    }
    assert found[1]["code"] == "alert_triggered"
    # fresh or no recommendation: no freshness hint; kept for instruments research never covers
    assert codes(held(freshness=Freshness(FreshnessState.FRESH))) == []
    assert codes(held(freshness=None)) == []
    untracked = watched(
        health="no_thesis", has_thesis=False, thesis_tracked=False, plan="buy", freshness=MAYBE
    )
    assert codes(untracked) == ["recommendation_maybe_outdated"]


def test_code_tables():
    assert set(CODES) == set(HELD_ORDER) | set(WATCHED_ORDER)
    assert (
        HELD_ORDER[:2]
        == WATCHED_ORDER[:2]
        == (
            "recommendation_outdated",
            "recommendation_maybe_outdated",
        )
    )
    assert HELD_ORDER[2] == "thesis_invalidated" and HELD_ORDER[-1] == "no_exit_plan"
    assert WATCHED_ORDER[2] == "alert_triggered" and WATCHED_ORDER[-1] == "no_thesis"
