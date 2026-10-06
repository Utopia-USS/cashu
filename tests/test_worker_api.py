"""Worker endpoints: the `worker` object of GET /api/system, POST /api/system/worker/install |
uninstall | run. The scheduler and the notifier are fakes (temp agents dir, fake launchctl,
recording notifier)."""

from __future__ import annotations

import datetime as dt

import pytest
from test_worker_runner import RecordingNotifier
from test_worker_scheduler import FakeLaunchctl

from cashu.core import locks
from cashu.core.db import get_session
from cashu.core.worker import runner, service
from cashu.core.worker import scheduler as sched
from cashu.core.worker import state as worker_state

WORKER_KEYS = {
    "installed",
    "label",
    "schedule",
    "last_run",
    "last_status",
    "next_run",
    "log_path",
    "platform",
    "supported",
    "job_path",
    "program",
    "jobs",
    "relocation",
}


@pytest.fixture
def fakes(tmp_path, monkeypatch):
    launchctl = FakeLaunchctl()
    scheduler = sched.LaunchdScheduler(agents_dir=tmp_path / "agents", runner=launchctl, uid=501)
    notifier = RecordingNotifier()
    monkeypatch.setattr(service, "get_scheduler", lambda: scheduler)
    monkeypatch.setattr(service, "get_notifier", lambda name="auto": notifier)
    monkeypatch.setattr(sched, "entry_point", lambda program=None: ["/venv/bin/cashu"])
    return scheduler, launchctl, notifier


def test_system_worker_shape_not_installed(api_empty, tmp_path, fakes):
    worker = api_empty.get("/api/system").json()["worker"]
    assert set(worker) == WORKER_KEYS
    assert worker == {
        "installed": False,
        "label": sched.DEFAULT_LABEL,
        "schedule": "07:30",
        "last_run": None,
        "last_status": None,
        "next_run": None,
        "log_path": str((tmp_path / "data").resolve() / "logs" / "worker.log"),
        "platform": "launchd",
        "supported": True,
        "job_path": str(tmp_path / "agents" / f"{sched.DEFAULT_LABEL}.plist"),
        "program": None,
        "jobs": [],
        "relocation": {"worker": None, "mcp": None},
    }


def test_system_worker_without_fakes_reads_the_redirected_dir(api_empty, tmp_path):
    """The real factories under the test suite: the agents dir is the conftest's temp dir."""
    worker = api_empty.get("/api/system").json()["worker"]
    assert worker["installed"] is False
    if worker["platform"] == "launchd":
        assert worker["job_path"].startswith(str(tmp_path / "LaunchAgents"))


def test_install_and_uninstall(api_empty, fakes):
    _scheduler, launchctl, _ = fakes
    body = api_empty.post("/api/system/worker/install", json={"time": "06:45"}).json()["worker"]
    assert body["installed"] is True and body["schedule"] == "06:45"
    assert body["program"] == ["/venv/bin/cashu", "worker", "run"]
    next_run = dt.datetime.fromisoformat(body["next_run"])
    assert (next_run.hour, next_run.minute) == (6, 45) and next_run > dt.datetime.now().astimezone()
    assert launchctl.verbs == ["bootout", "bootstrap", "enable"]
    assert api_empty.get("/api/system").json()["worker"]["installed"] is True

    # re-install without a time keeps the installed one
    assert api_empty.post("/api/system/worker/install").json()["worker"]["schedule"] == "06:45"
    again = api_empty.post("/api/system/worker/install", json={}).json()["worker"]
    assert again["schedule"] == "06:45"

    gone = api_empty.post("/api/system/worker/uninstall").json()["worker"]
    assert gone["installed"] is False and gone["next_run"] is None and gone["schedule"] == "07:30"
    assert launchctl.verbs[-1] == "bootout"


