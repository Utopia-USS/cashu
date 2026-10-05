"""Worker glue for the investments module: the one place in the worker that knows investments.

It only uses the module's public pieces: ``service.daily.run_daily_check`` (the daily check),
``service.strategy.load`` (the notification policy from strategy.yaml) and the module's tables
for the notification log (``inv_notification_log``, written by the daily check with ``sent_at``
NULL) and the signals. Imports are lazy: core never imports a module at import time.

Later this can move behind a ``ModuleSpec`` worker-jobs hook without changing the runner.
"""

from __future__ import annotations

import datetime as dt
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from sqlmodel import Session, select

MODULE_ID = "investments"
DAILY_LOCK_WAIT = 120.0  # seconds to wait for an in-app "run now" to finish
OPEN_STATUSES = ("active", "acknowledged")
# Only an active signal is notified: acknowledged / decided / resolved / expired ones are closed out at
# delivery, snoozed ones wait (F5 R5).
DELIVERABLE_STATUS = "active"
ISO_WEEKDAYS = {
    "monday": 1,
    "tuesday": 2,
    "wednesday": 3,
    "thursday": 4,
    "friday": 5,
    "saturday": 6,
    "sunday": 7,
}


@dataclass(frozen=True)
class Policy:
    """A profile's notification policy (strategy ``notifications``; defaults without a strategy)."""

    immediate: frozenset[str]  # severities notified immediately ("action", "info")
    digest_weekday: int  # ISO weekday, Monday = 1 ... Sunday = 7


DEFAULT_POLICY = Policy(frozenset({"action"}), 7)


@dataclass(frozen=True)
class PendingNotification:
    log_id: int
    signal_id: int
    severity: str  # severity the log entry was written for
    signal_status: str
    signal_severity: str  # the signal's current severity
    rule_id: str
    message: str
    created_at: dt.datetime | None
    decided: bool = False
    """The owner recorded a decision on the signal after this entry was written."""
    snoozed_until: dt.datetime | None = None
    """Aware UTC; the signal is postponed until then (``inv_signals.snoozed_until``, once it exists)."""

    def snoozed(self, now: dt.datetime) -> bool:
        if self.signal_status == "snoozed":
            return True
        return self.snoozed_until is not None and self.snoozed_until > now


def _utc(value: dt.datetime | None) -> dt.datetime | None:
    if value is None:
        return None
    return value.replace(tzinfo=dt.UTC) if value.tzinfo is None else value


def policy(session: Session, profile) -> Policy:
    """The profile's policy, read from its strategy files (missing / invalid -> defaults)."""
    from finanse.modules.investments.service import strategy as strategy_files

    try:
        config = strategy_files.load(session, profile, record=False).config
    except Exception:  # noqa: BLE001 - a broken strategy file must not stop notifications
        config = None
    if config is None:
        return DEFAULT_POLICY
    notifications = config.notifications
    return Policy(
        immediate=frozenset(str(s) for s in notifications.immediate),
        digest_weekday=ISO_WEEKDAYS.get(str(notifications.digest_weekday), 7),
    )


def run_daily_check(
    *,
    offline: bool = False,
    as_of: dt.date | None = None,
    sources: Any = None,
    lock_wait: float = DAILY_LOCK_WAIT,
):
    """The daily check for every profile with investments enabled (trigger ``worker``).
    Raises ``daily.RunBusy`` when another run keeps the lock longer than ``lock_wait``."""
    from finanse.modules.investments.service import daily

    return daily.run_daily_check(
        "worker", offline=offline, as_of=as_of, sources=sources, lock_wait=lock_wait
    )


def busy_error() -> type[Exception]:
    from finanse.modules.investments.service import daily

    return daily.RunBusy


