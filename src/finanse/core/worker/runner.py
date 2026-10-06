"""One worker run: every profile x its enabled modules, then notifications and the digest.

Order: the fetch connectors per profile (``connectors.fetch``: due bindings only, F10; first, so
what they commit is in today's check), the investments daily check (one call for all investments
profiles, shares the ``investments-daily`` lock with the in-app "run now") followed by the incremental
performance price backfill (online runs only, no job row), the budget sync per profile (only when
configured and not throttled), immediate notifications, the weekly digest. A failing job is
recorded and never stops the others. The whole run holds the ``worker`` lock, so two worker
runs never overlap; the summary lands in the worker state (``last_run``).
"""

from __future__ import annotations

import datetime as dt
import logging
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .. import locks, profiles
from ..db import get_session
from . import budget as budget_glue
from . import connectors as connectors_glue
from . import investments as inv
from . import notifications
from . import state as worker_state
from .notifier import Notifier
from .schedule import local_now

WORKER_LOCK = "worker"
_log = logging.getLogger("finanse.worker")

# Job ids (also the keys of the per-job summary).
INVESTMENTS_DAILY = "investments.daily"
BUDGET_SYNC = "budget.sync"
CONNECTORS_FETCH = connectors_glue.JOB
NOTIFICATIONS = "notifications"
DIGEST = "digest"
JOB_MODULES = {
    INVESTMENTS_DAILY: "investments",
    BUDGET_SYNC: "budget",
    CONNECTORS_FETCH: "core",
    NOTIFICATIONS: "investments",
    DIGEST: "investments",
}
_RANK = {"skipped": 0, "ok": 1, "partial": 2, "failed": 3}


class WorkerBusy(RuntimeError):
    """Another worker run holds the lock."""


@dataclass
class JobResult:
    job: str
    status: str  # ok | partial | failed | skipped
    profile: str | None = None
    detail: str | None = None
    stats: dict[str, Any] = field(default_factory=dict)
    code: str | None = None
    """Stable code of a known ``detail`` (the UI labels ``worker.<code>`` with ``params``); the
    English ``detail`` stays the CLI / log form and the fallback for free-text errors (F7)."""
    params: dict[str, Any] = field(default_factory=dict)

    @property
    def module(self) -> str:
        return JOB_MODULES.get(self.job, "core")

    def to_dict(self) -> dict:
        return {
            "job": self.job,
            "module": self.module,
            "profile": self.profile,
            "status": self.status,
            "detail": self.detail,
            "code": self.code,
            "params": self.params,
            "stats": self.stats,
        }


@dataclass
class WorkerReport:
    started_at: dt.datetime
    offline: bool
    notifier: str | None
    finished_at: dt.datetime | None = None
    jobs: list[JobResult] = field(default_factory=list)

    @property
    def status(self) -> str:
        ran = [j.status for j in self.jobs if j.status != "skipped"]
        if not ran or all(s == "ok" for s in ran):
            return "ok"
        if all(s == "failed" for s in ran):
            return "failed"
        return "partial"

    def job_summary(self) -> list[dict]:
        """One line per job id: the worst status across profiles and the first problem."""
        out: dict[str, dict] = {}
        for j in self.jobs:
            entry = out.setdefault(
                j.job,
                {
                    "job": j.job,
                    "module": j.module,
                    "status": j.status,
                    "detail": None,
                    "code": None,
                    "params": {},
                    "profile": None,
                },
            )
            if _RANK[j.status] > _RANK[entry["status"]]:
                entry["status"] = j.status
            if entry["detail"] is None and j.detail and j.status != "ok":
                entry["detail"] = f"{j.profile}: {j.detail}" if j.profile else j.detail
                entry["code"], entry["params"], entry["profile"] = j.code, j.params, j.profile
        return list(out.values())

    def to_dict(self) -> dict:
        return {
            "status": self.status,
            "started_at": self.started_at.isoformat(),
            "finished_at": self.finished_at.isoformat() if self.finished_at else None,
            "offline": self.offline,
            "notifier": self.notifier,
            "jobs": [j.to_dict() for j in self.jobs],
            "summary": self.job_summary(),
        }

    def state_summary(self) -> dict:
        return {
            "status": self.status,
            "started_at": self.started_at.isoformat(),
            "finished_at": self.finished_at.isoformat() if self.finished_at else None,
            "jobs": self.job_summary(),
        }