def test_install_errors(api_empty, fakes, monkeypatch, tmp_path):
    r = api_empty.post("/api/system/worker/install", json={"time": "25:00"})
    assert r.status_code == 422 and "Invalid time" in r.json()["detail"]

    failing = sched.LaunchdScheduler(
        agents_dir=tmp_path / "agents2", runner=FakeLaunchctl({"bootstrap": 5}), uid=501
    )
    monkeypatch.setattr(service, "get_scheduler", lambda: failing)
    r = api_empty.post("/api/system/worker/install")
    assert r.status_code == 500 and "launchctl bootstrap failed" in r.json()["detail"]

    monkeypatch.setattr(service, "get_scheduler", lambda: sched.UnsupportedScheduler())
    r = api_empty.post("/api/system/worker/install")
    assert r.status_code == 501
    assert api_empty.post("/api/system/worker/uninstall").json()["worker"]["supported"] is False


def test_run_endpoint(api_empty, fakes):
    _, _, notifier = fakes
    profile = api_empty.post("/api/profiles", json={"name": "Dom", "modules": ["investments"]})
    assert profile.status_code == 201
    body = api_empty.post("/api/system/worker/run", json={"offline": True}).json()
    run = body["run"]
    assert run["status"] == "ok" and run["offline"] is True and run["notifier"] == "fake"
    assert [(j["job"], j["profile"], j["status"]) for j in run["jobs"]][:2] == [
        ("investments.daily", "dom", "ok"),
        ("notifications", "dom", "ok"),
    ]
    assert {s["job"] for s in run["summary"]} >= {"investments.daily", "notifications"}
    worker = body["worker"]
    assert worker["last_run"] == run["started_at"] and worker["last_status"] == "ok"
    assert {j["job"] for j in worker["jobs"]} >= {"investments.daily", "notifications"}
    assert all(j["last_run"] == run["started_at"] for j in worker["jobs"])
    assert api_empty.get("/api/system").json()["worker"]["last_run"] == run["started_at"]
    assert notifier.sent == [] or notifier.sent[0].subtitle == "Przegląd tygodniowy"


def test_run_endpoint_busy(api_empty, fakes):
    with locks.run_lock(runner.WORKER_LOCK):
        r = api_empty.post("/api/system/worker/run")
    assert r.status_code == 409 and "already running" in r.json()["detail"]


def test_last_run_falls_back_to_rule_runs(api_empty, fakes):
    """Without the worker's own summary, the newest worker-triggered daily-check run counts."""
    from cashu.modules.investments.models import InvRuleRun

    api_empty.post("/api/profiles", json={"name": "Dom", "modules": ["investments"]})
    started = dt.datetime(2026, 3, 2, 6, 30, tzinfo=dt.UTC)
    with get_session() as s:
        s.add(
            InvRuleRun(
                profile_id=1,
                trigger="api",
                as_of=dt.date(2026, 3, 2),
                status="ok",
                started_at=started + dt.timedelta(hours=1),
            )
        )
        s.add(
            InvRuleRun(
                profile_id=1,
                trigger="worker",
                as_of=dt.date(2026, 3, 2),
                status="partial",
                started_at=started,
            )
        )
    worker = api_empty.get("/api/system").json()["worker"]
    assert worker["last_run"] == started.isoformat() and worker["last_status"] == "partial"
    assert [j["job"] for j in worker["jobs"]] == ["investments.daily"]

    # a newer summary in the worker state wins
    st = worker_state.load()
    st.last_run = {
        "status": "ok",
        "started_at": "2026-03-03T07:30:00+01:00",
        "finished_at": "2026-03-03T07:31:00+01:00",
        "jobs": [{"job": "budget.sync", "module": "budget", "status": "ok", "detail": None}],
    }
    worker_state.save(st)
    worker = api_empty.get("/api/system").json()["worker"]
    assert worker["last_run"] == "2026-03-03T07:30:00+01:00" and worker["last_status"] == "ok"
    assert worker["jobs"][0]["job"] == "budget.sync"
