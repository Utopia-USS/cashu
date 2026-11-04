"""Pure recommendation freshness (P3): every reason alone, precedence outdated > maybe outdated, the
reason order, dismissed / expired / candidate / community notes, no plan, the plan_at boundary,
held-only plans and the dict shape. Synthetic facts only."""

from __future__ import annotations

import datetime as dt

import pytest

from cashu.modules.investments.plan import (
    PLAN_MAX_AGE_DAYS,
    FreshnessFacts,
    FreshnessState,
    PlanAlert,
    PlanSignal,
    plan_freshness,
)
from cashu.modules.investments.plan.freshness import (
    MAYBE_CODES,
    OUTDATED_CODES,
    REASON_ORDER,
    STRATEGY_RULE_KINDS,
)
from cashu.modules.investments.plan.hints import RULE_KIND_HINTS
from cashu.modules.investments.research.scoring import ScoredNote

NOW = dt.datetime(2026, 10, 6, 12, tzinfo=dt.UTC)
PLAN_AT = NOW - dt.timedelta(days=5)
AFTER = PLAN_AT + dt.timedelta(days=1)
BEFORE = PLAN_AT - dt.timedelta(days=1)


def note(
    note_id: int,
    relation: str,
    *,
    stored: dt.datetime = AFTER,
    strength: int = 1,
    kind: str = "news",
    dismissed: dt.datetime | None = None,
    expires: dt.datetime | None = None,
) -> ScoredNote:
    return ScoredNote(
        id=note_id,
        kind=kind,
        polarity="neutral",
        strength=strength,
        thesis_relation=relation,
        observed_at=stored - dt.timedelta(hours=1),
        created_at=stored,
        expires_at=expires or NOW + dt.timedelta(days=20),
        dismissed_at=dismissed,
    )


def facts(**kw) -> FreshnessFacts:
    base = {"plan": "hold", "plan_at": PLAN_AT, "health": "current"}
    return FreshnessFacts(**(base | kw))


def fresh(**kw):
    return plan_freshness(facts(**kw), NOW)


def state_codes(**kw) -> tuple[str, list[str]]:
    found = fresh(**kw)
    return found.state.value, found.codes


# --------------------------------------------------------------------------- #
# Each reason alone
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize(
    ("kw", "state", "reason"),
    [
        (
            {"notes": (note(1, "invalidates"),)},
            "outdated",
            {"code": "note_invalidates", "note_id": 1, "relation": "invalidates", "count": 1},
        ),
        (
            {"health": "invalidated", "notes": (note(2, "invalidates", stored=BEFORE),)},
            "outdated",
            {"code": "thesis_invalidated", "note_id": 2},
        ),
        (
            {"plan": "buy", "notes": (note(3, "fulfills"),)},
            "outdated",
            {"code": "fulfilled_buy", "note_id": 3, "relation": "fulfills", "count": 1},
        ),
        (
            {"notes": (note(4, "weakens"),)},
            "maybe_outdated",
            {"code": "note_after", "note_id": 4, "relation": "weakens", "count": 1},
        ),
        (
            {"core_changed_at": AFTER},
            "maybe_outdated",
            {"code": "thesis_changed"},
        ),
        (
            {"signals": (PlanSignal(7, "drawdown_from_high", AFTER),)},
            "maybe_outdated",
            {"code": "rule_fired", "signal_id": 7, "kind": "drawdown_from_high"},
        ),
        (
            {"alerts": (PlanAlert(8, "price_below", AFTER),)},
            "maybe_outdated",
            {"code": "alert_triggered", "alert_id": 8, "kind": "price_below"},
        ),
    ],
)
def test_each_reason_alone(kw, state, reason):
    found = fresh(**kw)
    assert found.state.value == state
    assert len(found.reasons) == 1
    d = found.to_dict()["reasons"][0]
    at = d.pop("at")
    assert d == reason
    assert at == AFTER.isoformat() or reason["code"] == "thesis_invalidated"


