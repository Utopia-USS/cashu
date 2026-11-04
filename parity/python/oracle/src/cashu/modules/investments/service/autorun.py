"""The automatic daily check of the open app (P10; replaces the "Synchronizuj" button): when the app
server starts, every investments profile without a successful run today (local date) gets the full
daily check (due connector syncs, prices, macro, rules, signals, alerts), followed by the incremental
performance backfill; while the app stays open a check every hour runs it after 07:30 local time when
it has not run today. Never blocks startup or requests (a daemon thread), shares the daily lock
(``busy`` = skipped quietly, the next hour tries again), logs the outcome and never raises; the window
learns about the run from its ``run`` change events. ``CASHU_AUTO_DAILY=0`` turns it off (the test suite
and the offline e2e server do).
"""

from __future__ import annotations

import datetime as dt
import logging
import threading
from collections.abc import Callable
from dataclasses import dataclass, field

from sqlmodel import Session, select

from cashu.core import profiles
from cashu.core.db import get_session
from cashu.core.env import env
from cashu.core.models import ProfileModule

from ..models import InvRuleRun
from . import daily

DAILY_AFTER = dt.time(7, 30)
CHECK_EVERY = 3600.0  # seconds
LOCK_WAIT = 60.0  # a price refresh holds the daily lock for a few seconds
TRIGGER = "app"
_log = logging.getLogger("cashu.investments.autorun")


def enabled() -> bool:
    return (env("AUTO_DAILY") or "1").strip().lower() not in ("0", "false", "off", "no")


def local_day(moment: dt.datetime) -> dt.date:
    aware = moment if moment.tzinfo else moment.replace(tzinfo=dt.UTC)
    return aware.astimezone().date()


def due(last_ok: dt.date | None, now_local: dt.datetime, *, at_start: bool) -> bool:
    """A profile's run is due: none succeeded today; at start at once, later only after 07:30."""
    if last_ok is not None and last_ok >= now_local.date():
        return False
    return at_start or now_local.time() >= DAILY_AFTER


def last_ok_days(session: Session) -> dict[int, dt.date | None]:
    """Local date of the newest non-failed daily run per investments profile (None: never)."""
    enabled_ids = set(
        session.exec(
            select(ProfileModule.profile_id).where(
                ProfileModule.module_id == daily.MODULE_ID, ProfileModule.enabled == True
            )
        ).all()
    )
    out: dict[int, dt.date | None] = {}
    for p in profiles.list_profiles(session):
        if p.id not in enabled_ids:
            continue
        newest = session.exec(
            select(InvRuleRun.started_at)
            .where(InvRuleRun.profile_id == p.id, InvRuleRun.status.in_(("ok", "partial")))
            .order_by(InvRuleRun.started_at.desc())
        ).first()
        out[p.id] = None if newest is None else local_day(newest)
    return out


@dataclass
class Outcome:
    status: str  # ran | not_due | busy | failed | disabled
    profiles: list[int] = field(default_factory=list)
    detail: str | None = None


def _default_run(profile_ids: list[int]):
    """Due connector syncs per profile (as the old button did), then the daily check."""
    from cashu.core.connectors import sync
    from cashu.core.models import Profile

    with get_session() as s:
        rows = [s.get(Profile, pid) for pid in profile_ids]
    for profile in rows:
        if profile is None:
            continue
        try:
            sync.run_due(profile, daily.MODULE_ID)
        except Exception:  # noqa: BLE001 - a connector never stops the check
            _log.warning("connector sync failed for %s", profile.slug, exc_info=True)
    return daily.run_daily_check(TRIGGER, profile_ids=profile_ids, lock_wait=LOCK_WAIT)


def _default_backfill() -> None:
    from ..performance import backfill

    try:
        backfill.run_backfill()
    except backfill.BackfillBusy:
        pass


def run_if_due(
    *,
    at_start: bool,
    now: Callable[[], dt.datetime] = lambda: dt.datetime.now().astimezone(),
    run: Callable[[list[int]], object] = _default_run,
    backfill: Callable[[], None] = _default_backfill,
    session_factory=get_session,
) -> Outcome:
    """One check: run the daily check for the due profiles. Never raises."""
    if not enabled():
        return Outcome("disabled")
    try:
        moment = now()
        with session_factory() as s:
            days = last_ok_days(s)
        wanted = [pid for pid, day in days.items() if due(day, moment, at_start=at_start)]
        if not wanted:
            return Outcome("not_due")
        try:
            report = run(wanted)
        except daily.RunBusy as e:
            _log.info("automatic daily check skipped: %s", e)
            return Outcome("busy", wanted, str(e))
        statuses = [p.status for p in getattr(report, "profiles", [])]
        _log.info("automatic daily check: %s %s", statuses, getattr(report, "timings", {}))
        try:
            backfill()
        except Exception:  # noqa: BLE001 - housekeeping
            _log.warning("price backfill after the automatic check failed", exc_info=True)
        return Outcome("ran", wanted)
    except Exception as e:  # noqa: BLE001 - offline, a broken profile: logged, the app goes on
        _log.warning("automatic daily check failed: %s", e, exc_info=True)
        return Outcome("failed", detail=f"{type(e).__name__}: {e}"[:300])


def _prune_events() -> None:
    from cashu.core import events

    try:
        with get_session() as s:
            events.prune(s)
    except Exception:  # noqa: BLE001
        _log.debug("change event prune failed", exc_info=True)


class AutoRunner:
    """The app's background thread: a check at start, then every hour (plus the change-event prune)."""

    def __init__(self, every: float = CHECK_EVERY, check=run_if_due) -> None:
        self.every = every
        self._check = check
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def start(self) -> bool:
        if not enabled() or self._thread is not None:
            return False
        self._thread = threading.Thread(target=self._loop, name="cashu-autorun", daemon=True)
        self._thread.start()
        return True

    def _loop(self) -> None:
        at_start = True
        while not self._stop.is_set():
            _prune_events()
            self._check(at_start=at_start)
            at_start = False
            self._stop.wait(self.every)

    def stop(self, timeout: float = 2.0) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout)


def running(session: Session, profile_id: int, *, now: dt.datetime | None = None) -> dict:
    """``{running, started_at}`` from the profile's newest ``run`` change event (any process: the
    app, the worker, the CLI): an ``add`` without its ``update``, younger than 30 minutes."""
    from cashu.core.models import ChangeEvent, utcnow

    row = session.exec(
        select(ChangeEvent)
        .where(ChangeEvent.entity == "run", ChangeEvent.profile_id == profile_id)
        .order_by(ChangeEvent.id.desc())
    ).first()
    now = now or utcnow()
    if row is None or row.op != "add":
        return {"running": False, "started_at": None}
    ts = row.ts if row.ts.tzinfo else row.ts.replace(tzinfo=dt.UTC)
    fresh = now - ts < dt.timedelta(minutes=30)
    return {"running": fresh, "started_at": ts.isoformat() if fresh else None}
