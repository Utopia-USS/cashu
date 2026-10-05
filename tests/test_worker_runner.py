"""Worker runs end to end on synthetic data: the investments daily check (fake market sources),
immediate notifications from the notification log (policy, once per signal and severity, claims,
failures, the per-run cap), the weekly digest, the budget sync (configured / throttled / rate
limited) and job isolation. A recording notifier stands in for the OS; no network."""

from __future__ import annotations

import datetime as dt
import sys
from pathlib import Path

import pytest
from sqlmodel import select

sys.path.insert(0, str(Path(__file__).parent / "investments" / "persistence"))

from invp_support import (
    AS_OF,
    STRATEGY_YAML,
    add_account,
    canonical_csv,
    import_file,
    make_profile,
    sources,
)

from finanse.core import locks
from finanse.core.db import get_session
from finanse.core.models import Profile
from finanse.core.worker import budget as budget_glue
from finanse.core.worker import investments as inv
from finanse.core.worker import notifications, runner
from finanse.core.worker import state as worker_state
from finanse.core.worker.notifier import Delivery, Notification
from finanse.modules.investments.models import InvNotification, InvSignal
from finanse.modules.investments.service import daily, files

TZ = dt.timezone(dt.timedelta(hours=1))
MONDAY = dt.datetime(2026, 3, 2, 7, 30, tzinfo=TZ)  # AS_OF's day; the default digest is Sunday
SUNDAY = dt.datetime(2026, 3, 1, 7, 30, tzinfo=TZ)


class RecordingNotifier:
    name = "fake"

    def __init__(self, fail: bool = False) -> None:
        self.sent: list[Notification] = []
        self.fail = fail

    def send(self, notification: Notification) -> Delivery:
        if self.fail:
            return Delivery(False, self.name, "exit 1: no GUI session")
        self.sent.append(notification)
        return Delivery(True, self.name)


def work(notifier=None, **kwargs) -> runner.WorkerReport:
    kwargs.setdefault("now", MONDAY)
    kwargs.setdefault("as_of", AS_OF)
    kwargs.setdefault("investments_sources", sources)
    return runner.run_worker(notifier=notifier, **kwargs)


def jobs(report, job: str) -> list[runner.JobResult]:
    return [j for j in report.jobs if j.job == job]


def write_strategy(slug: str, text: str = STRATEGY_YAML) -> None:
    files.write_text_private(files.strategy_yaml_path(slug), text)


def with_notifications(text: str, immediate: str = "[action]", weekday: str = "sunday") -> str:
    return text + f"notifications:\n  immediate: {immediate}\n  digest_weekday: {weekday}\n"


def log_rows(profile_id: int) -> list[InvNotification]:
    with get_session() as s:
        return list(
            s.exec(
                select(InvNotification)
                .where(InvNotification.profile_id == profile_id)
                .order_by(InvNotification.id)
            ).all()
        )


def add_signals(profile_id: int, n: int, *, severity="action", status="active", log=True):
    """Signals (and pending notification-log entries) inserted directly."""
    with get_session() as s:
        ids = []
        for i in range(n):
            sig = InvSignal(
                profile_id=profile_id,
                rule_id=f"rule{i}",
                kind="position_concentration",
                dedup_key=f"rule{i}:{status}",
                severity=severity,
                status=status,
                message=f"Synthetic signal {i}",
            )
            s.add(sig)
            s.flush()
            ids.append(sig.id)
            if log:
                s.add(InvNotification(profile_id=profile_id, signal_id=sig.id, severity=severity))
        return ids


@pytest.fixture
def investor(db_engine):
    pid, slug = make_profile("Inwestor")
    aid = add_account(pid)
    import_file(pid, aid, canonical_csv())
    write_strategy(slug)
    return pid, slug


# --------------------------------------------------------------------------- #
# Investments daily check + immediate notifications
# --------------------------------------------------------------------------- #


