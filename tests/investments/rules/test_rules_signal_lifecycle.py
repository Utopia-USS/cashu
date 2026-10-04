"""Signal lifecycle as a pure function: new, refresh, escalate, resolve, untouched on skip, cooldown, expire.
Port of the Kompas signal_service tests without a database."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from finanse.modules.investments.domain import SignalSeverity, SignalStatus
from finanse.modules.investments.rules import (
    ClosedSignal,
    CreateSignal,
    EscalateSignal,
    ExpireSignal,
    Fired,
    NotFired,
    OpenSignal,
    RefreshSignal,
    ResolveSignal,
    RuleSpec,
    SignalCandidate,
    Skipped,
    SuppressCandidate,
    reconcile_signals,
    signal_dedup_key,
)

NOW = datetime(2026, 10, 2, 6, 0, tzinfo=UTC)
CONC = RuleSpec("conc", "position_concentration", None)
CASH = RuleSpec("cash", "cash_level", None, cooldown_days=7)
RULES = [CONC, CASH]
PKN_KEY = signal_dedup_key("conc", instrument_id="i-PKN")
CDR_KEY = signal_dedup_key("conc", instrument_id="i-CDR")
CASH_KEY = signal_dedup_key("cash")


def fired(rule_id: str, key: str, severity: SignalSeverity = SignalSeverity.INFO) -> Fired:
    return Fired(
        SignalCandidate(
            rule_id=rule_id,
            kind="cash_level" if rule_id == "cash" else "position_concentration",
            dedup_key=key,
            severity=severity,
            message=f"{key} fired ({severity})",
        )
    )


def open_signal(
    key: str, rule_id: str = "conc", severity=SignalSeverity.INFO, status=SignalStatus.ACTIVE
):
    return OpenSignal(
        signal_id=f"s-{key}", rule_id=rule_id, dedup_key=key, severity=severity, status=status
    )


def reconcile(outcomes, open_signals=(), rules=RULES, now=NOW, closed=()):
    return reconcile_signals(
        open_signals=open_signals,
        outcomes=outcomes,
        rules=rules,
        clock=lambda: now,
        closed_signals=closed,
    )


def test_a_new_dedup_key_creates_a_signal():
    result = reconcile([fired("conc", PKN_KEY), NotFired("conc", CDR_KEY)])
    assert result.actions == (CreateSignal(fired("conc", PKN_KEY).candidate, NOW),)
    assert result.stats == {
        "signals_new": 1,
        "signals_escalated": 0,
        "signals_refreshed": 0,
        "signals_resolved": 0,
        "signals_expired": 0,
        "signals_suppressed": 0,
    }


def test_the_same_key_firing_again_refreshes():
    result = reconcile([fired("conc", PKN_KEY)], [open_signal(PKN_KEY)])
    assert result.created == []
    assert result.refreshed == [
        RefreshSignal(f"s-{PKN_KEY}", fired("conc", PKN_KEY).candidate, NOW)
    ]


def test_a_lower_severity_is_a_plain_refresh():
    result = reconcile(
        [fired("conc", PKN_KEY)], [open_signal(PKN_KEY, severity=SignalSeverity.ACTION)]
    )
    assert len(result.refreshed) == 1 and result.escalated == []


def test_a_higher_severity_escalates_and_reactivates_an_acknowledged_signal():
    acknowledged = open_signal(PKN_KEY, status=SignalStatus.ACKNOWLEDGED)
    result = reconcile(
        [fired("conc", PKN_KEY), fired("conc", PKN_KEY, SignalSeverity.ACTION)], [acknowledged]
    )
    assert result.escalated == [
        EscalateSignal(
            f"s-{PKN_KEY}",
            fired("conc", PKN_KEY, SignalSeverity.ACTION).candidate,
            SignalSeverity.INFO,
            True,
            NOW,
        )
    ]
    assert result.refreshed == []
    active = reconcile([fired("conc", PKN_KEY, SignalSeverity.ACTION)], [open_signal(PKN_KEY)])
    assert active.escalated[0].reactivate is False


def test_not_fired_resolves_its_scope_the_whole_rule_and_vanished_scopes():
    opened = [open_signal(PKN_KEY), open_signal(CDR_KEY), open_signal(CASH_KEY, "cash")]
    scoped = reconcile(
        [fired("conc", PKN_KEY), NotFired("conc", CDR_KEY), NotFired("cash")], opened
    )
    assert [(a.dedup_key, a.resolved_at) for a in scoped.resolved] == [
        (CDR_KEY, NOW),
        (CASH_KEY, NOW),
    ]
    # PKN was sold: the rule ran (another outcome exists) but says nothing about PKN.
    gone = reconcile([NotFired("conc", CDR_KEY)], [open_signal(PKN_KEY)])
    assert gone.resolved == [ResolveSignal(f"s-{PKN_KEY}", "conc", PKN_KEY, NOW)]


def test_skipped_leaves_open_signals_untouched_and_absent_rules_too():
    opened = [open_signal(PKN_KEY), open_signal(CDR_KEY), open_signal(CASH_KEY, "cash")]
    result = reconcile([Skipped("conc", "stale", PKN_KEY), NotFired("conc", CDR_KEY)], opened)
    assert [a.dedup_key for a in result.resolved] == [CDR_KEY]
    assert [s.dedup_key for s in result.untouched] == [PKN_KEY, CASH_KEY]

    whole_rule = reconcile(
        [Skipped("conc", "stale portfolio"), Skipped("cash", "stale portfolio")], opened
    )
    assert whole_rule.actions == ()
    assert len(whole_rule.untouched) == 3


def test_a_skipped_scope_never_resolves_even_with_other_outcomes_of_the_rule():
    result = reconcile(
        [Skipped("conc", "stale", PKN_KEY), fired("conc", CDR_KEY)], [open_signal(PKN_KEY)]
    )
    assert result.resolved == []
    assert [type(a) for a in result.actions] == [CreateSignal]


def test_cooldown_suppresses_a_key_resolved_recently():
    resolved_at = NOW - timedelta(days=6, hours=23)
    closed = [ClosedSignal(CASH_KEY, resolved_at), ClosedSignal(CASH_KEY, NOW - timedelta(days=30))]
    in_cooldown = reconcile([fired("cash", CASH_KEY)], closed=closed)
    assert in_cooldown.created == []
    assert in_cooldown.suppressed == [
        SuppressCandidate(fired("cash", CASH_KEY).candidate, resolved_at + timedelta(days=7))
    ]
    after = reconcile([fired("cash", CASH_KEY)], closed=closed, now=NOW + timedelta(hours=1))
    assert [type(a) for a in after.actions] == [CreateSignal]


def test_rules_without_cooldown_reopen_immediately():
    closed = [ClosedSignal(PKN_KEY, NOW - timedelta(minutes=1))]
    assert [type(a) for a in reconcile([fired("conc", PKN_KEY)], closed=closed).actions] == [
        CreateSignal
    ]


def test_open_signals_of_removed_rules_expire():
    opened = [open_signal(PKN_KEY), open_signal(CASH_KEY, "cash")]
    result = reconcile([fired("conc", PKN_KEY)], opened, rules=[CONC])
    assert result.expired == [ExpireSignal(f"s-{CASH_KEY}", "cash", CASH_KEY, NOW)]
    assert len(result.refreshed) == 1


def test_actions_are_ordered_fired_first_then_closures():
    opened = [open_signal(CDR_KEY), open_signal(CASH_KEY, "cash")]
    result = reconcile([NotFired("conc", CDR_KEY), fired("conc", PKN_KEY)], opened, rules=[CONC])
    assert [type(a) for a in result.actions] == [CreateSignal, ResolveSignal, ExpireSignal]


def test_the_clock_is_called_once_and_duplicate_open_keys_are_rejected():
    calls = []

    def clock():
        calls.append(1)
        return NOW

    reconcile_signals(open_signals=[], outcomes=[fired("conc", PKN_KEY)], rules=RULES, clock=clock)
    assert calls == [1]
    with pytest.raises(ValueError, match="share the dedup key"):
        reconcile([], [open_signal(PKN_KEY), open_signal(PKN_KEY)])
