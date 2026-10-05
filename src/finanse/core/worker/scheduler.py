"""Scheduling the worker with the OS, behind one seam (``Scheduler``).

- macOS: ``LaunchdScheduler`` writes a LaunchAgent plist (``StartCalendarInterval``, daily at the
  configured time; stdout and stderr appended to ``<data dir>/logs/worker.log``) into
  ``~/Library/LaunchAgents`` and loads it with ``launchctl bootstrap gui/<uid>``; uninstall is
  ``launchctl bootout`` plus removing the plist. launchd runs a missed job once when the Mac wakes.
- Windows: ``WindowsTaskScheduler`` is an interface stub (Task Scheduler, later).
- Elsewhere: ``UnsupportedScheduler`` (status only).

Status never calls launchctl: "installed" means the plist is in place, and the schedule and the
command come from the plist itself. Every launchctl call goes through an injectable runner and the
agents dir is injectable (``FINANSE_LAUNCH_AGENTS_DIR``), so tests never touch the real ones.
"""

from __future__ import annotations

import os
import plistlib
import sys
from collections.abc import Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Protocol

from .. import paths
from .notifier import CommandResult, CommandRunner, run_command
from .schedule import DEFAULT_SCHEDULE, Schedule

DEFAULT_LABEL = "io.github.synszakala.finanse.worker"
LAUNCH_AGENTS_ENV = "FINANSE_LAUNCH_AGENTS_DIR"
LOG_FILENAME = "worker.log"
# A launchd agent starts with PATH=/usr/bin:/bin:/usr/sbin:/sbin; add Homebrew for terminal-notifier.
AGENT_PATH = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
WORKER_ARGS = ("worker", "run")


class WorkerSchedulerError(RuntimeError):
    """Installing or removing the scheduled job failed (message is safe to show)."""


class WorkerUnsupported(WorkerSchedulerError):
    """This platform has no scheduler implementation yet."""


def log_path() -> Path:
    return paths.logs_dir() / LOG_FILENAME


def default_agents_dir() -> Path:
    raw = os.environ.get(LAUNCH_AGENTS_ENV, "").strip()
    return Path(raw).expanduser() if raw else Path.home() / "Library" / "LaunchAgents"


# --------------------------------------------------------------------------- #
# Entry point (what the scheduled job runs)
# --------------------------------------------------------------------------- #


def entry_point(program: str | None = None) -> list[str]:
    """The command that starts finanse, without the ``worker run`` arguments.

    ``program`` (CLI ``--program``) > setting ``FINANSE_WORKER_PROGRAM`` > the packaged app binary
    (a frozen build) > the ``finanse`` script next to this interpreter (the venv) > ``python -m
    finanse.cli``."""
    from ...config import settings

    explicit = program or settings.worker_program
    if explicit:
        return [str(Path(explicit).expanduser())]
    if getattr(sys, "frozen", False):  # PyInstaller app (F5): the binary handles the CLI args
        return [sys.executable]
    script = Path(sys.executable).parent / ("finanse.exe" if os.name == "nt" else "finanse")
    if script.exists():
        return [str(script)]
    return [sys.executable, "-m", "finanse.cli"]


# --------------------------------------------------------------------------- #
# The seam
# --------------------------------------------------------------------------- #


@dataclass
class SchedulerStatus:
    platform: str  # launchd | windows-task | unsupported
    supported: bool
    installed: bool
    label: str
    schedule: Schedule | None = None  # from the installed job (None when not installed)
    program: list[str] = field(default_factory=list)  # installed command line
    job_path: str | None = None  # plist path (launchd)
    log_path: str | None = None


class Scheduler(Protocol):
    platform: str
    label: str

    def status(self) -> SchedulerStatus: ...

    def install(self, schedule: Schedule, program: Sequence[str]) -> SchedulerStatus: ...

    def uninstall(self) -> SchedulerStatus: ...


# --------------------------------------------------------------------------- #
# macOS: launchd
# --------------------------------------------------------------------------- #