def test_first_run_notifies_the_action_signal_once(investor):
    pid, _slug = investor
    fake = RecordingNotifier()
    first = work(fake)
    (check,) = jobs(first, runner.INVESTMENTS_DAILY)
    assert (check.status, check.profile) == ("ok", "inwestor")
    assert check.stats["new_signals"] == 1 and check.stats["notifications"] == 1
    (note,) = fake.sent
    assert note.title == "finanse: Inwestor" and note.subtitle == "Sygnał do działania"
    assert "XMPL" in note.message or "Example" in note.message
    (row,) = log_rows(pid)
    assert row.sent_at is not None and row.channel == "fake"
    (delivered,) = jobs(first, runner.NOTIFICATIONS)
    assert delivered.status == "ok" and delivered.stats["delivered"] == 1
    assert first.status == "ok"

    second = work(fake)
    assert len(fake.sent) == 1  # the open signal is refreshed, never notified again
    assert jobs(second, runner.NOTIFICATIONS)[0].stats["delivered"] == 0
    st = worker_state.load()
    assert st.last_run["status"] == "ok"
    assert {j["job"] for j in st.last_run["jobs"]} == {"investments.daily", "notifications"}


def test_only_the_profiles_immediate_severities_notify(investor):
    pid, slug = investor
    # the cash rule now fires an info signal; the default policy notifies action only
    write_strategy(slug, STRATEGY_YAML.replace("max_weight: 0.15", "max_weight: 0.05"))
    fake = RecordingNotifier()
    report = work(fake)
    assert jobs(report, runner.INVESTMENTS_DAILY)[0].stats["new_signals"] == 2
    assert [n.subtitle for n in fake.sent] == ["Sygnał do działania"]
    assert len(log_rows(pid)) == 1


def test_info_notifies_when_the_policy_says_so(investor):
    pid, slug = investor
    strategy = STRATEGY_YAML.replace("max_weight: 0.15", "max_weight: 0.05")
    write_strategy(slug, with_notifications(strategy, "[action, info]"))
    fake = RecordingNotifier()
    work(fake)
    assert sorted(n.subtitle for n in fake.sent) == ["Sygnał do działania", "Sygnał informacyjny"]
    assert all(r.sent_at is not None for r in log_rows(pid)) and len(log_rows(pid)) == 2


def test_policy_is_checked_again_at_delivery(investor):
    """Entries written by an in-app run under the old policy are not delivered once the policy
    no longer lists their severity."""
    pid, slug = investor
    daily.run_daily_check("api", as_of=AS_OF, sources=sources())
    (row,) = log_rows(pid)
    assert row.sent_at is None
    write_strategy(slug, with_notifications(STRATEGY_YAML, "[info]"))
    fake = RecordingNotifier()
    report = work(fake)
    assert fake.sent == []
    (row,) = log_rows(pid)
    assert row.sent_at is not None and row.channel == "skipped:policy"
    assert jobs(report, runner.NOTIFICATIONS)[0].stats["skipped"] == 1


def test_a_signal_closed_before_delivery_is_skipped(investor):
    pid, slug = investor
    daily.run_daily_check("api", as_of=AS_OF, sources=sources())
    # the worker's own check resolves it (higher limit) before the notifications step
    write_strategy(slug, STRATEGY_YAML.replace("max_weight: 0.30", "max_weight: 0.50"))
    fake = RecordingNotifier()
    work(fake)
    assert fake.sent == []
    assert [r.channel for r in log_rows(pid)] == ["skipped:closed"]


def test_a_failed_delivery_is_retried_on_the_next_run(investor):
    pid, _ = investor
    broken = RecordingNotifier(fail=True)
    report = work(broken)
    (job,) = jobs(report, runner.NOTIFICATIONS)
    assert job.status == "failed" and job.detail == "exit 1: no GUI session"
    assert report.status == "partial"
    (row,) = log_rows(pid)
    assert row.sent_at is None and row.channel is None  # the claim was released

    fixed = RecordingNotifier()
    work(fixed)
    work(fixed)
    assert len(fixed.sent) == 1 and log_rows(pid)[0].channel == "fake"


