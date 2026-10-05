"""Pure research scoring: ISO weeks, the weekly sentiment score, the trend direction and the thesis
health of a position (rules: ``design/v2/research/research.md`` sections 4 and 5). No IO, no clock:
every function takes the instant it scores at, so the review digest can score "as of the last
review" with the same code.

Sentiment of one ISO week = ``sum(polarity_sign * weight) / (3 * notes)`` over the notes observed in
that week that were stored and not dismissed at the scoring instant (expired notes still count: the
8-week trend is history, while the 30-day health window is not). ``weight`` = the note's strength
(1-3), capped at 1 for community notes (noise). Candidate notes are strategy matches, not market
sentiment, and never count. A week without notes is ``None`` ("no data", not "balanced").

Direction = the sum of the last 4 weekly scores vs the previous 4 (empty weeks count 0): more than
``DIRECTION_DELTA`` lower = ``falling``, higher = ``rising``, else ``stable``.

Thesis health of a position (30-day window of stored, non-dismissed, non-expired notes; a thesis edit
resets it: only notes stored after the thesis' last change count): ``invalidated`` (any note that
invalidates), ``weakened`` (any weakens), ``supported`` (supports, none of the two), ``current``
(thesis, only neutral / unrelated notes), ``no_research`` (thesis, nothing researched in 30 days),
``no_thesis`` (no thesis record).
"""

from __future__ import annotations

import datetime as dt
import re
import unicodedata
from collections.abc import Iterable, Sequence
from dataclasses import dataclass, field
from enum import StrEnum

SENTIMENT_WEEKS = 8
DIRECTION_DELTA = 1.0
HEALTH_WINDOW_DAYS = 30
COMMUNITY_KIND = "community"
CANDIDATE_KIND = "candidate"

POLARITY_SIGN = {"positive": 1, "negative": -1, "neutral": 0}
RELATIONS = ("supports", "weakens", "invalidates", "neutral", "none")
RELATION_RANK = {"invalidates": 4, "weakens": 3, "supports": 2, "neutral": 1, "none": 0}
"""How much a relation says about the thesis (the strongest one wins in summaries)."""


class Health(StrEnum):
    INVALIDATED = "invalidated"  # podważona
    WEAKENED = "weakened"  # osłabiona
    SUPPORTED = "supported"  # wzmocniona
    CURRENT = "current"  # aktualna
    NO_RESEARCH = "no_research"  # bez researchu
    NO_THESIS = "no_thesis"  # bez tezy


HEALTH_ORDER = (
    Health.INVALIDATED,
    Health.WEAKENED,
    Health.NO_RESEARCH,
    Health.NO_THESIS,
    Health.SUPPORTED,
    Health.CURRENT,
)
"""Attention order of the health states (most attention first): the order of summary rows."""


class Direction(StrEnum):
    RISING = "rising"  # rośnie
    FALLING = "falling"  # słabnie
    STABLE = "stable"  # stabilnie


@dataclass(frozen=True, slots=True)
class ScoredNote:
    """What scoring needs from a stored note (aware UTC datetimes)."""

    id: int
    kind: str
    polarity: str
    strength: int
    thesis_relation: str
    observed_at: dt.datetime
    created_at: dt.datetime
    expires_at: dt.datetime
    dismissed_at: dt.datetime | None = None
    thesis_field: str | None = None

    def stored_at(self, at: dt.datetime) -> bool:
        """Stored and not dismissed at ``at``."""
        return self.created_at <= at and (self.dismissed_at is None or self.dismissed_at > at)

    def active_at(self, at: dt.datetime) -> bool:
        """Stored, not dismissed and not expired at ``at``."""
        return self.stored_at(at) and self.expires_at > at


# --------------------------------------------------------------------------- #
# Weeks
# --------------------------------------------------------------------------- #


def week_start(day: dt.date) -> dt.date:
    """Monday of ``day``'s ISO week."""
    return day - dt.timedelta(days=day.isoweekday() - 1)


def iso_week(day: dt.date) -> str:
    """``2026-W40`` (ISO year and week number)."""
    year, week, _ = day.isocalendar()
    return f"{year}-W{week:02d}"


def week_starts(today: dt.date, weeks: int = SENTIMENT_WEEKS) -> list[dt.date]:
    """Mondays of the last ``weeks`` ISO weeks, oldest first; the last one is ``today``'s week."""
    current = week_start(today)
    return [current - dt.timedelta(weeks=weeks - 1 - i) for i in range(weeks)]


# --------------------------------------------------------------------------- #
# Sentiment
# --------------------------------------------------------------------------- #


def note_weight(kind: str, strength: int) -> int:
    """The strength a note counts with: 1-3, community capped at 1."""
    value = max(1, min(3, int(strength)))
    return 1 if kind == COMMUNITY_KIND else value


def week_score(notes: Sequence[ScoredNote]) -> float | None:
    """``sum(sign * weight) / (3 * n)`` in [-1, 1]; None without notes."""
    if not notes:
        return None
    total = sum(POLARITY_SIGN.get(n.polarity, 0) * note_weight(n.kind, n.strength) for n in notes)
    return round(total / (3 * len(notes)), 4)