def test_fresh_without_anything_after_the_plan():
    found = fresh(
        notes=(note(1, "weakens", stored=BEFORE), note(2, "neutral")),
        core_changed_at=BEFORE,
        signals=(PlanSignal(1, "gain_from_cost", BEFORE),),
        alerts=(PlanAlert(1, "price_below", BEFORE),),
    )
    assert found.state == FreshnessState.FRESH and found.reasons == ()
    assert found.to_dict() == {"state": "fresh", "reasons": []}


def test_age():
    old = NOW - dt.timedelta(days=PLAN_MAX_AGE_DAYS, seconds=1)
    found = plan_freshness(facts(plan_at=old), NOW)
    assert found.state == FreshnessState.MAYBE_OUTDATED and found.codes == ["age"]
    assert found.reasons[0].at == old + dt.timedelta(days=PLAN_MAX_AGE_DAYS)
    exactly = NOW - dt.timedelta(days=PLAN_MAX_AGE_DAYS)
    assert plan_freshness(facts(plan_at=exactly), NOW).state == FreshnessState.FRESH


def test_no_plan_no_freshness():
    assert fresh(plan=None) is None
    assert fresh(plan_at=None) is None


# --------------------------------------------------------------------------- #
# Notes
# --------------------------------------------------------------------------- #


def test_note_after_relations_and_strengths():
    assert state_codes(notes=(note(1, "fulfills"),)) == ("maybe_outdated", ["note_after"])
    assert state_codes(notes=(note(1, "supports", strength=2),)) == (
        "maybe_outdated",
        ["note_after"],
    )
    assert state_codes(notes=(note(1, "neutral", strength=3),)) == (
        "maybe_outdated",
        ["note_after"],
    )
    for quiet in (note(1, "supports"), note(1, "neutral", strength=2), note(1, "none")):
        assert state_codes(notes=(quiet,)) == ("fresh", [])
    # community notes count with strength 1 (noise), candidate notes never
    assert state_codes(notes=(note(1, "neutral", strength=3, kind="community"),)) == ("fresh", [])
    assert state_codes(notes=(note(1, "invalidates", kind="candidate"),)) == ("fresh", [])


def test_dismissed_notes_never_count_and_expired_only_for_outdated():
    gone = NOW - dt.timedelta(hours=1)
    assert state_codes(notes=(note(1, "invalidates", dismissed=gone),)) == ("fresh", [])
    assert state_codes(notes=(note(1, "weakens", dismissed=gone),)) == ("fresh", [])
    # an expired invalidating / fulfilling note still makes it outdated, an expired weakening one
    # no longer makes it maybe outdated
    assert state_codes(notes=(note(1, "invalidates", expires=gone),)) == (
        "outdated",
        ["note_invalidates"],
    )
    assert state_codes(plan="buy_asap", notes=(note(1, "fulfills", expires=gone),)) == (
        "outdated",
        ["fulfilled_buy"],
    )
    assert state_codes(notes=(note(1, "weakens", expires=gone),)) == ("fresh", [])


def test_the_plan_at_boundary_is_not_after():
    assert state_codes(
        notes=(note(1, "invalidates", stored=PLAN_AT),),
        core_changed_at=PLAN_AT,
        signals=(PlanSignal(1, "gain_from_cost", PLAN_AT),),
        alerts=(PlanAlert(1, "new_high", PLAN_AT),),
    ) == ("fresh", [])
    just = PLAN_AT + dt.timedelta(microseconds=1)
    assert state_codes(notes=(note(1, "invalidates", stored=just),)) == (
        "outdated",
        ["note_invalidates"],
    )


def test_newest_note_and_count_per_code():
    found = fresh(notes=(note(1, "weakens"), note(2, "weakens", stored=AFTER + dt.timedelta(1))))
    reason = found.to_dict()["reasons"][0]
    assert (reason["note_id"], reason["count"]) == (2, 2)


def test_fulfills_on_a_buy_plan_is_outdated_otherwise_maybe():
    for plan in ("buy", "buy_asap"):
        assert state_codes(plan=plan, notes=(note(1, "fulfills"),)) == (
            "outdated",
            ["fulfilled_buy"],
        )
    for plan in ("hold", "reduce", "exit_asap"):
        assert state_codes(plan=plan, notes=(note(1, "fulfills"),)) == (
            "maybe_outdated",
            ["note_after"],
        )