def test_a_claim_is_won_once(investor):
    pid, _ = investor
    daily.run_daily_check("api", as_of=AS_OF, sources=sources())
    (row,) = log_rows(pid)
    now = dt.datetime(2026, 3, 2, 8, 0, tzinfo=dt.UTC)
    assert inv.claim(get_session, row.id, "fake", now) is True
    assert inv.claim(get_session, row.id, "other", now) is False
    assert log_rows(pid)[0].channel == "fake"
    inv.release(get_session, row.id)
    assert log_rows(pid)[0].sent_at is None


def test_many_pending_entries_are_capped_with_one_summary(db_engine):
    pid, _ = make_profile("Dom")
    add_signals(pid, 5)
    add_signals(pid, 1, status="resolved")  # closed: skipped, never shown
    fake = RecordingNotifier()
    with get_session() as s:
        profile = s.get(Profile, pid)
    result = notifications.deliver_pending(profile, fake, now=MONDAY, session_factory=get_session)
    assert result.stats() == {"delivered": 3, "summarized": 2, "skipped": 1, "failed": 0}
    assert [n.message for n in fake.sent[:3]] == [f"Synthetic signal {i}" for i in range(3)]
    assert fake.sent[3].message == "I jeszcze 2 sygnały - szczegóły w aplikacji."
    channels = [r.channel for r in log_rows(pid)]
    assert channels == ["fake"] * 3 + ["fake:summary"] * 2 + ["skipped:closed"]


def test_two_profiles_are_notified_separately(db_engine):
    for name in ("Anna", "Bartek"):
        pid, slug = make_profile(name)
        import_file(pid, add_account(pid), canonical_csv())
        write_strategy(slug)
    fake = RecordingNotifier()
    report = work(fake)
    assert sorted(n.title for n in fake.sent) == ["finanse: Anna", "finanse: Bartek"]
    assert sorted(j.profile for j in jobs(report, runner.NOTIFICATIONS)) == ["anna", "bartek"]


def test_notifier_none_leaves_entries_pending(investor):
    pid, _ = investor
    report = work(None)
    assert jobs(report, runner.NOTIFICATIONS)[0].status == "skipped"
    assert log_rows(pid)[0].sent_at is None
    assert jobs(report, runner.DIGEST) == []


# --------------------------------------------------------------------------- #
# Weekly digest
# --------------------------------------------------------------------------- #


def test_signals_phrase():
    cases = {
        0: "0 sygnałów",
        1: "1 sygnał",
        2: "2 sygnały",
        4: "4 sygnały",
        5: "5 sygnałów",
        12: "12 sygnałów",
        14: "14 sygnałów",
        21: "21 sygnałów",
        22: "22 sygnały",
        25: "25 sygnałów",
        102: "102 sygnały",
        112: "112 sygnałów",
    }
    assert {n: notifications.signals_phrase(n) for n in cases} == cases
    assert notifications.digest_message(0) == "Brak sygnałów do przeglądu"
    assert notifications.digest_message(3) == "3 sygnały do przeglądu"


def test_digest_once_on_the_default_weekday(db_engine):
    pid, _ = make_profile("Dom")
    add_signals(pid, 2, log=False)
    add_signals(pid, 1, status="acknowledged", log=False)  # decided: not "to review"
    fake = RecordingNotifier()

    report = work(fake, now=SUNDAY, offline=True)
    (digest,) = jobs(report, runner.DIGEST)
    assert digest.status == "ok" and digest.stats == {"signals": 2}
    (note,) = fake.sent
    assert (note.title, note.subtitle, note.message) == (
        "finanse: Dom",
        "Przegląd tygodniowy",
        "2 sygnały do przeglądu",
    )
    assert worker_state.load().digests == {str(pid): "2026-03-01"}

    again = work(fake, now=SUNDAY + dt.timedelta(hours=5), offline=True)
    assert jobs(again, runner.DIGEST)[0].status == "skipped" and len(fake.sent) == 1
    monday = work(fake, now=MONDAY, offline=True)
    assert jobs(monday, runner.DIGEST) == [] and len(fake.sent) == 1