def run_worker(
    *,
    notifier: Notifier | None,
    offline: bool = False,
    budget: bool = True,
    now: dt.datetime | None = None,
    as_of: dt.date | None = None,
    investments_sources: Any = None,
    daily_lock_wait: float = inv.DAILY_LOCK_WAIT,
    session_factory: Callable = get_session,
    state_path: Path | None = None,
) -> WorkerReport:
    """Run every job once. ``notifier`` None = deliver nothing (entries stay pending);
    ``as_of`` = the daily check's date (default today), ``now`` = the clock (digest weekday).
    Raises :class:`WorkerBusy` when another worker run is in progress."""
    try:
        with locks.run_lock(WORKER_LOCK):
            return _run(
                notifier,
                offline,
                budget,
                now,
                as_of,
                investments_sources,
                daily_lock_wait,
                session_factory,
                state_path,
            )
    except locks.LockBusy as e:
        raise WorkerBusy(str(e)) from None


def _run(notifier, offline, budget, now, as_of, sources, lock_wait, session_factory, state_path):
    now = now or local_now()
    if now.tzinfo is None:
        now = now.astimezone()  # naive = local wall-clock time
    report = WorkerReport(now, offline, notifier.name if notifier else None)
    state = worker_state.load(state_path)

    def save(st: worker_state.WorkerState) -> None:
        worker_state.save(st, state_path)

    with session_factory() as s:
        everyone = profiles.list_profiles(s)
        enabled = {p.id: set(profiles.enabled_modules(s, p.id)) for p in everyone}
        legacy_owner = profiles.legacy_owner_slug(s)
    investors = [p for p in everyone if inv.MODULE_ID in enabled[p.id]]
    budgeters = [p for p in everyone if budget_glue.MODULE_ID in enabled[p.id]]

    # Fetch connectors first: what an investments binding commits is in today's daily check
    # (positions, rules, notifications), like the in-app "run now" (sync, then the check).
    for profile in everyone:
        job = _connectors(profile, enabled[profile.id], offline, notifier, now)
        if job is not None:
            report.jobs.append(job)
    if investors:
        report.jobs += _investments(offline, as_of, sources, lock_wait)
        if not offline:  # performance history of sold instruments + benchmark (housekeeping, F6)
            backfilled = inv.backfill_prices(as_of=as_of, sources=sources)
            if backfilled and (backfilled.get("error") or backfilled.get("errors")):
                _log.warning("price backfill: %s", backfilled)
    if budgeters:
        for profile in budgeters:
            report.jobs.append(_budget(profile, budget, now, state, save, legacy_owner))
    if investors:
        for profile in investors:
            report.jobs.append(_notify(profile, notifier, now, session_factory))
        for profile in investors:
            job = _digest(profile, notifier, now.date(), state, save, session_factory)
            if job is not None:
                report.jobs.append(job)

    pruned = inv.prune_staged()  # housekeeping, not a job row (F5 R9)
    if pruned and (pruned["removed"] or pruned["errors"]):
        _log.info("pruned staged import files: %s", pruned)

    report.finished_at = max(now, local_now())
    state.last_run = report.state_summary()
    save(state)
    return report


