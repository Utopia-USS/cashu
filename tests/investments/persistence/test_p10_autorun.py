"""The app's automatic daily check (P10, ``service/autorun.py``): due at start without a successful run
today, later only after 07:30; skips quietly when the lock is held; off by env; never raises; the run
state for the window comes from the ``run`` change events (``GET /investments/run/status``)."""

from __future__ import annotations

import datetime as dt
import threading

import pytest
from invp_support import AS_OF, add_account, canonical_csv, import_file, make_profile, sources

from cashu.core import locks
from cashu.core.db import get_session
from cashu.modules.investments.service import autorun, daily, portfolio

LOCAL = dt.datetime.now().astimezone().tzinfo
TODAY = dt.datetime.now().astimezone().date()


def at(h: int, m: int = 0, day: dt.date = TODAY) -> dt.datetime:
    return dt.datetime.combine(day, dt.time(h, m), tzinfo=LOCAL)


def test_due_rule():
    yesterday = TODAY - dt.timedelta(days=1)
    assert autorun.due(None, at(6), at_start=True)
    assert autorun.due(yesterday, at(6), at_start=True)  # opening the app: at once
    assert not autorun.due(yesterday, at(7, 29), at_start=False)  # hourly: only after 07:30
    assert autorun.due(yesterday, at(7, 30), at_start=False)
    assert not autorun.due(TODAY, at(9), at_start=True)  # already ran today
    assert not autorun.due(TODAY, at(23), at_start=False)


@pytest.fixture
def investor(db_engine, monkeypatch):
    monkeypatch.setenv("CASHU_AUTO_DAILY", "1")
    monkeypatch.setattr(portfolio, "today", lambda: AS_OF)
    pid, slug = make_profile()
    import_file(pid, add_account(pid), canonical_csv())
    return pid, slug


def fake_run(calls: list):
    def run(profile_ids):
        calls.append(list(profile_ids))
        return daily.run_daily_check("app", profile_ids=profile_ids, as_of=AS_OF, sources=sources())

    return run


def test_runs_when_due_then_not_again_today(investor):
    pid, _slug = investor
    calls: list = []
    backfills: list = []
    out = autorun.run_if_due(at_start=True, now=lambda: at(8), run=fake_run(calls),
                             backfill=lambda: backfills.append(1))
    assert out.status == "ran" and calls == [[pid]] and backfills == [1]
    again = autorun.run_if_due(at_start=True, now=lambda: at(9), run=fake_run(calls))
    assert again.status == "not_due" and calls == [[pid]]


def test_busy_lock_is_skipped_quietly(investor):
    calls: list = []

    def run(ids):
        calls.append(ids)
        return daily.run_daily_check("app", profile_ids=ids, sources=sources(), lock_wait=0)

    with locks.run_lock(daily.LOCK_NAME):
        out = autorun.run_if_due(at_start=True, now=lambda: at(8), run=run)
    assert out.status == "busy" and calls


def test_disabled_and_failures_never_raise(investor, monkeypatch):
    def boom(ids):
        raise RuntimeError("offline")

    out = autorun.run_if_due(at_start=True, now=lambda: at(8), run=boom)
    assert out.status == "failed" and "RuntimeError" in out.detail
    monkeypatch.setenv("CASHU_AUTO_DAILY", "0")
    assert autorun.run_if_due(at_start=True, run=boom).status == "disabled"
    assert autorun.AutoRunner().start() is False


def test_runner_checks_at_start_then_every_period(monkeypatch):
    monkeypatch.setenv("CASHU_AUTO_DAILY", "1")
    monkeypatch.setattr(autorun, "_prune_events", lambda: None)
    seen: list[bool] = []
    two = threading.Event()

    def check(*, at_start):
        seen.append(at_start)
        if len(seen) >= 2:
            two.set()

    runner = autorun.AutoRunner(every=0.05, check=check)
    assert runner.start()
    assert two.wait(5)
    runner.stop()
    assert seen[:2] == [True, False]


@pytest.fixture
def quiet_investor(db_engine, monkeypatch):
    monkeypatch.setattr(portfolio, "today", lambda: AS_OF)
    pid, slug = make_profile()
    import_file(pid, add_account(pid), canonical_csv())
    return pid, slug


def test_run_status_from_change_events(quiet_investor, api_empty):
    pid, slug = quiet_investor
    client = api_empty
    assert client.get(f"/api/p/{slug}/investments/run/status").json() == {
        "running": False, "started_at": None, "last": None,
    }
    from cashu.core import events

    with get_session() as s:
        events.emit(s, "run", "add", profile_id=pid)
    state = client.get(f"/api/p/{slug}/investments/run/status").json()
    assert state["running"] is True and state["started_at"]
    daily.run_daily_check("app", profile_ids=[pid], as_of=AS_OF, sources=sources())
    state = client.get(f"/api/p/{slug}/investments/run/status").json()
    assert state["running"] is False and state["last"]["status"] in ("ok", "partial")
    assert state["last"]["trigger"] == "app"
