"""F8 (home v3 section 8): an open signal no run confirmed for longer than ``max_unverified_days``
closes as expired with the reason ``unverified``; a confirmed, resolved or fresh-enough signal does
not; None never expires. Pure: no database."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from finanse.modules.investments.domain import SignalSeverity
from finanse.modules.investments.rules import (
    UNVERIFIED,
    ExpireSignal,
    Fired,
    OpenSignal,
    ResolveSignal,
    RuleSpec,
    SignalCandidate,
    Skipped,
    reconcile_signals,
    signal_dedup_key,
)

NOW = datetime(2026, 10, 6, 6, 0, tzinfo=UTC)
CONC = RuleSpec("conc", "position_concentration", None)
KEY = signal_dedup_key("conc", instrument_id="i-PKN")


def open_signal(days_ago: float | None) -> OpenSignal:
    return OpenSignal(
        signal_id="s1",
        rule_id="conc",
        dedup_key=KEY,
        severity=SignalSeverity.INFO,
        last_seen_at=None if days_ago is None else NOW - timedelta(days=days_ago),
    )


def reconcile(outcomes, signal: OpenSignal, max_days: int | None = 14):
    return reconcile_signals(
        open_signals=[signal],
        outcomes=outcomes,
        rules=[CONC],
        clock=lambda: NOW,
        max_unverified_days=max_days,
    )


def test_a_skipped_signal_older_than_the_limit_expires_as_unverified():
    result = reconcile([Skipped("conc", "stale price", KEY)], open_signal(15))
    assert result.actions == (ExpireSignal("s1", "conc", KEY, NOW, UNVERIFIED),)
    assert result.untouched == ()
    assert result.stats["signals_expired"] == 1


def test_whole_rule_skip_and_an_absent_rule_count_too():
    assert reconcile([Skipped("conc", "invalid")], open_signal(20)).expired[0].reason == UNVERIFIED
    assert reconcile([], open_signal(20)).expired[0].reason == UNVERIFIED


def test_within_the_limit_or_without_a_limit_it_stays_untouched():
    for days, limit in ((14, 14), (13.9, 14), (100, None)):
        result = reconcile([Skipped("conc", "stale", KEY)], open_signal(days), limit)
        assert result.actions == () and len(result.untouched) == 1, (days, limit)
    no_seen = reconcile([Skipped("conc", "stale", KEY)], open_signal(None))
    assert no_seen.actions == ()


def test_a_confirmed_or_resolved_signal_never_expires_by_age():
    candidate = SignalCandidate("conc", "position_concentration", KEY, SignalSeverity.INFO, "x")
    fired = reconcile([Fired(candidate)], open_signal(40))
    assert [type(a).__name__ for a in fired.actions] == ["RefreshSignal"]
    resolved = reconcile([Skipped("conc", "other", "conc|i:other")], open_signal(40))
    assert isinstance(resolved.actions[0], ResolveSignal)


def test_a_removed_rule_keeps_the_plain_expiry():
    result = reconcile_signals(
        open_signals=[open_signal(40)], outcomes=[], rules=[], clock=lambda: NOW,
        max_unverified_days=14,
    )  # fmt: skip
    assert result.actions == (ExpireSignal("s1", "conc", KEY, NOW),)
    assert result.actions[0].reason is None