# --------------------------------------------------------------------------- #
# Thesis
# --------------------------------------------------------------------------- #


def test_thesis_invalidated_unless_the_plan_already_reduces_or_exits():
    for plan in ("buy_asap", "buy", "hold"):
        assert state_codes(plan=plan, health="invalidated") == ("outdated", ["thesis_invalidated"])
    for plan in ("reduce", "exit_asap"):
        assert state_codes(plan=plan, health="invalidated") == ("fresh", [])
    # no invalidating note in the window: the reason without a date
    assert fresh(health="invalidated").to_dict()["reasons"] == [
        {"code": "thesis_invalidated", "at": None}
    ]


def test_an_invalidating_note_after_the_plan_is_not_repeated_as_thesis_invalidated():
    found = fresh(health="invalidated", notes=(note(1, "invalidates", strength=3),))
    assert found.codes == ["note_invalidates"]  # nor as note_after (strength 3)


def test_thesis_changed_and_no_thesis():
    assert state_codes(core_changed_at=None) == ("fresh", [])
    assert state_codes(core_changed_at=AFTER) == ("maybe_outdated", ["thesis_changed"])


# --------------------------------------------------------------------------- #
# Signals and alerts
# --------------------------------------------------------------------------- #


def test_rule_kinds_not_ids_and_one_reason_per_kind():
    signals = (
        PlanSignal(1, "gain_from_cost", AFTER),
        PlanSignal(2, "gain_from_cost", AFTER + dt.timedelta(hours=2)),
        PlanSignal(3, "plan:plan_vs_thesis", AFTER),
        PlanSignal(4, "alert:price_below", AFTER),
        PlanSignal(5, "my_rule_id", AFTER),
        PlanSignal(6, "research_digest", AFTER),
    )
    found = fresh(signals=signals)
    assert [(r.code, r.signal_id, r.kind) for r in found.reasons] == [
        ("rule_fired", 2, "gain_from_cost")
    ]
    assert set(STRATEGY_RULE_KINDS) == set(RULE_KIND_HINTS)


def test_one_reason_per_alert_newest_first():
    alerts = (
        PlanAlert(1, "price_below", AFTER),
        PlanAlert(2, "new_high", AFTER + dt.timedelta(hours=1)),
        PlanAlert(3, "price_above", BEFORE),
    )
    assert [r.alert_id for r in fresh(alerts=alerts).reasons] == [2, 1]


# --------------------------------------------------------------------------- #
# Precedence and order
# --------------------------------------------------------------------------- #


def test_outdated_wins_and_every_reason_is_listed_in_order():
    found = plan_freshness(
        facts(
            plan="buy",
            plan_at=NOW - dt.timedelta(days=40),
            health="invalidated",
            notes=(
                note(1, "weakens", stored=NOW - dt.timedelta(days=2)),
                note(2, "fulfills", stored=NOW - dt.timedelta(days=3)),
                note(3, "invalidates", stored=NOW - dt.timedelta(days=60)),
            ),
            core_changed_at=NOW - dt.timedelta(days=1),
            signals=(PlanSignal(1, "loss_from_cost", NOW - dt.timedelta(days=1)),),
            alerts=(PlanAlert(1, "price_below", NOW - dt.timedelta(days=1)),),
        ),
        NOW,
    )
    assert found.state == FreshnessState.OUTDATED
    assert found.codes == [
        "thesis_invalidated",
        "fulfilled_buy",
        "note_after",
        "thesis_changed",
        "rule_fired",
        "alert_triggered",
        "age",
    ]
    # the fulfilling note behind fulfilled_buy is not repeated as note_after
    assert found.reasons[2].note_id == 1 and found.reasons[2].count == 1


def test_code_tables():
    assert REASON_ORDER == OUTDATED_CODES + MAYBE_CODES
    assert len(set(REASON_ORDER)) == len(REASON_ORDER)
