"""Worker glue for the budget module: the daily Open Banking sync, polite to the banks.

A profile is synced only when Enable Banking is configured and the profile has saved sessions
(``finanse eb login``), at most once per ``MIN_INTERVAL``, and never again before
``RATE_LIMIT_BACKOFF`` has passed after a rate limit (HTTP 429). One attempt per run, no retries:
the banks throttle (see AGENTS.md, "never run eb resync in a loop"). The attempt is recorded in
the worker state before any network call, so a crash cannot turn into a retry loop.

The sync itself is the budget module's own resync (the dashboard's "Synchronizuj"): every saved
session fetched with no database transaction open, then transfers re-matched and transactions
re-categorized.
"""

from __future__ import annotations

import datetime as dt
import importlib
import math
from dataclasses import dataclass, field
from typing import Any

MODULE_ID = "budget"
MIN_INTERVAL = dt.timedelta(hours=20)
RATE_LIMIT_BACKOFF = dt.timedelta(hours=48)
MIN_DAYS, MAX_DAYS, MARGIN_DAYS = 10, 90, 3


@dataclass
class SyncOutcome:
    status: str  # ok | partial | failed | skipped
    detail: str | None = None
    stats: dict[str, Any] = field(default_factory=dict)


def _parse(value: Any) -> dt.datetime | None:
    if not isinstance(value, str):
        return None
    try:
        parsed = dt.datetime.fromisoformat(value)
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=dt.UTC)


def configured() -> bool:
    from finanse.config import settings

    return bool(settings.eb_configured)


def saved_sessions(profile, legacy_owner: str | None) -> list:
    from finanse.modules.budget.ingestion.enable_banking import state

    return state.load_sessions(profile.slug, legacy_profile=legacy_owner)


def blocked_until(book: dict, now: dt.datetime) -> dt.datetime | None:
    """When the next sync is allowed, or None when it is allowed now."""
    candidates = []
    throttled = _parse(book.get("throttled_until"))
    if throttled is not None and throttled > now:
        candidates.append(throttled)
    attempt = _parse(book.get("last_attempt"))
    if attempt is not None and attempt + MIN_INTERVAL > now:
        candidates.append(attempt + MIN_INTERVAL)
    return max(candidates) if candidates else None


def days_to_fetch(book: dict, now: dt.datetime) -> int:
    """History window: since the last successful worker sync plus a margin (late bookings),
    at least ``MIN_DAYS``, at most ``MAX_DAYS`` (also the first time)."""
    success = _parse(book.get("last_success"))
    if success is None:
        return MAX_DAYS
    gap = math.ceil((now - success).total_seconds() / 86400)
    return max(MIN_DAYS, min(MAX_DAYS, gap + MARGIN_DAYS))


def _rate_limited(errors: list[str]) -> bool:
    return any("429" in e or "rate limit" in e.lower() for e in errors)


def precheck(profile, book: dict, now: dt.datetime, legacy_owner: str | None) -> SyncOutcome | None:
    """A ``skipped`` outcome when the profile must not be synced now, else None."""
    if not configured():
        return SyncOutcome("skipped", "Enable Banking not configured")
    if not saved_sessions(profile, legacy_owner):
        return SyncOutcome("skipped", "no saved bank sessions")
    until = blocked_until(book, now)
    if until is not None:
        return SyncOutcome("skipped", f"throttled until {until.isoformat(timespec='minutes')}")
    return None


def sync(profile, book: dict, now: dt.datetime) -> SyncOutcome:
    """Run one sync for the profile (``book`` already holds this attempt) and record the result
    in ``book``."""
    days = days_to_fetch(book, now)
    budget_api = importlib.import_module("finanse.modules.budget.api")
    try:
        result = budget_api.resync(profile, days=days)
    except Exception as e:  # noqa: BLE001 - recorded, the worker goes on
        book["last_status"], book["last_error"] = "failed", f"{type(e).__name__}: {e}"[:300]
        return SyncOutcome("failed", book["last_error"], {"days": days})
    if not result.get("ok"):
        book["last_status"], book["last_error"] = "failed", str(result.get("error"))[:300]
        return SyncOutcome("failed", book["last_error"], {"days": days})
    errors = [str(e) for e in result.get("errors") or []]
    stats = {
        "days": days,
        "inserted": result.get("inserted", 0),
        "banks": len(result.get("banks") or []),
        "errors": len(errors),
    }
    if _rate_limited(errors):
        book["throttled_until"] = (now + RATE_LIMIT_BACKOFF).isoformat()
    if errors:
        # last_success stays: the next window still covers what a failing bank missed.
        book["last_status"], book["last_error"] = "partial", errors[0][:300]
        return SyncOutcome("partial", errors[0][:300], stats)
    book["last_status"], book["last_error"] = "ok", None
    book["last_success"] = now.isoformat()
    return SyncOutcome("ok", None, stats)
