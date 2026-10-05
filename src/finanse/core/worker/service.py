"""Worker control used by the CLI and the API: platform factories, status, install, uninstall.

``get_scheduler`` / ``get_notifier`` are the seams tests replace (fakes, temp dirs): nothing here
calls launchctl or a notifier unless asked to install, uninstall or run.
"""

from __future__ import annotations

import datetime as dt
from pathlib import Path
from typing import Any

from ..db import get_session
from . import investments as inv
from . import scheduler as sched
from . import state as worker_state
from .notifier import Notifier, default_notifier
from .schedule import DEFAULT_SCHEDULE, Schedule, local_now


def get_scheduler() -> sched.Scheduler:
    return sched.default_scheduler()


def get_notifier(name: str = "auto") -> Notifier | None:
    return default_notifier(name)


def _parse(value: Any) -> dt.datetime | None:
    if not isinstance(value, str):
        return None
    try:
        parsed = dt.datetime.fromisoformat(value)
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.astimezone()


def last_run() -> dict:
    """The last worker run: the worker's own summary (whole run, all jobs), or, when that is
    missing or older, the newest daily-check run the worker triggered (``inv_rule_runs``)."""
    st = worker_state.load()
    summary = st.last_run or {}
    started = _parse(summary.get("started_at"))
    finished = _parse(summary.get("finished_at")) or started
    out = {
        "last_run": started.isoformat() if started else None,
        "last_status": summary.get("status") if started else None,
        "jobs": [{**job, "last_run": started.isoformat()} for job in summary.get("jobs") or []]
        if started
        else [],
    }
    try:
        with get_session() as s:
            rule_run = inv.last_worker_run(s)
    except Exception:  # noqa: BLE001 - status must answer even on a broken / old database
        rule_run = None
    if rule_run is not None:
        rr_started, rr_status = rule_run
        if finished is None or rr_started > finished:
            out["last_run"], out["last_status"] = rr_started.isoformat(), rr_status
            out["jobs"] = [
                {
                    "job": "investments.daily",
                    "module": "investments",
                    "status": rr_status,
                    "detail": None,
                    "code": None,
                    "params": {},
                    "profile": None,
                    "last_run": rr_started.isoformat(),
                }
            ]
    return out


def relocation(installed_program: list[str] | None) -> dict | None:
    """Stale paths after Finanse.app was moved or renamed, or after another install took over
    (PK11). None when nothing is stale. Nothing is rewritten: the fix is a re-install
    (``finanse worker install`` / POST /api/system/worker/install), which also clears the
    app-moved note, plus re-adding the MCP lines from Settings > Agent AI.

    - ``worker``: "missing" (the job's program no longer exists: launchd fails every day without
      a line in worker.log) or "other_program" (the job runs another install than this one, e.g.
      the old app path or the dev venv); None when the job is fine or not installed;
    - ``expected_program``: what a re-install would write (None when it cannot, e.g. translocated);
    - ``app_moved_from``: where Finanse.app ran from before (MCP configs made then point there);
    - ``actions``: "worker_reinstall", "mcp_readd"."""
    from .. import runtime

    try:
        expected = sched.entry_point()
    except sched.WorkerSchedulerError:
        expected = None
    worker = None
    if installed_program:
        program = installed_program[0]
        if Path(program).is_absolute() and not Path(program).exists():
            worker = "missing"
        elif expected is not None and program != expected[0]:
            worker = "other_program"
    moved_from = runtime.app_moved_from()
    if worker is None and moved_from is None:
        return None
    actions = (["worker_reinstall"] if worker else []) + (["mcp_readd"] if moved_from else [])
    return {
        "worker": worker,
        "expected_program": expected,
        "app_moved_from": moved_from,
        "actions": actions,
    }


def status(*, now: dt.datetime | None = None) -> dict:
    """The ``worker`` object of ``GET /api/system`` (and ``finanse worker status``)."""
    sch = get_scheduler().status()
    schedule = sch.schedule or DEFAULT_SCHEDULE
    next_run = None
    if sch.installed and sch.schedule is not None:
        next_run = sch.schedule.next_run(now or local_now()).isoformat()
    last = last_run()
    return {
        "installed": sch.installed,
        "label": sch.label,
        "schedule": schedule.time,
        "last_run": last["last_run"],
        "last_status": last["last_status"],
        "next_run": next_run,
        "log_path": sch.log_path or str(sched.log_path()),
        "platform": sch.platform,
        "supported": sch.supported,
        "job_path": sch.job_path,
        "program": sch.program or None,
        "jobs": last["jobs"],
        "relocation": relocation(sch.program if sch.installed else None),
    }


def install(schedule: Schedule | None = None, program: str | None = None) -> dict:
    """Install (or re-install) the scheduled job. Without ``schedule`` an installed job keeps its
    time, else the default 07:30."""
    scheduler = get_scheduler()
    current = scheduler.status()
    schedule = schedule or current.schedule or DEFAULT_SCHEDULE
    scheduler.install(schedule, sched.entry_point(program))
    from .. import runtime

    runtime.clear_app_move()  # the re-install is the fix action of a moved app (PK11)
    return status()


def uninstall() -> dict:
    get_scheduler().uninstall()
    return status()