def sentiment_weeks(
    notes: Iterable[ScoredNote], at: dt.datetime, weeks: int = SENTIMENT_WEEKS
) -> list[float | None]:
    """One score per ISO week (oldest first, the last = ``at``'s week) over the notes stored and not
    dismissed at ``at``; candidate notes never count."""
    starts = week_starts(at.date(), weeks)
    index = {start: i for i, start in enumerate(starts)}
    buckets: list[list[ScoredNote]] = [[] for _ in starts]
    for note in notes:
        if note.kind == CANDIDATE_KIND or not note.stored_at(at):
            continue
        i = index.get(week_start(note.observed_at.date()))
        if i is not None:
            buckets[i].append(note)
    return [week_score(bucket) for bucket in buckets]


def direction(values: Sequence[float | None]) -> Direction:
    """Last 4 weeks vs the previous 4 (empty weeks count 0)."""
    recent = sum(v or 0.0 for v in values[-4:])
    previous = sum(v or 0.0 for v in values[-8:-4])
    delta = recent - previous
    if delta > DIRECTION_DELTA:
        return Direction.RISING
    if delta < -DIRECTION_DELTA:
        return Direction.FALLING
    return Direction.STABLE


# --------------------------------------------------------------------------- #
# Thesis health
# --------------------------------------------------------------------------- #


def window_notes(
    notes: Iterable[ScoredNote],
    at: dt.datetime,
    *,
    since: dt.datetime | None = None,
    window_days: int = HEALTH_WINDOW_DAYS,
) -> list[ScoredNote]:
    """Notes active at ``at`` and observed in the ``window_days`` before it; with ``since`` (the
    thesis' last change) only notes stored after it."""
    start = at - dt.timedelta(days=window_days)
    return [
        n
        for n in notes
        if n.active_at(at)
        and n.observed_at >= start
        and (since is None or n.created_at >= since)
        and n.kind != CANDIDATE_KIND
    ]


def empty_counts() -> dict[str, int]:
    return {"supports": 0, "weakens": 0, "invalidates": 0, "neutral": 0, "community": 0}


def relation_counts(notes: Iterable[ScoredNote]) -> dict[str, int]:
    counts = empty_counts()
    for note in notes:
        if note.thesis_relation in counts:
            counts[note.thesis_relation] += 1
        if note.kind == COMMUNITY_KIND:
            counts["community"] += 1
    return counts


def strongest_relation(notes: Iterable[ScoredNote]) -> str:
    best = "none"
    for note in notes:
        if RELATION_RANK.get(note.thesis_relation, 0) > RELATION_RANK[best]:
            best = note.thesis_relation
    return best


@dataclass(frozen=True, slots=True)
class HealthResult:
    state: Health
    counts: dict[str, int] = field(default_factory=empty_counts)
    relation: str = "none"
    """The strongest thesis relation among the window's notes."""
    note_ids: tuple[int, ...] = ()
    """The window's notes that bear on the thesis (supports / weakens / invalidates), newest first."""


def thesis_health(
    notes: Iterable[ScoredNote],
    at: dt.datetime,
    *,
    has_thesis: bool,
    thesis_changed_at: dt.datetime | None = None,
    researched: bool = False,
) -> HealthResult:
    """Health of one position at ``at`` from its notes. ``researched``: a research run covered the
    instrument in the window (a note in the window also counts as covered)."""
    all_notes = list(notes)
    if not has_thesis:
        counted = window_notes(all_notes, at)
        return HealthResult(Health.NO_THESIS, relation_counts(counted), "none")
    counted = window_notes(all_notes, at, since=thesis_changed_at)
    counts = relation_counts(counted)
    relation = strongest_relation(counted)
    bearing = sorted(
        (n for n in counted if n.thesis_relation in ("supports", "weakens", "invalidates")),
        key=lambda n: (n.observed_at, n.id),
        reverse=True,
    )
    ids = tuple(n.id for n in bearing)
    if counts["invalidates"]:
        state = Health.INVALIDATED
    elif counts["weakens"]:
        state = Health.WEAKENED
    elif counts["supports"]:
        state = Health.SUPPORTED
    elif researched or window_notes(all_notes, at):
        state = Health.CURRENT
    else:
        state = Health.NO_RESEARCH
    return HealthResult(state, counts, relation, ids)


def health_rank(state: Health | str) -> int:
    """Position of ``state`` in :data:`HEALTH_ORDER` (0 = most attention)."""
    try:
        return HEALTH_ORDER.index(Health(state))
    except ValueError:
        return len(HEALTH_ORDER)


# --------------------------------------------------------------------------- #
# Themes
# --------------------------------------------------------------------------- #

_SPACES = re.compile(r"\s+")
_NOT_SLUG = re.compile(r"[^a-z0-9]+")
_FOLD = str.maketrans({"ł": "l", "Ł": "L", "ß": "ss", "ø": "o", "Ø": "O", "đ": "d", "Đ": "D"})


def clean_theme(theme: str | None) -> str | None:
    """A theme as stored: trimmed, inner whitespace collapsed (None when empty)."""
    if theme is None:
        return None
    text = _SPACES.sub(" ", str(theme)).strip()
    return text or None


def theme_key(theme: str) -> str:
    """Grouping key of a theme: case- and accent-insensitive slug (``Półprzewodniki`` and
    ``polprzewodniki`` are one theme)."""
    text = unicodedata.normalize("NFKD", (clean_theme(theme) or "").translate(_FOLD))
    text = "".join(c for c in text if not unicodedata.combining(c)).casefold()
    return _NOT_SLUG.sub("-", text).strip("-")[:60] or "theme"
