"""Weekly review records: "I looked at module X this week" (from the app or over MCP).

``mark_done`` stores a record (optional notes and stats, e.g. open signal counts at that moment),
``last`` gives the newest one of a module (the investments review digest starts from it), ``list_reviews``
the history, ``undo`` deletes a record within ``UNDO_WINDOW`` of saving it (the app's "Cofnij"). Every function takes the session first and a ``Profile`` or a profile id; records never
leave their profile.
"""

from __future__ import annotations

import datetime as dt
from typing import Any

from sqlmodel import Session, select

from . import modules
from .agent_models import Review
from .models import Profile, utcnow

MAX_NOTES = 4000
UNDO_WINDOW = dt.timedelta(minutes=15)


class ReviewError(ValueError):
    """Invalid review input (message safe to show)."""


class ReviewNotFound(LookupError):
    pass


class ReviewUndoExpired(ReviewError):
    """The review was saved more than ``UNDO_WINDOW`` ago."""


def _pid(profile: Profile | int) -> int:
    pid = profile.id if isinstance(profile, Profile) else profile
    if pid is None:
        raise ReviewError("profile has no id")
    return int(pid)


def _module(module: str) -> str:
    module = (module or "").strip()
    if module not in modules.registry():
        known = ", ".join(modules.registry())
        raise ReviewError(f"unknown module {module!r}; known: {known}")
    return module


def mark_done(
    session: Session,
    profile: Profile | int,
    module: str,
    notes: str | None = None,
    stats: dict[str, Any] | None = None,
) -> Review:
    """Record a review of ``module`` done now."""
    text = (notes or "").strip() or None
    if text is not None and len(text) > MAX_NOTES:
        raise ReviewError(f"notes are too long (max {MAX_NOTES} characters)")
    row = Review(
        profile_id=_pid(profile),
        module=_module(module),
        done_at=utcnow(),
        notes=text,
        stats=dict(stats or {}),
    )
    session.add(row)
    session.flush()
    return row


def last(session: Session, profile: Profile | int, module: str) -> Review | None:
    """The newest review of ``module`` for the profile (None: never reviewed)."""
    return session.exec(
        select(Review)
        .where(Review.profile_id == _pid(profile), Review.module == module)
        .order_by(Review.done_at.desc(), Review.id.desc())
    ).first()


def list_reviews(
    session: Session, profile: Profile | int, module: str | None = None, limit: int = 50
) -> list[Review]:
    """The profile's reviews, newest first (optionally of one module)."""
    query = select(Review).where(Review.profile_id == _pid(profile))
    if module:
        query = query.where(Review.module == module)
    limit = max(1, min(int(limit), 500))
    return list(
        session.exec(query.order_by(Review.done_at.desc(), Review.id.desc()).limit(limit)).all()
    )


def get(session: Session, profile: Profile | int, review_id: int) -> Review:
    row = session.get(Review, review_id)
    if row is None or row.profile_id != _pid(profile):
        raise ReviewNotFound(f"No review {review_id} in this profile")
    return row


def undo(
    session: Session, profile: Profile | int, review_id: int, *, now: dt.datetime | None = None
) -> None:
    """Delete a review saved less than ``UNDO_WINDOW`` ago (``ReviewUndoExpired`` after that)."""
    row = get(session, profile, review_id)
    done = row.done_at.replace(tzinfo=dt.UTC) if row.done_at.tzinfo is None else row.done_at
    if (now or utcnow()) - done > UNDO_WINDOW:
        minutes = int(UNDO_WINDOW.total_seconds() // 60)
        raise ReviewUndoExpired(f"A review can be undone for {minutes} minutes after it is saved")
    session.delete(row)
    session.flush()


def review_dict(row: Review) -> dict:
    done = row.done_at
    if done is not None and done.tzinfo is None:  # SQLite returns naive UTC
        from datetime import UTC

        done = done.replace(tzinfo=UTC)
    return {
        "id": row.id,
        "module": row.module,
        "done_at": done.isoformat() if done is not None else None,
        "notes": row.notes,
        "stats": dict(row.stats or {}),
    }
