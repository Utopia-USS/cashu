"""Worker control used by the CLI and the API: platform factories, status, install, uninstall.

``get_scheduler`` / ``get_notifier`` are the seams tests replace (fakes, temp dirs): nothing here
calls launchctl or a notifier unless asked to install, uninstall or run.
"""

from __future__ import annotations

import datetime as dt
import logging
from pathlib import Path
from typing import Any

from ..db import get_session
from . import investments as inv
from . import scheduler as sched
from . import state as worker_state
from .notifier import Notifier, default_notifier
from .schedule import DEFAULT_SCHEDULE, Schedule, local_now

log = logging.getLogger("finanse.worker")


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


def _mcp_lines_possible() -> bool:
    """Whether an agent client may hold an MCP line with the app's old path: a profile workspace
    exists (its .mcp.json), or ``finanse mcp`` was started at least once (F7 review R8)."""
    from .. import runtime

    if runtime.mcp_ever_started():
        return True
    try:
        from ..profiles import list_profiles
        from ..workspace import service as workspace

        with get_session() as s:
            slugs = [p.slug for p in list_profiles(s)]
        for slug in slugs:
            ws = workspace.configured_path(slug) or workspace.default_path(slug)
            if (ws / workspace.MANIFEST_FILE).is_file():
                return True
    except Exception:
        log.warning("could not check the profile workspaces", exc_info=True)
        return True
    return False


def relocation(installed_program: list[str] | None) -> dict:
    """Stale paths after Finanse.app was moved or renamed, or after another install took over
    (PK11), in two independent parts (F7 review R8); each is None when nothing is stale. Nothing is
    rewritten.

    - ``worker``: the installed job's program is stale; cleared by a re-install (``finanse worker
      install`` / POST /api/system/worker/install), derived from the job itself:
      ``{reason: "missing" | "other_program", program, expected_program, actions: ["worker_reinstall"]}``
      ("missing": the program no longer exists, launchd fails every day without a line in worker.log;
      "other_program": the job runs another install, e.g. the old app path or the dev venv;
      ``expected_program``: what a re-install writes, None when it cannot, e.g. translocated);
    - ``mcp``: Finanse.app was moved and an MCP line may still name the old path (raised only when a
      profile workspace exists or ``finanse mcp`` ever started):
      ``{reason: "app_moved", app_moved_from, moved_at, actions: ["mcp_readd"]}``; cleared by
      POST /api/system/relocation/ack or a workspace update that rewrote its .mcp.json."""
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
    mcp = None
    if moved_from is not None and _mcp_lines_possible():
        mcp = {
            "reason": "app_moved",
            "app_moved_from": moved_from,
            "moved_at": runtime.app_moved_at(),
            "actions": ["mcp_readd"],
        }
    return {
        "worker": None
        if worker is None
        else {
            "reason": worker,
            "program": installed_program[0] if installed_program else None,
            "expected_program": expected,
            "actions": ["worker_reinstall"],
        },
        "mcp": mcp,
    }


def acknowledge_mcp_relocation() -> dict:
    """The owner re-added the MCP lines after a move (Settings "Gotowe"): clear the mcp part."""
    from .. import runtime

    runtime.clear_app_move()
    return status()


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
    # the worker part of a relocation is derived from the job, so it is fixed now; the MCP part
    # (lines in agent clients) stays until acknowledged (F7 review R8)
    return status()


def uninstall() -> dict:
    get_scheduler().uninstall()
    return status()
