"""Research API (included into the investments router, so mounted under ``/api/p/{slug}/investments``
like every investments route): ``research`` (notes with filters), ``research/summary``,
``research/runs``, ``POST research/read`` (read marks, F8), ``PATCH research/{id}`` (dismiss /
restore), ``POST|DELETE research/{id}/accept`` (candidate -> watchlist + draft thesis, and its undo).
Reads and writes only the profile in the URL. Notes are written by the agent through MCP (``core/mcp/tools/research.py``).
Shapes: the CONTRACT in ``stock/docs/fork/progress/F6-RS.md``.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

from finanse.core.api import CurrentProfile
from finanse.core.db import get_session

from .models import RESEARCH_NOTE_KINDS
from .research import service, views
from .research.validation import parse_moment
from .service import plans as plan_service

router = APIRouter(prefix="/research")

MAX_LIMIT = 500


def _coded(status: int, message: str, code: str) -> HTTPException:
    return HTTPException(status_code=status, detail=message, headers={"X-Finanse-Error-Code": code})


def _mapped(error: Exception) -> HTTPException:
    if isinstance(error, service.ResearchNotFound):
        return _coded(404, str(error), "not_found")
    if isinstance(error, service.UndoExpired):
        return _coded(409, str(error), "undo_expired")
    if isinstance(error, service.ResearchConflict):
        return _coded(409, str(error), "research_conflict")
    return _coded(422, str(error), "research_invalid")


@router.get("")
def research_notes(
    profile: CurrentProfile,
    instrument: int | None = None,
    theme: str | None = None,
    kind: str | None = None,
    since: str | None = None,
    run_id: int | None = None,
    include_dismissed: bool = False,
    include_expired: bool = False,
    limit: int = Query(200, ge=1, le=MAX_LIMIT),
) -> list[dict]:
    """Research notes, newest observation first. ``kind``: one kind or a comma list (news, earnings,
    community, trend, macro, candidate); ``since``: YYYY-MM-DD or an ISO timestamp, by storing time
    (poll with the running run's ``started_at``); dismissed and expired notes only on request."""
    kinds = [k.strip() for k in (kind or "").split(",") if k.strip()]
    unknown = [k for k in kinds if k not in RESEARCH_NOTE_KINDS]
    if unknown:
        raise _coded(
            422, f"kind must be one of: {', '.join(RESEARCH_NOTE_KINDS)}", "research_invalid"
        )
    moment = None
    if since:
        moment = parse_moment(since)
        if moment is None:
            raise _coded(422, "since must be YYYY-MM-DD or an ISO timestamp", "research_invalid")
    with get_session() as s:
        rows = service.notes(
            s,
            profile.id,
            instrument_id=instrument,
            theme=theme,
            kinds=kinds,
            since=moment,
            run_id=run_id,
            include_dismissed=include_dismissed,
            include_expired=include_expired,
            limit=limit,
        )
        return views.notes_view(s, profile, rows)


@router.get("/summary")
def research_summary(profile: CurrentProfile) -> dict:
    """Thesis health (7 states), relation counts, 8-week sentiment and direction per position (held,
    watched or with notes) and per theme; the latest run; candidate counts."""
    with get_session() as s:
        return views.summary(s, profile)


@router.get("/runs")
def research_runs(profile: CurrentProfile, limit: int = Query(20, ge=1, le=100)) -> list[dict]:
    """Research runs, newest first (a run left running for hours shows as failed / interrupted)."""
    with get_session() as s:
        return views.runs_view(s, profile, limit)


class ReadBody(BaseModel):
    model_config = {"extra": "forbid"}

    instrument_id: int | None = None
    theme: str | None = None
    ids: list[int] | None = None


@router.post("/read")
def research_read(profile: CurrentProfile, body: ReadBody) -> dict:
    """Mark the profile's unread notes read (the owner opened them): exactly one of
    ``{"instrument_id": n}``, ``{"theme": "..."}`` or ``{"ids": [...]}`` -> ``{"marked": n}``
    (idempotent; 404 for an instrument that is not the profile's). Not exposed over MCP: the agent
    never marks notes read."""
    with get_session() as s:
        try:
            marked = service.mark_read(
                s, profile, instrument_id=body.instrument_id, theme=body.theme, ids=body.ids
            )
        except (service.ResearchError, service.ResearchNotFound) as e:
            raise _mapped(e) from None
        return {"marked": marked}


class NotePatch(BaseModel):
    model_config = {"extra": "forbid"}

    dismissed: bool


@router.patch("/{note_id}")
def research_note_update(profile: CurrentProfile, note_id: int, body: NotePatch) -> dict:
    """``{"dismissed": true}`` dismisses the note (its research signal resolves when no other note
    keeps it open; a dismissed candidate is not proposed again for 90 days); ``{"dismissed": false}``
    restores it within 15 minutes of the dismissal (409 ``undo_expired`` later)."""
    with get_session() as s:
        try:
            row = (
                service.dismiss(s, profile, note_id)
                if body.dismissed
                else service.restore(s, profile, note_id)
            )
        except (service.ResearchError, service.ResearchNotFound) as e:
            raise _mapped(e) from None
        plan_service.sync_after_note(s, profile, row)  # the health the plan check reads moved
        return views.one_note(s, profile, row)


@router.post("/{note_id}/accept")
def research_candidate_accept(profile: CurrentProfile, note_id: int) -> dict:
    """``Obserwuj`` on a candidate: watchlist item (source user) + a draft thesis with the
    candidate's entry type when the instrument has none. Undo with DELETE within 15 minutes."""
    from .service import views as inv_views

    with get_session() as s:
        try:
            result = service.accept_candidate(s, profile, note_id)
        except (service.ResearchError, service.ResearchNotFound) as e:
            raise _mapped(e) from None
        item = next(
            (
                r
                for r in inv_views.watchlist_view(s, profile)
                if r["id"] == result.watchlist_item_id
            ),
            None,
        )
        return {
            "note": views.one_note(s, profile, result.note),
            "watchlist_item": item,
            "thesis": inv_views.thesis_dict(result.thesis) if result.thesis is not None else None,
            "created_instrument": result.created_instrument,
            "warnings": result.warnings,
        }


@router.delete("/{note_id}/accept")
def research_candidate_unaccept(profile: CurrentProfile, note_id: int) -> dict:
    """Undo ``Obserwuj`` within 15 minutes (removes the watchlist item and the untouched draft thesis
    it created)."""
    with get_session() as s:
        try:
            row = service.undo_accept(s, profile, note_id)
        except (service.ResearchError, service.ResearchNotFound) as e:
            raise _mapped(e) from None
        return views.one_note(s, profile, row)