def test_digest_weekday_from_the_strategy_and_retry_after_failure(db_engine):
    pid, slug = make_profile("Dom")
    write_strategy(slug, with_notifications(STRATEGY_YAML, weekday="monday"))
    assert work(RecordingNotifier(), now=SUNDAY, offline=True).jobs[-1].job != runner.DIGEST

    broken = RecordingNotifier(fail=True)
    failed = work(broken, now=MONDAY, offline=True)
    assert jobs(failed, runner.DIGEST)[0].status == "failed"
    assert worker_state.load().digests == {}  # undone: the next run tries again

    fake = RecordingNotifier()
    ok = work(fake, now=MONDAY + dt.timedelta(hours=1), offline=True)
    assert jobs(ok, runner.DIGEST)[0].status == "ok"
    assert [n.message for n in fake.sent] == ["Brak sygnałów do przeglądu"]
    assert worker_state.load().digests == {str(pid): "2026-03-02"}


def test_no_digest_without_investments(db_engine):
    make_profile("Budżet", modules=("budget",))
    report = work(RecordingNotifier(), now=SUNDAY, offline=True, budget=False)
    assert jobs(report, runner.DIGEST) == [] and jobs(report, runner.NOTIFICATIONS) == []


# --------------------------------------------------------------------------- #
# Budget sync
# --------------------------------------------------------------------------- #


def eb_session(make_eb_txn) -> dict:
    return {
        "sess-1": {
            "aspsp": {"name": "mBank"},
            "accounts": [
                {
                    "uid": "uid-main",
                    "currency": "PLN",
                    "account_id": {"iban": "PL" + "99114000000000000000000001"},
                }
            ],
            "transactions": {
                "uid-main": [
                    make_eb_txn("2026-02-27", "25.00", "BIEDRONKA 123 TEST", ref="eb-1"),
                ]
            },
        },
    }


@pytest.fixture
def household(db_engine):
    pid, slug = make_profile("Dom", modules=("budget",))
    return pid, slug


def test_budget_sync_skipped_when_not_configured(household, monkeypatch):
    from finanse.config import settings

    monkeypatch.setattr(type(settings), "eb_configured", property(lambda self: False))
    report = work(RecordingNotifier())
    (job,) = jobs(report, runner.BUDGET_SYNC)
    assert (job.status, job.detail) == ("skipped", "Enable Banking not configured")
    assert worker_state.load().budget == {str(household[0]): {}}
    assert report.status == "ok"


def test_budget_sync_skipped_without_sessions(household, eb_configured, fake_eb):
    eb_configured(fake_eb({}), {})
    (job,) = jobs(work(RecordingNotifier()), runner.BUDGET_SYNC)
    assert (job.status, job.detail) == ("skipped", "no saved bank sessions")


def test_budget_sync_once_then_throttled(household, eb_configured, fake_eb, make_eb_txn):
    pid, _ = household
    client = eb_configured(fake_eb(eb_session(make_eb_txn)), {"mbank": "sess-1"})
    first = work(RecordingNotifier())
    (job,) = jobs(first, runner.BUDGET_SYNC)
    assert job.status == "ok" and job.stats == {"days": 90, "inserted": 1, "banks": 1, "errors": 0}
    book = worker_state.load().budget[str(pid)]
    assert book["last_attempt"] == book["last_success"] == MONDAY.isoformat()
    calls = len(client.calls)

    # a second run the same day never touches the bank
    second = work(RecordingNotifier(), now=MONDAY + dt.timedelta(hours=3))
    (job,) = jobs(second, runner.BUDGET_SYNC)
    assert job.status == "skipped" and job.detail.startswith("throttled until 2026-03-03T03:30")
    assert len(client.calls) == calls

    # the next day: synced again, a short window (dedup keeps it idempotent)
    third = work(RecordingNotifier(), now=MONDAY + dt.timedelta(hours=21))
    (job,) = jobs(third, runner.BUDGET_SYNC)
    assert job.status == "ok" and job.stats["days"] == budget_glue.MIN_DAYS
    assert job.stats["inserted"] == 0


