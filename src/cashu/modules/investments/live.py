"""Change events of the investments module for the open app (P10 live data, ``core/events.py``): which
tables are watched and the wire dict of one row of the list entities (research notes, alerts, watchlist
items), built by the same view functions as the list endpoints. Imported by core on first use."""

from __future__ import annotations

TABLES = {
    "research_notes": "note",
    "inv_theses": "thesis",
    "inv_topic_theses": "topic_thesis",
    "inv_profile_instruments": "segment_assignment",
    "alerts": "alert",
    "watchlist_items": "watchlist",
    "inv_signals": "signal",
}


def _note(session, profile, ref: str) -> dict | None:
    from .models import InvResearchNote
    from .research import views

    row = session.get(InvResearchNote, int(ref))
    if row is None or row.profile_id != profile.id:
        return None
    return views.one_note(session, profile, row)


def _alert(session, profile, ref: str) -> dict | None:
    from .models import InvAlert
    from .service import views

    row = session.get(InvAlert, int(ref))
    if row is None or row.profile_id != profile.id:
        return None
    return views.one_alert(session, profile, row)


def _watch(session, profile, ref: str) -> dict | None:
    from .models import InvWatchlistItem
    from .service import views

    row = session.get(InvWatchlistItem, int(ref))
    if row is None or row.profile_id != profile.id:
        return None
    return next((r for r in views.watchlist_view(session, profile) if r.get("id") == row.id), None)


def register(watch, register_payload) -> None:
    for table, entity in TABLES.items():
        watch(table, entity)
    register_payload("note", _note)
    register_payload("alert", _alert)
    register_payload("watchlist", _watch)
