"""Worker scheduling: the daily schedule, the launchd agent (plist content, install / uninstall
through a fake launchctl in a temp agents dir), the entry point and the platform seams. Nothing
here touches the real ~/Library/LaunchAgents or runs launchctl."""

from __future__ import annotations

import datetime as dt
import os
import plistlib
import stat
import sys
from pathlib import Path

import pytest

from cashu.core import paths
from cashu.core.worker import scheduler as sched
from cashu.core.worker.notifier import CommandResult
from cashu.core.worker.schedule import Schedule, ScheduleError


class FakeLaunchctl:
    """Records every command; answers with the configured exit code per launchctl verb."""

    def __init__(self, codes: dict[str, int] | None = None) -> None:
        self.calls: list[list[str]] = []
        self.codes = codes or {}

    def __call__(self, args) -> CommandResult:
        args = list(args)
        self.calls.append(args)
        code = self.codes.get(args[1], 0) if len(args) > 1 else 0
        return CommandResult(code, "", "Bootstrap failed: 5: Input/output error" if code else "")

    @property
    def verbs(self) -> list[str]:
        return [c[1] for c in self.calls]


@pytest.fixture
def data_dir(tmp_path, monkeypatch) -> Path:
    monkeypatch.setenv("CASHU_DATA_DIR", str(tmp_path / "data"))
    return (tmp_path / "data").resolve()


@pytest.fixture
def launchd(tmp_path, data_dir):
    fake = FakeLaunchctl()
    agents = tmp_path / "agents"
    return sched.LaunchdScheduler(agents_dir=agents, runner=fake, uid=501), fake, agents


PROGRAM = ["/opt/cashu/.venv/bin/cashu"]


# --------------------------------------------------------------------------- #
# Schedule
# --------------------------------------------------------------------------- #


def test_schedule_parse_and_next_run():
    assert Schedule.parse("7:05") == Schedule(7, 5) and Schedule.parse(" 23:59 ").time == "23:59"
    assert Schedule().time == "07:30"
    for bad in ("24:00", "7:60", "7", "07:3", "x"):
        with pytest.raises(ScheduleError):
            Schedule.parse(bad)
    tz = dt.timezone(dt.timedelta(hours=2))
    s = Schedule(7, 30)
    assert s.next_run(dt.datetime(2026, 10, 5, 6, 0, tzinfo=tz)) == dt.datetime(
        2026, 10, 5, 7, 30, tzinfo=tz
    )
    # exactly at / after the time -> tomorrow (also across a month end)
    assert s.next_run(dt.datetime(2026, 10, 5, 7, 30, tzinfo=tz)).date() == dt.date(2026, 10, 6)
    assert s.next_run(dt.datetime(2026, 10, 31, 9, 0, tzinfo=tz)).date() == dt.date(2026, 11, 1)


# --------------------------------------------------------------------------- #
# launchd agent
# --------------------------------------------------------------------------- #


def test_plist_content(launchd, data_dir):
    scheduler, _fake, _ = launchd
    plist = plistlib.loads(scheduler.render(Schedule(6, 45), PROGRAM))
    assert plist["Label"] == sched.DEFAULT_LABEL
    assert plist["ProgramArguments"] == [*PROGRAM, "worker", "run"]
    assert plist["StartCalendarInterval"] == {"Hour": 6, "Minute": 45}
    assert plist["RunAtLoad"] is False
    log = str(data_dir / "logs" / "worker.log")
    assert plist["StandardOutPath"] == log and plist["StandardErrorPath"] == log
    assert plist["WorkingDirectory"] == str(data_dir)
    env = plist["EnvironmentVariables"]
    assert "/opt/homebrew/bin" in env["PATH"].split(":") and "/usr/bin" in env["PATH"]
    # the explicit data dir is pinned, so the agent uses the same database
    assert env["CASHU_DATA_DIR"] == str(data_dir)


def test_plist_does_not_pin_the_platform_default_data_dir(launchd, monkeypatch):
    """Without CASHU_DATA_DIR (e.g. legacy repo data/ mode) the agent must resolve the data
    dir itself; pinning the default would switch it to another database."""
    scheduler, _fake, _ = launchd
    monkeypatch.delenv("CASHU_DATA_DIR")
    monkeypatch.setattr(paths, "default_data_dir", lambda: Path("/nonexistent/cashu-test"))
    plist = scheduler.plist(Schedule(), PROGRAM)
    assert "CASHU_DATA_DIR" not in plist["EnvironmentVariables"]