def pending(session: Session, profile_id: int) -> list[PendingNotification]:
    """Notification-log entries of the profile not delivered yet, oldest first, with what the
    owner did since: the signal's current status, a newer decision, a snooze."""
    from sqlalchemy import func

    from finanse.modules.investments.models import InvDecision, InvNotification, InvSignal

    rows = session.exec(
        select(InvNotification, InvSignal)
        .join(InvSignal, InvSignal.id == InvNotification.signal_id)
        .where(InvNotification.profile_id == profile_id, InvNotification.sent_at.is_(None))
        .order_by(InvNotification.created_at, InvNotification.id)
    ).all()
    signal_ids = {sig.id for _log, sig in rows}
    last_decision = (
        dict(
            session.exec(
                select(InvDecision.signal_id, func.max(InvDecision.created_at))
                .where(InvDecision.signal_id.in_(signal_ids))
                .group_by(InvDecision.signal_id)
            ).all()
        )
        if signal_ids
        else {}
    )

    def decided(log, sig) -> bool:
        at, created = _utc(last_decision.get(sig.id)), _utc(log.created_at)
        return at is not None and (created is None or at >= created)

    return [
        PendingNotification(
            log_id=log.id,
            signal_id=sig.id,
            severity=log.severity,
            signal_status=sig.status,
            signal_severity=sig.severity,
            rule_id=sig.rule_id,
            message=sig.message,
            created_at=log.created_at,
            decided=decided(log, sig),
            snoozed_until=_utc(getattr(sig, "snoozed_until", None)),
        )
        for log, sig in rows
    ]


def claim(session_factory: Callable, log_id: int, channel: str, now: dt.datetime) -> bool:
    """Mark the entry sent before delivering it (its own committed transaction). Only one process
    wins the claim (``UPDATE ... WHERE sent_at IS NULL``), so an entry is delivered at most once."""
    from sqlalchemy import update

    from finanse.modules.investments.models import InvNotification

    with session_factory() as s:
        result = s.exec(
            update(InvNotification)
            .where(InvNotification.id == log_id, InvNotification.sent_at.is_(None))
            .values(sent_at=now, channel=channel)
        )
        return result.rowcount == 1


def release(session_factory: Callable, log_id: int) -> None:
    """Undo a claim after a failed delivery (the next run tries again)."""
    from sqlalchemy import update

    from finanse.modules.investments.models import InvNotification

    with session_factory() as s:
        s.exec(
            update(InvNotification)
            .where(InvNotification.id == log_id)
            .values(sent_at=None, channel=None)
        )


def review_count(session: Session, profile_id: int) -> int:
    """Signals waiting for a decision (status ``active``, not snoozed): the weekly digest's number."""
    from sqlalchemy import func, or_

    from finanse.modules.investments.models import InvSignal

    query = select(func.count(InvSignal.id)).where(
        InvSignal.profile_id == profile_id, InvSignal.status == "active"
    )
    snoozed_until = getattr(InvSignal, "snoozed_until", None)  # F5 R7 (AL), once the column exists
    if snoozed_until is not None:
        now = dt.datetime.now(dt.UTC)
        query = query.where(or_(snoozed_until.is_(None), snoozed_until <= now))
    return int(session.exec(query).one())


def prune_staged() -> dict | None:
    """Remove abandoned import uploads and unreferenced proposal exports (F5 R9); never raises."""
    from finanse.modules.investments.service import staging

    report = staging.prune_quietly()
    return None if report is None else report.stats()


def backfill_prices(*, as_of: dt.date | None = None, sources: Any = None) -> dict | None:
    """Incremental price backfill for performance after the daily check (F6): sold instruments and
    the strategy's benchmark proxy, which the daily refresh does not cover; only the days after the
    newest stored bar are fetched. Never raises: returns ``{instruments, errors, rates_written}`` or
    ``{error}``; None when another backfill (``finanse invest backfill``) holds its lock."""
    from finanse.modules.investments.performance import backfill

    try:
        report = backfill.run_backfill(as_of=as_of, sources=sources)
    except backfill.BackfillBusy:
        return None
    except Exception as e:  # noqa: BLE001 - housekeeping: logged by the runner, never fatal
        return {"error": f"{type(e).__name__}: {e}"[:300]}
    return {
        "instruments": len(report.instruments),
        "errors": sum(1 for i in report.instruments if i.status == "error")
        + sum(1 for b in report.benchmarks if b.status == "error"),
        "rates_written": report.rates_written,
    }


def last_worker_run(session: Session) -> tuple[dt.datetime, str] | None:
    """(started_at, status) of the newest daily-check run the worker triggered, any profile."""
    from finanse.modules.investments.models import InvRuleRun

    row = session.exec(
        select(InvRuleRun)
        .where(InvRuleRun.trigger == "worker")
        .order_by(InvRuleRun.started_at.desc(), InvRuleRun.id.desc())
    ).first()
    if row is None:
        return None
    started = row.started_at if row.started_at.tzinfo else row.started_at.replace(tzinfo=dt.UTC)
    return started, row.status
