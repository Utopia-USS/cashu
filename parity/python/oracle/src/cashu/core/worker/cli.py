"""``cashu worker run|install|uninstall|status``."""

from __future__ import annotations

import json
from typing import Annotated

import typer

from ..db import init_db
from . import logfile, runner, service
from .notifier import NOTIFIER_NAMES
from .schedule import Schedule, ScheduleError, local_now
from .scheduler import LaunchdScheduler, WorkerSchedulerError, WorkerUnsupported, entry_point

worker_app = typer.Typer(
    help="Background worker: daily rules check, bank sync, notifications, weekly digest.",
    no_args_is_help=True,
)


def _echo_report(report: runner.WorkerReport) -> None:
    stamp = report.started_at.isoformat(timespec="seconds")
    typer.echo(f"{stamp} worker run: {report.status} (notifier: {report.notifier or 'none'})")
    for job in report.jobs:
        who = f" [{job.profile}]" if job.profile else ""
        stats = " ".join(f"{k}={v}" for k, v in job.stats.items() if v not in (None, 0, ""))
        detail = f" - {job.detail}" if job.detail else ""
        typer.echo(f"  {job.job}{who}: {job.status}{detail}{(' (' + stats + ')') if stats else ''}")
    if not report.jobs:
        typer.echo("  nothing to do (no profile with investments or budget enabled)")


@worker_app.command("run")
def run_cmd(
    offline: Annotated[
        bool, typer.Option(help="No network: stored prices and rates only, no bank sync.")
    ] = False,
    notifier: Annotated[
        str,
        typer.Option(help=f"How to notify: {' | '.join(NOTIFIER_NAMES)} (auto = the OS's own)."),
    ] = "auto",
    budget: Annotated[
        bool, typer.Option(help="Sync banks (when configured and not throttled).")
    ] = True,
    as_json: Annotated[bool, typer.Option("--json", help="Print the report as JSON.")] = False,
) -> None:
    """Run every job once: what the scheduled job does (all profiles x enabled modules)."""
    logfile.setup()  # rotate worker.log before anything is written to it, log records to stderr
    init_db()
    try:
        chosen = service.get_notifier(notifier)
    except ValueError as e:
        raise typer.BadParameter(str(e)) from None
    try:
        report = runner.run_worker(notifier=chosen, offline=offline, budget=budget and not offline)
    except runner.WorkerBusy as e:
        typer.echo(f"{local_now().isoformat(timespec='seconds')} worker busy: {e}", err=True)
        raise typer.Exit(1) from None
    if as_json:
        typer.echo(json.dumps(report.to_dict(), indent=2, ensure_ascii=False))
    else:
        _echo_report(report)
    if report.status == "failed":
        raise typer.Exit(1)


@worker_app.command("install")
def install_cmd(
    time: Annotated[
        str | None,
        typer.Option(
            help="Daily run time HH:MM, local (default: keep the installed one, else 07:30)."
        ),
    ] = None,
    program: Annotated[
        str | None,
        typer.Option(help="cashU executable the job runs (default: setting / this install)."),
    ] = None,
    dry_run: Annotated[
        bool, typer.Option("--dry-run", help="Print the launchd agent file, change nothing.")
    ] = False,
) -> None:
    """Schedule the worker with the OS (macOS: a launchd agent in ~/Library/LaunchAgents)."""
    try:
        schedule = Schedule.parse(time) if time else None
    except ScheduleError as e:
        raise typer.BadParameter(str(e)) from None
    scheduler = service.get_scheduler()
    if dry_run:
        if not isinstance(scheduler, LaunchdScheduler):
            typer.echo(f"No agent file on this platform ({scheduler.platform}).")
            raise typer.Exit(1)
        chosen = schedule or scheduler.status().schedule or Schedule()
        typer.echo(scheduler.render(chosen, entry_point(program)).decode("utf-8"), nl=False)
        return
    init_db()
    try:
        info = service.install(schedule, program)
    except (WorkerUnsupported, WorkerSchedulerError) as e:
        typer.echo(str(e), err=True)
        raise typer.Exit(1) from None
    typer.echo(
        f"Installed {info['label']}: daily at {info['schedule']} (next run {info['next_run']})."
    )
    typer.echo(f"  command: {' '.join(info['program'] or [])}")
    typer.echo(f"  log: {info['log_path']}")


@worker_app.command("uninstall")
def uninstall_cmd() -> None:
    """Remove the scheduled job (the worker state and logs stay)."""
    try:
        info = service.uninstall()
    except (WorkerUnsupported, WorkerSchedulerError) as e:
        typer.echo(str(e), err=True)
        raise typer.Exit(1) from None
    typer.echo(f"Removed {info['label']}." if not info["installed"] else "Still installed?")


@worker_app.command("status")
def status_cmd(
    as_json: Annotated[bool, typer.Option("--json", help="Print the status as JSON.")] = False,
) -> None:
    """Installed or not, schedule, last and next run, log file."""
    init_db()
    info = service.status()
    if as_json:
        typer.echo(json.dumps(info, indent=2, ensure_ascii=False))
        return
    if not info["supported"]:
        typer.echo(f"Scheduling is not supported on this platform ({info['platform']}).")
    state = "installed" if info["installed"] else "not installed"
    typer.echo(f"Worker ({info['label']}): {state}, daily at {info['schedule']}")
    if info["installed"]:
        typer.echo(f"  agent file: {info['job_path']}")
        typer.echo(f"  command: {' '.join(info['program'] or [])}")
        typer.echo(f"  next run: {info['next_run']}")
    typer.echo(f"  last run: {info['last_run'] or '-'} ({info['last_status'] or '-'})")
    for job in info["jobs"]:
        detail = f" - {job['detail']}" if job.get("detail") else ""
        typer.echo(f"    {job['job']}: {job['status']}{detail}")
    typer.echo(f"  log: {info['log_path']}")
    _echo_relocation(info.get("relocation"))


def _echo_relocation(rel: dict | None) -> None:
    """Stale paths after a moved / renamed app (PK11) and how to fix them; nothing is rewritten."""
    if not rel:
        return
    worker, mcp = rel.get("worker"), rel.get("mcp")
    if worker and worker.get("reason") == "missing":
        typer.echo("  STALE: the scheduled job's program no longer exists (the app was moved,")
        typer.echo("         renamed or deleted); the job fails without writing to the log.")
    elif worker and worker.get("reason") == "other_program":
        typer.echo("  STALE: the scheduled job runs another cashU install than this one.")
    if worker:
        expected = " ".join(worker.get("expected_program") or []) or "-"
        typer.echo(f"         Fix: `cashu worker install` (it will run {expected}).")
    if mcp:
        typer.echo(f"  STALE: cashU.app was moved from {mcp['app_moved_from']}.")
        typer.echo("         MCP servers you added before may still point there: re-add them with")
        typer.echo("         the lines from Settings > Agent AI, then mark it done there.")
