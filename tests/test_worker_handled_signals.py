"""The worker never notifies a signal the owner already handled (F5 R5): acknowledged, decided after
the notification entry was written, or resolved by delivery time are closed out; a snoozed signal's
entry waits until the snooze ends. Shared fakes come from test_worker_runner."""

from __future__ import annotations

import dataclasses
import datetime as dt

import pytest
from test_worker_runner import (
    AS_OF,
    MONDAY,
    RecordingNotifier,
    add_signals,
    investor,  # noqa: F401 - pytest fixture
    jobs,
    log_rows,
    make_profile,
    sources,
    work,
)

from finanse.core.db import get_session
from finanse.core.models import Profile
from finanse.core.worker import investments as inv
from finanse.core.worker import notifications, runner
from finanse.modules.investments.models import InvDecision, InvNotification, InvSignal
from finanse.modules.investments.service import daily
from finanse.modules.investments.store import journal


@pytest.fixture
def home(db_engine):
    pid, _slug = make_profile("Dom")
    return pid


def _deliver(pid: int, fake, now: dt.datetime = MONDAY):
    with get_session() as s:
        profile = s.get(Profile, pid)
    return notifications.deliver_pending(profile, fake, now=now, session_factory=get_session)


def _status(signal_id: int) -> str:
    with get_session() as s:
        return s.get(InvSignal, signal_id).status


def test_a_signal_decided_in_the_app_is_not_notified(investor):  # noqa: F811
    """The review's scenario: in-app daily check -> decision "sold" -> the next worker run."""
    pid, _slug = investor
    daily.run_daily_check("api", as_of=AS_OF, sources=sources())
    (entry,) = log_rows(pid)
    assert entry.sent_at is None
    with get_session() as s:
        row = journal.signal(s, pid, entry.signal_id)
        journal.record_decision(s, pid, action="sold", signal_row=row, reason="sprzedane")
    fake = RecordingNotifier()
    report = work(fake)
    assert fake.sent == []
    assert [r.channel for r in log_rows(pid)] == ["skipped:acknowledged"]
    assert jobs(report, runner.NOTIFICATIONS)[0].stats["skipped"] == 1


def test_handled_signals_are_closed_out_at_delivery(home):
    active, decided = add_signals(home, 2)
    add_signals(home, 1, status="acknowledged")
    add_signals(home, 1, status="resolved")
    with get_session() as s:  # a decision after the entry, signal still active
        s.add(InvDecision(profile_id=home, signal_id=decided, action="held", reason="widzę"))
    fake = RecordingNotifier()
    result = _deliver(home, fake)
    assert [n.message for n in fake.sent] == ["Synthetic signal 0"]
    assert result.stats() == {"delivered": 1, "summarized": 0, "skipped": 3, "failed": 0}
    channels = [r.channel for r in log_rows(home)]
    assert channels == ["fake", "skipped:decided", "skipped:acknowledged", "skipped:closed"]
    assert _status(active) == _status(decided) == "active"


def test_an_older_decision_does_not_hide_a_new_entry(home):
    """An escalation writes a new entry after the owner's earlier decision: it is notified."""
    (sid,) = add_signals(home, 1, log=False)
    with get_session() as s:
        s.add(
            InvDecision(
                profile_id=home,
                signal_id=sid,
                action="held",
                created_at=dt.datetime(2026, 1, 1, tzinfo=dt.UTC),
            )
        )
    with get_session() as s:
        s.add(InvNotification(profile_id=home, signal_id=sid, severity="action"))
    fake = RecordingNotifier()
    _deliver(home, fake)
    assert [n.message for n in fake.sent] == ["Synthetic signal 0"]


def test_a_snoozed_signal_waits_until_the_snooze_ends(home, monkeypatch):
    (sid,) = add_signals(home, 1)
    until = MONDAY.astimezone(dt.UTC) + dt.timedelta(days=3)
    real_pending = inv.pending

    def pending(session, profile_id):  # inv_signals.snoozed_until comes with AL's R7
        return [
            dataclasses.replace(p, snoozed_until=until) for p in real_pending(session, profile_id)
        ]

    monkeypatch.setattr(inv, "pending", pending)
    fake = RecordingNotifier()
    assert _deliver(home, fake).stats()["skipped"] == 0
    assert fake.sent == [] and log_rows(home)[0].sent_at is None  # still pending
    _deliver(home, fake, now=MONDAY + dt.timedelta(days=4))
    assert [n.message for n in fake.sent] == ["Synthetic signal 0"]
    assert _status(sid) == "active"


def test_a_snoozed_status_waits_too(home):
    add_signals(home, 1, status="snoozed")
    fake = RecordingNotifier()
    _deliver(home, fake)
    assert fake.sent == [] and log_rows(home)[0].sent_at is None


def test_pending_reads_the_snooze_column_when_it_exists(home):
    (sid,) = add_signals(home, 1)
    if not hasattr(InvSignal, "snoozed_until"):
        pytest.skip("inv_signals.snoozed_until not added yet (AL, F5 R7)")
    with get_session() as s:
        row = s.get(InvSignal, sid)
        row.snoozed_until = dt.datetime(2026, 3, 5, 8, 0, tzinfo=dt.UTC)
        s.add(row)
    with get_session() as s:
        (item,) = inv.pending(s, home)
    assert item.snoozed(MONDAY) and not item.snoozed(MONDAY + dt.timedelta(days=4))