def test_budget_rate_limit_backs_off(household, eb_configured, fake_eb):
    from finanse.modules.budget.ingestion.enable_banking.client import EnableBankingError

    class Throttled(fake_eb):
        def get_session(self, session_id):
            self.calls.append("get_session")
            raise EnableBankingError("GET /sessions/x -> 429: Too Many Requests")

    client = eb_configured(Throttled({}), {"mbank": "sess-1"})
    (job,) = jobs(work(RecordingNotifier()), runner.BUDGET_SYNC)
    assert job.status == "partial" and "429" in job.detail
    assert client.calls == ["get_session"]  # one attempt, no retry loop
    book = worker_state.load().budget[str(household[0])]
    assert book["throttled_until"] == (MONDAY + budget_glue.RATE_LIMIT_BACKOFF).isoformat()
    assert "last_success" not in book

    later = work(RecordingNotifier(), now=MONDAY + dt.timedelta(hours=30))
    assert jobs(later, runner.BUDGET_SYNC)[0].detail.startswith("throttled until 2026-03-04T07:30")
    assert client.calls == ["get_session"]


def test_budget_disabled_for_the_run(household, eb_configured, fake_eb, make_eb_txn):
    client = eb_configured(fake_eb(eb_session(make_eb_txn)), {"mbank": "sess-1"})
    (job,) = jobs(work(RecordingNotifier(), budget=False), runner.BUDGET_SYNC)
    assert (job.status, job.detail) == ("skipped", "disabled for this run")
    assert client.calls == []


def test_days_to_fetch():
    now = dt.datetime(2026, 3, 10, 7, 30, tzinfo=dt.UTC)
    assert budget_glue.days_to_fetch({}, now) == 90
    assert budget_glue.days_to_fetch({"last_success": "2026-03-09T07:30:00+00:00"}, now) == 10
    assert budget_glue.days_to_fetch({"last_success": "2026-02-20T07:30:00+00:00"}, now) == 21
    assert budget_glue.days_to_fetch({"last_success": "2025-01-01T00:00:00+00:00"}, now) == 90
    assert budget_glue.days_to_fetch({"last_success": "garbage"}, now) == 90


# --------------------------------------------------------------------------- #
# Isolation of jobs, locks
# --------------------------------------------------------------------------- #


def test_a_failing_job_does_not_stop_the_others(investor, monkeypatch):
    daily.run_daily_check("api", as_of=AS_OF, sources=sources())  # one pending entry

    def boom(**_kwargs):
        raise RuntimeError("synthetic failure")

    monkeypatch.setattr(inv, "run_daily_check", boom)
    fake = RecordingNotifier()
    report = work(fake)
    (check,) = jobs(report, runner.INVESTMENTS_DAILY)
    assert check.status == "failed" and check.detail == "RuntimeError: synthetic failure"
    assert len(fake.sent) == 1 and report.status == "partial"
    assert worker_state.load().last_run["status"] == "partial"


def test_daily_check_busy_is_skipped(investor):
    with locks.run_lock(daily.LOCK_NAME):
        report = work(RecordingNotifier(), daily_lock_wait=0)
    (check,) = jobs(report, runner.INVESTMENTS_DAILY)
    assert check.status == "skipped" and check.detail.startswith("busy")


def test_worker_runs_never_overlap(db_engine):
    with locks.run_lock(runner.WORKER_LOCK), pytest.raises(runner.WorkerBusy):
        work(RecordingNotifier())


def test_nothing_to_do(db_engine):
    report = work(RecordingNotifier())
    assert report.jobs == [] and report.status == "ok"
    assert worker_state.load().last_run["status"] == "ok"
    assert worker_state.state_path().stat().st_mode & 0o777 == 0o600