def _investments(offline: bool, as_of, sources: Any, lock_wait: float) -> list[JobResult]:
    try:
        daily_report = inv.run_daily_check(
            offline=offline, as_of=as_of, sources=sources, lock_wait=lock_wait
        )
    except inv.busy_error() as e:
        return [JobResult(INVESTMENTS_DAILY, "skipped", detail=f"busy: {e}", code="busy")]
    except Exception as e:  # noqa: BLE001 - recorded, the other jobs still run
        _log.exception("investments daily check failed")
        return [JobResult(INVESTMENTS_DAILY, "failed", detail=f"{type(e).__name__}: {e}")]
    jobs = []
    for run in daily_report.profiles:
        first = run.errors[0] if run.errors else None
        code, params = inv.error_code(first)
        jobs.append(
            JobResult(
                INVESTMENTS_DAILY,
                run.status,
                profile=run.slug,
                detail=first,
                code=code,
                params=params,
                stats={
                    "run_id": run.run_id,
                    "strategy": run.strategy,
                    "new_signals": len(run.new_signals),
                    "escalated_signals": len(run.escalated_signals),
                    "notifications": run.stats.get("notifications", 0),
                },
            )
        )
    if daily_report.market_error and not jobs:
        jobs.append(
            JobResult(
                INVESTMENTS_DAILY, "failed", detail=daily_report.market_error, code="market_failed"
            )
        )
    return jobs


def _budget(profile, enabled: bool, now, state, save, legacy_owner) -> JobResult:
    if not enabled:
        return JobResult(
            BUDGET_SYNC, "skipped", profile.slug, "disabled for this run", code="disabled_for_run"
        )
    book = state.budget.setdefault(str(profile.id), {})
    try:
        skip = budget_glue.precheck(profile, book, now, legacy_owner)
        if skip is not None:
            return JobResult(
                BUDGET_SYNC,
                skip.status,
                profile.slug,
                skip.detail,
                code=skip.code,
                params=skip.params,
            )
        book["last_attempt"] = now.isoformat()
        save(state)  # recorded before any network call: a crash never becomes a retry loop
        outcome = budget_glue.sync(profile, book, now)
    except Exception as e:  # noqa: BLE001
        _log.exception("budget sync failed for %s", profile.slug)
        book["last_status"], book["last_error"] = "failed", f"{type(e).__name__}: {e}"[:300]
        outcome = budget_glue.SyncOutcome("failed", book["last_error"])
    save(state)
    return JobResult(BUDGET_SYNC, outcome.status, profile.slug, outcome.detail, outcome.stats)


def _connectors(profile, modules: set[str], offline: bool, notifier, now) -> JobResult | None:
    try:
        outcome = connectors_glue.run(profile, modules, now=now, notifier=notifier, offline=offline)
    except Exception as e:  # noqa: BLE001 - recorded, the other jobs still run
        _log.exception("connector fetch failed for %s", profile.slug)
        return JobResult(CONNECTORS_FETCH, "failed", profile.slug, f"{type(e).__name__}")
    if outcome is None:
        return None
    return JobResult(
        CONNECTORS_FETCH, outcome.status, profile.slug, outcome.detail, outcome.stats,
        code=outcome.code, params=outcome.params,
    )


def _notify(profile, notifier, now, session_factory) -> JobResult:
    if notifier is None:
        return JobResult(
            NOTIFICATIONS, "skipped", profile.slug, "notifier: none", code="notifier_none"
        )
    try:
        result = notifications.deliver_pending(
            profile, notifier, now=now, session_factory=session_factory
        )
    except Exception as e:  # noqa: BLE001
        _log.exception("notifications failed for %s", profile.slug)
        return JobResult(NOTIFICATIONS, "failed", profile.slug, f"{type(e).__name__}: {e}")
    return JobResult(
        NOTIFICATIONS,
        result.status,
        profile.slug,
        result.errors[0] if result.errors else None,
        result.stats(),
    )


def _digest(profile, notifier, today, state, save, session_factory) -> JobResult | None:
    if notifier is None:
        return None
    try:
        result = notifications.send_digest(
            profile,
            notifier,
            today=today,
            state=state,
            save_state=save,
            session_factory=session_factory,
        )
    except Exception as e:  # noqa: BLE001
        _log.exception("digest failed for %s", profile.slug)
        return JobResult(DIGEST, "failed", profile.slug, f"{type(e).__name__}: {e}")
    if result.status == "not_due":
        return None
    status = {"sent": "ok", "already_sent": "skipped", "failed": "failed"}[result.status]
    detail = {"already_sent": "already sent today", "failed": result.error}.get(result.status)
    code = "digest_already_sent" if result.status == "already_sent" else None
    return JobResult(DIGEST, status, profile.slug, detail, {"signals": result.count}, code=code)
