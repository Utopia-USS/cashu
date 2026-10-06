"""`cashu worker run|install|uninstall|status` with fakes: the log notifier, fake market sources,
a temp agents dir and a fake launchctl."""

from __future__ import annotations

import datetime as dt
import json
import plistlib

import pytest
from rich.console import Console
from test_worker_runner import (  # also re-exports the investments test helpers
    AS_OF,
    MONDAY,
    add_account,
    canonical_csv,
    import_file,
    make_profile,
    sources,
    write_strategy,
)
from test_worker_scheduler import FakeLaunchctl
from typer.testing import CliRunner

from cashu import cli as cli_mod
from cashu.core import cliutil, locks
from cashu.core.worker import runner, service
from cashu.core.worker import scheduler as sched
from cashu.modules.investments.service import daily, portfolio


@pytest.fixture
def run(monkeypatch, db_engine):
    monkeypatch.setattr(cliutil, "console", Console(width=220, color_system=None))
    monkeypatch.setattr(cliutil, "_profile_slug", None)
    monkeypatch.setattr(daily, "default_sources", lambda: sources())
    monkeypatch.setattr(portfolio, "today", lambda: AS_OF)
    monkeypatch.setattr(runner, "local_now", lambda: MONDAY)  # not a digest day
    cli = CliRunner()

    def _run(*args, code=0):
        res = cli.invoke(cli_mod.app, [str(a) for a in args])
        assert res.exit_code == code, res.output + repr(res.exception)
        return res

    return _run


@pytest.fixture
def fake_scheduler(tmp_path, monkeypatch):
    launchctl = FakeLaunchctl()
    scheduler = sched.LaunchdScheduler(agents_dir=tmp_path / "agents", runner=launchctl, uid=501)
    monkeypatch.setattr(service, "get_scheduler", lambda: scheduler)
    return scheduler, launchctl


def test_worker_run_with_the_log_notifier(run):
    pid, slug = make_profile("Inwestor")
    import_file(pid, add_account(pid), canonical_csv())
    write_strategy(slug)

    out = run("worker", "run", "--notifier", "log").output
    assert "worker run: ok (notifier: log)" in out
    assert "investments.daily [inwestor]: ok" in out
    assert "[powiadomienie] cashU: Inwestor | Sygnał do działania |" in out
    assert "notifications [inwestor]: ok (delivered=1)" in out

    again = run("worker", "run", "--notifier", "log").output
    assert "[powiadomienie]" not in again and "notifications [inwestor]: ok" in again


def test_worker_run_json_offline_and_errors(run):
    make_profile("Dom", modules=("investments", "budget"))
    body = json.loads(run("worker", "run", "--offline", "--notifier", "none", "--json").output)
    assert body["status"] == "ok" and body["offline"] is True and body["notifier"] is None
    by_job = {j["job"]: j for j in body["jobs"]}
    assert by_job["budget.sync"]["detail"] == "disabled for this run"  # offline: no bank calls
    assert by_job["notifications"]["status"] == "skipped"

    assert "Unknown notifier" in run("worker", "run", "--notifier", "pigeon", code=2).output
    with locks.run_lock(runner.WORKER_LOCK):
        busy = run("worker", "run", "--notifier", "none", code=1)
    assert "worker busy" in busy.output


def test_worker_run_with_nothing_to_do(run):
    out = run("worker", "run", "--notifier", "none").output
    assert "nothing to do" in out


def test_install_dry_run_changes_nothing(run, fake_scheduler):
    scheduler, launchctl = fake_scheduler
    out = run("worker", "install", "--time", "6:45", "--program", "/x/cashu", "--dry-run").output
    plist = plistlib.loads(out.encode("utf-8"))
    assert plist["ProgramArguments"] == ["/x/cashu", "worker", "run"]
    assert plist["StartCalendarInterval"] == {"Hour": 6, "Minute": 45}
    assert not scheduler.plist_path.exists() and launchctl.calls == []


def test_install_status_uninstall(run, fake_scheduler):
    scheduler, launchctl = fake_scheduler
    out = run("worker", "status").output
    assert "not installed, daily at 07:30" in out and "last run: - (-)" in out

    out = run("worker", "install", "--time", "6:45", "--program", "/x/cashu").output
    assert f"Installed {sched.DEFAULT_LABEL}: daily at 06:45" in out
    assert "command: /x/cashu worker run" in out
    assert launchctl.verbs == ["bootout", "bootstrap", "enable"]
    with scheduler.plist_path.open("rb") as f:
        assert plistlib.load(f)["ProgramArguments"] == ["/x/cashu", "worker", "run"]

    status = json.loads(run("worker", "status", "--json").output)
    assert status["installed"] is True and status["schedule"] == "06:45"
    next_run = dt.datetime.fromisoformat(status["next_run"])
    assert (next_run.hour, next_run.minute) == (6, 45)
    assert "installed, daily at 06:45" in run("worker", "status").output

    assert f"Removed {sched.DEFAULT_LABEL}." in run("worker", "uninstall").output
    assert not scheduler.plist_path.exists()


def test_install_errors(run, fake_scheduler, monkeypatch):
    assert "Invalid time" in run("worker", "install", "--time", "7.30", code=2).output
    monkeypatch.setattr(service, "get_scheduler", lambda: sched.UnsupportedScheduler())
    assert "cron" in run("worker", "install", code=1).output
    assert "No agent file" in run("worker", "install", "--dry-run", code=1).output
    assert "not supported on this platform" in run("worker", "status").output