def test_install_writes_the_agent_and_bootstraps_it(launchd, data_dir):
    scheduler, fake, agents = launchd
    status = scheduler.install(Schedule(6, 45), PROGRAM)
    plist_path = agents / f"{sched.DEFAULT_LABEL}.plist"
    assert plist_path.exists()
    assert stat.S_IMODE(plist_path.stat().st_mode) == 0o644
    assert not list(agents.glob(".*.tmp"))
    assert (data_dir / "logs").is_dir()
    target = f"gui/501/{sched.DEFAULT_LABEL}"
    assert fake.calls == [
        ["/bin/launchctl", "bootout", target],
        ["/bin/launchctl", "bootstrap", "gui/501", str(plist_path)],
        ["/bin/launchctl", "enable", target],
    ]
    assert status.installed and status.supported and status.platform == "launchd"
    assert status.schedule == Schedule(6, 45)
    assert status.program == [*PROGRAM, "worker", "run"]
    assert status.job_path == str(plist_path)
    assert status.log_path == str(data_dir / "logs" / "worker.log")


def test_reinstall_replaces_the_schedule(launchd):
    scheduler, fake, _ = launchd
    scheduler.install(Schedule(6, 45), PROGRAM)
    scheduler.install(Schedule(21, 0), PROGRAM)
    assert scheduler.status().schedule == Schedule(21, 0)
    assert fake.verbs == ["bootout", "bootstrap", "enable"] * 2


def test_bootstrap_failure_raises_with_the_reason(tmp_path, data_dir):
    fake = FakeLaunchctl({"bootstrap": 5})
    scheduler = sched.LaunchdScheduler(agents_dir=tmp_path / "agents", runner=fake, uid=501)
    with pytest.raises(sched.WorkerSchedulerError, match=r"\(exit 5\): Bootstrap failed"):
        scheduler.install(Schedule(), PROGRAM)
    assert "enable" not in fake.verbs


def test_uninstall_boots_out_and_removes_the_agent(launchd):
    scheduler, fake, agents = launchd
    scheduler.install(Schedule(), PROGRAM)
    fake.calls.clear()
    fake.codes["bootout"] = 3  # "not loaded" is fine
    status = scheduler.uninstall()
    assert not status.installed and status.schedule is None and status.program == []
    assert fake.calls == [["/bin/launchctl", "bootout", f"gui/501/{sched.DEFAULT_LABEL}"]]
    assert not list(agents.iterdir())
    # uninstalling again changes nothing and calls nothing
    fake.calls.clear()
    assert not scheduler.uninstall().installed and fake.calls == []


def test_status_reads_the_plist_only(launchd):
    scheduler, fake, agents = launchd
    status = scheduler.status()
    assert not status.installed and status.schedule is None
    agents.mkdir(parents=True)
    (agents / f"{sched.DEFAULT_LABEL}.plist").write_bytes(b"not a plist")
    broken = scheduler.status()
    assert broken.installed and broken.schedule is None and broken.program == []
    assert fake.calls == []  # status never runs launchctl


def test_default_agents_dir_is_redirected_in_tests(tmp_path):
    """The root conftest points the agents dir into tmp_path for every test."""
    assert sched.default_agents_dir() == tmp_path / "LaunchAgents"
    assert sched.LaunchdScheduler().agents_dir == tmp_path / "LaunchAgents"
    assert Path.home() / "Library" / "LaunchAgents" != sched.default_agents_dir()


# --------------------------------------------------------------------------- #
# Entry point and platforms
# --------------------------------------------------------------------------- #


def test_entry_point_resolution(tmp_path, monkeypatch):
    from cashu.config import settings

    monkeypatch.setattr(settings, "worker_program", None)
    assert sched.entry_point("/Applications/cashu.app/Contents/MacOS/cashu") == [
        "/Applications/cashu.app/Contents/MacOS/cashu"
    ]
    monkeypatch.setattr(settings, "worker_program", "/opt/bin/cashu")
    assert sched.entry_point() == ["/opt/bin/cashu"]
    assert sched.entry_point("/explicit/cashu") == ["/explicit/cashu"]  # CLI option wins
    monkeypatch.setattr(settings, "worker_program", None)

    venv_bin = tmp_path / "venv" / "bin"
    venv_bin.mkdir(parents=True)
    python = venv_bin / "python"
    monkeypatch.setattr(sys, "executable", str(python))
    assert sched.entry_point() == [str(python), "-m", "cashu.cli"]  # no script next to it
    script = venv_bin / ("cashu.exe" if os.name == "nt" else "cashu")
    script.write_text("#!/bin/sh\n")
    assert sched.entry_point() == [str(script)]
    monkeypatch.setattr(sys, "frozen", True, raising=False)
    assert sched.entry_point() == [str(python)]  # the packaged app binary itself


def test_platform_seams():
    assert isinstance(sched.default_scheduler("darwin"), sched.LaunchdScheduler)
    windows = sched.default_scheduler("win32")
    assert windows.platform == "windows-task" and not windows.status().supported
    with pytest.raises(sched.WorkerUnsupported):
        windows.install(Schedule(), PROGRAM)
    with pytest.raises(sched.WorkerUnsupported):
        windows.uninstall()
    other = sched.default_scheduler("linux")
    assert other.platform == "unsupported" and not other.status().installed
    with pytest.raises(sched.WorkerUnsupported, match="cron"):
        other.install(Schedule(), PROGRAM)
    assert not other.uninstall().installed
