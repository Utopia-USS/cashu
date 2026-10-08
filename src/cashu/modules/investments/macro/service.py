"""Macro regime cards (P6) for the API (``GET /research/macro``), the review digest (``macro_changes``)
and the MCP research context: the stored reference closes -> ``regimes.evaluate`` (cached per as-of
date and macro data version) joined with the macro notes (segment notes on the ``macro_*`` keys, read
fresh). Also the refresh glue the daily check and the CLI share (read last dates, fetch, write; never a
transaction across the network).

Public market data: nothing here depends on the profile except the notes.
"""

from __future__ import annotations

import datetime as dt
import threading
from collections.abc import Callable
from contextlib import AbstractContextManager

from sqlmodel import Session

from cashu.core.models import Profile, utcnow

from ..store import convert
from ..store import macro as macro_store
from . import regimes as rg
from .refresh import MacroChartSource, MacroReport, refresh_macro

SessionFactory = Callable[[], AbstractContextManager[Session]]
DIGITS = 6
_CACHE_SIZE = 16
_cache: dict[tuple, tuple[rg.Regime, ...]] = {}
_cache_lock = threading.Lock()


def _today() -> dt.date:
    return dt.date.today()  # noqa: DTZ011 - naive local date, like the daily check's as_of


def regimes(session: Session, as_of: dt.date | None = None) -> tuple[rg.Regime, ...]:
    """The five regimes as of ``as_of`` (today) from every stored close (no sliding window: ``since``
    and the history never move with the request date). Cached per (database, as_of, macro data
    version): two aggregate queries per call while nothing changed."""
    as_of = as_of or _today()
    key = (str(session.get_bind().url), as_of, macro_store.data_version(session))
    with _cache_lock:
        found = _cache.get(key)
    if found is not None:
        return found
    closes = macro_store.closes(session, until=as_of)
    result = rg.evaluate(closes, as_of)
    with _cache_lock:
        if len(_cache) >= _CACHE_SIZE:
            _cache.clear()
        _cache[key] = result
    return result


def clear_cache() -> None:
    with _cache_lock:
        _cache.clear()


def _r(value: float) -> float:
    return round(float(value), DIGITS) + 0.0  # never -0.0


def metric_dict(metric: rg.Metric) -> dict:
    return {
        "label": metric.label,
        "value": _r(metric.value),
        "unit": metric.unit,
        "text": metric.text,
        "stale": metric.stale,
    }


def _iso(day: dt.date | None) -> str | None:
    return None if day is None else day.isoformat()


def regime_dict(regime: rg.Regime) -> dict:
    """A regime without its notes (the card's market part)."""
    return {
        "key": regime.key,
        "label": regime.label,
        "state": regime.state,
        "state_label": regime.state_label,
        "tone": regime.tone,
        "since": _iso(regime.since),
        "since_open": regime.since_open,
        "since_min": _iso(regime.since_min),
        "as_of": _iso(regime.as_of),
        "stale": regime.stale,
        "missing": regime.missing,
        "flags": list(regime.flags),
        "meaning": regime.meaning,
        "metrics": [metric_dict(m) for m in regime.metrics],
        "history": [
            {
                "date": run.date.isoformat(),
                "state": run.state,
                "state_label": rg.state_label(regime.key, run.state),
                "open": run.open,
            }
            for run in regime.history[-rg.HISTORY_MAX :]
        ],
    }


def macro_view(
    session: Session,
    profile: Profile,
    *,
    as_of: dt.date | None = None,
    now: dt.datetime | None = None,
) -> dict:
    """``GET /research/macro``: the five cards in :data:`regimes.ORDER`, each with its latest macro
    note (``macro_<key>``), when the last one was observed, whether one is from this ISO week and the
    unread count."""
    from ..research.segment_service import brief_note, notes_by_segment
    from ..research.segments import macro_key

    assert profile.id is not None
    as_of = as_of or _today()
    now = convert.aware(now or utcnow())
    notes = notes_by_segment(session, profile.id, now)
    cards = []
    found = regimes(session, as_of)
    for regime in found:
        entry = notes.get(macro_key(regime.key))
        latest = entry.latest if entry is not None else None
        newest = entry.newest if entry is not None else None
        note = brief_note(latest)
        if note is not None:
            note.pop("strength", None)
        cards.append(
            regime_dict(regime)
            | {
                "note": note,
                "last_note_at": None if newest is None else brief_note(newest)["observed_at"],
                "note_this_week": _same_week(latest, now),
                "unread": entry.unread if entry is not None else 0,
            }
        )
    last = max((r.as_of for r in found if r.as_of is not None), default=None)
    return {"as_of": _iso(last), "regimes": cards}


def _same_week(row, now: dt.datetime) -> bool:
    if row is None:
        return False
    return convert.aware(row.observed_at).isocalendar()[:2] == now.isocalendar()[:2]


def changes(session: Session, start: dt.date, end: dt.date | None = None) -> list[dict]:
    """Regimes whose reported state changed within ``start..end`` (the review digest period; end =
    today): ``{key, label, from_label, to_label, since}``. A switch counts in the period where it
    became visible (``StateRun.confirmed``, the 5th session), never where its run began, so a switch
    straddling two periods shows exactly once. from = the state reported before ``start``, to = the
    current one; ``since`` = the run's first session. A regime that came back to its starting state
    within the period, a missing one and one whose state before ``start`` is unknown (before the
    first evaluated session) are left out."""
    end = end or _today()
    out: list[dict] = []
    for regime in regimes(session, end):
        if regime.missing or not regime.history:
            continue
        before = [run for run in regime.history if run.confirmed < start]
        within = [run for run in regime.history if start <= run.confirmed <= end]
        if not before or not within:
            continue
        old, new = before[-1].state, regime.history[-1].state
        if old == new:
            continue
        out.append(
            {
                "key": regime.key,
                "label": regime.label,
                "from_label": rg.state_label(regime.key, old),
                "to_label": rg.state_label(regime.key, new),
                "since": _iso(regime.since),
            }
        )
    return out


def refresh_and_store(
    source: MacroChartSource,
    as_of: dt.date,
    *,
    session_factory: SessionFactory,
    now: Callable[[], dt.datetime] = utcnow,
) -> tuple[MacroReport, dict[str, int]]:
    """Fetch every series (no session open), then write the closes in one short transaction. Fetch
    errors are report entries; returns the report and counts."""
    report = refresh_macro(source, as_of)
    with session_factory() as s:
        stats = macro_store.apply_report(s, report, now=convert.aware(now()))
    return report, stats