class LaunchdScheduler:
    platform = "launchd"

    def __init__(
        self,
        *,
        label: str = DEFAULT_LABEL,
        agents_dir: Path | None = None,
        runner: CommandRunner = run_command,
        uid: int | None = None,
    ) -> None:
        self.label = label
        self.agents_dir = agents_dir or default_agents_dir()
        self._runner = runner
        self._uid = uid

    @property
    def plist_path(self) -> Path:
        return self.agents_dir / f"{self.label}.plist"

    @property
    def domain(self) -> str:
        uid = self._uid if self._uid is not None else os.getuid()
        return f"gui/{uid}"

    def plist(self, schedule: Schedule, program: Sequence[str]) -> dict:
        """The LaunchAgent definition (a dict for ``plistlib``)."""
        env = {"PATH": AGENT_PATH, "PYTHONUNBUFFERED": "1"}
        # Only an explicit data dir is pinned: setting it while finanse runs on the legacy
        # repo data/ dir would switch the agent to a different (empty) database.
        override = paths.data_dir_override()
        if override is not None:
            env[paths.DATA_DIR_ENV] = str(override)
        log = str(log_path())
        return {
            "Label": self.label,
            "ProgramArguments": [*program, *WORKER_ARGS],
            "StartCalendarInterval": {"Hour": schedule.hour, "Minute": schedule.minute},
            "RunAtLoad": False,
            "ProcessType": "Background",
            "LowPriorityIO": True,
            "WorkingDirectory": str(paths.data_dir()),
            "StandardOutPath": log,
            "StandardErrorPath": log,
            "EnvironmentVariables": env,
        }

    def render(self, schedule: Schedule, program: Sequence[str]) -> bytes:
        return plistlib.dumps(self.plist(schedule, program), sort_keys=False)

    def _read(self) -> dict | None:
        try:
            with self.plist_path.open("rb") as f:
                data = plistlib.load(f)
        except (OSError, plistlib.InvalidFileException, ValueError):
            return None
        return data if isinstance(data, dict) else None

    def status(self) -> SchedulerStatus:
        installed = self.plist_path.exists()
        data = self._read() if installed else None
        schedule = None
        program: list[str] = []
        if data:
            interval = data.get("StartCalendarInterval")
            if isinstance(interval, dict):
                try:
                    schedule = Schedule(
                        int(interval.get("Hour", 0)), int(interval.get("Minute", 0))
                    )
                except (TypeError, ValueError):
                    schedule = None
            args = data.get("ProgramArguments")
            if isinstance(args, list):
                program = [str(a) for a in args]
        return SchedulerStatus(
            platform=self.platform,
            supported=True,
            installed=installed,
            label=self.label,
            schedule=schedule,
            program=program,
            job_path=str(self.plist_path),
            log_path=str(log_path()),
        )

    def _launchctl(self, *args: str) -> CommandResult:
        return self._runner(["/bin/launchctl", *args])

    def install(
        self, schedule: Schedule = DEFAULT_SCHEDULE, program: Sequence[str] = ()
    ) -> SchedulerStatus:
        program = list(program) or entry_point()
        paths.ensure_private_dir(paths.logs_dir())
        self.agents_dir.mkdir(parents=True, exist_ok=True)
        body = self.render(schedule, program)
        tmp = self.plist_path.with_name(f".{self.plist_path.name}.tmp")
        tmp.write_bytes(body)
        os.chmod(tmp, 0o644)  # launchd refuses group/world-writable agent files
        os.replace(tmp, self.plist_path)
        # Re-install: unload the old definition first (fails harmlessly when not loaded).
        self._launchctl("bootout", f"{self.domain}/{self.label}")
        result = self._launchctl("bootstrap", self.domain, str(self.plist_path))
        if result.returncode != 0:
            detail = (result.stderr or result.stdout).strip()[:300]
            raise WorkerSchedulerError(
                f"launchctl bootstrap failed (exit {result.returncode}): {detail}. "
                f"The agent file stays at {self.plist_path}."
            )
        self._launchctl("enable", f"{self.domain}/{self.label}")
        return self.status()

    def uninstall(self) -> SchedulerStatus:
        if self.plist_path.exists():
            # Not loaded (exit 3 / 113) is fine: the goal is "not scheduled".
            self._launchctl("bootout", f"{self.domain}/{self.label}")
            self.plist_path.unlink(missing_ok=True)
        return self.status()


# --------------------------------------------------------------------------- #
# Windows (later) and everything else
# --------------------------------------------------------------------------- #


class WindowsTaskScheduler:
    """Windows Task Scheduler (``schtasks /Create /SC DAILY /ST HH:MM``), not implemented yet."""

    platform = "windows-task"

    def __init__(self, *, label: str = "finanse-worker") -> None:
        self.label = label

    def status(self) -> SchedulerStatus:
        return SchedulerStatus(self.platform, False, False, self.label, log_path=str(log_path()))

    def install(
        self, schedule: Schedule = DEFAULT_SCHEDULE, program: Sequence[str] = ()
    ) -> SchedulerStatus:
        raise WorkerUnsupported("The Windows Task Scheduler job is not implemented yet.")

    def uninstall(self) -> SchedulerStatus:
        raise WorkerUnsupported("The Windows Task Scheduler job is not implemented yet.")


class UnsupportedScheduler:
    """No OS scheduler integration on this platform (run ``finanse worker run`` from cron)."""

    platform = "unsupported"

    def __init__(self, *, label: str = DEFAULT_LABEL) -> None:
        self.label = label

    def status(self) -> SchedulerStatus:
        return SchedulerStatus(self.platform, False, False, self.label, log_path=str(log_path()))

    def install(
        self, schedule: Schedule = DEFAULT_SCHEDULE, program: Sequence[str] = ()
    ) -> SchedulerStatus:
        raise WorkerUnsupported(
            "No scheduler integration on this platform; run `finanse worker run` from cron."
        )

    def uninstall(self) -> SchedulerStatus:
        return self.status()


def default_scheduler(platform: str | None = None) -> Scheduler:
    platform = platform or sys.platform
    if platform == "darwin":
        return LaunchdScheduler()
    if platform == "win32":
        return WindowsTaskScheduler()
    return UnsupportedScheduler()
