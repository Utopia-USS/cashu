"""Research API (included into the investments router, so mounted under ``/api/p/{slug}/investments``
like every investments route): ``research`` (notes with filters), ``research/summary``,
``research/segments`` (the market segments: move attribution and segment notes, P5), ``research/macro``
(the macro regime cards and their notes, P6), ``research/runs``, ``POST research/read`` (read marks, F8), ``PATCH research/{id}`` (dismiss /
restore), ``POST|DELETE research/{id}/accept`` (candidate -> watchlist + draft thesis, and its undo);
``GET|PUT|DELETE topics/{segment}/thesis`` (the topic thesis, P9; ``topics_router``),
``PUT topics/{segment}/view`` (the market view under it, P11).
Reads and writes only the profile in the URL. Notes are written by the agent through MCP (``core/mcp/tools/research.py``).
Shapes: the CONTRACT in ``stock/docs/fork/progress/F6-RS.md``.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

from cashu.core.api import CurrentProfile
from cashu.core.db import get_session

from .models import RESEARCH_NOTE_KINDS
from .research import segment_service, service, views
from .research.segments import NOTE_SEGMENT_KEYS, is_note_segment
from .research.validation import parse_moment
from .service import plans as plan_service

router = APIRouter(prefix="/research")

MAX_LIMIT = 500


def _coded(status: int, message: str, code: str) -> HTTPException:
    return HTTPException(status_code=status, detail=message, headers={"X-Cashu-Error-Code": code})


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
    segment: str | None = None,
    kind: str | None = None,
    since: str | None = None,
    run_id: int | None = None,
    include_dismissed: bool = False,
    include_expired: bool = False,
    limit: int = Query(200, ge=1, le=MAX_LIMIT),
) -> list[dict]:
    """Research notes, newest observation first. ``kind``: one kind or a comma list (news, earnings,
    community, trend, macro, candidate); ``since``: YYYY-MM-DD or an ISO timestamp, by storing time
    (poll with the running run's ``started_at``); dismissed and expired notes only on request.
    ``segment``: a market segment's notes (catalog key); ``theme``: old theme notes."""
    kinds = [k.strip() for k in (kind or "").split(",") if k.strip()]
    unknown = [k for k in kinds if k not in RESEARCH_NOTE_KINDS]
    if unknown:
        raise _coded(
            422, f"kind must be one of: {', '.join(RESEARCH_NOTE_KINDS)}", "research_invalid"
        )
    if segment is not None and not is_note_segment(segment):
        raise _coded(
            422, f"segment must be one of: {', '.join(NOTE_SEGMENT_KEYS)}", "research_invalid"
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
            segment=segment,
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
    watched or with notes); the latest run; candidate counts."""
    with get_session() as s:
        return views.summary(s, profile)


@router.get("/segments")
def research_segments(profile: CurrentProfile, window: str = "1w") -> dict:
    """What moved the portfolio over the last week (``1w``) or 4 weeks (``4w``) by market segment and
    currency, with each segment's latest note (fractions only, no amounts)."""
    with get_session() as s:
        try:
            return segment_service.segments_view(s, profile, window=window)
        except segment_service.WindowError as e:
            raise _coded(422, str(e), "research_invalid") from None


@router.get("/macro")
def research_macro(profile: CurrentProfile) -> dict:
    """The five macro regime cards (P6) as of today: state (after hysteresis), since, metrics with
    server-formatted Polish text, state history, meaning (tooltip) and each card's latest macro note.
    Public market data; only the notes are the profile's."""
    from .macro import service as macro_service

    with get_session() as s:
        return macro_service.macro_view(s, profile)


@router.get("/runs")
def research_runs(profile: CurrentProfile, limit: int = Query(20, ge=1, le=100)) -> list[dict]:
    """Research runs, newest first (a run left running for hours shows as failed / interrupted)."""
    with get_session() as s:
        return views.runs_view(s, profile, limit)


class ReadBody(BaseModel):
    model_config = {"extra": "forbid"}

    instrument_id: int | None = None
    theme: str | None = None
    segment: str | None = None
    ids: list[int] | None = None


@router.post("/read")
def research_read(profile: CurrentProfile, body: ReadBody) -> dict:
    """Mark the profile's unread notes read (the owner opened them): exactly one of
    ``{"instrument_id": n}``, ``{"segment": "<key>"}``, ``{"theme": "..."}`` (old theme notes) or
    ``{"ids": [...]}`` -> ``{"marked": n}``
    (idempotent; 404 for an instrument that is not the profile's). Not exposed over MCP: the agent
    never marks notes read."""
    with get_session() as s:
        try:
            marked = service.mark_read(
                s,
                profile,
                instrument_id=body.instrument_id,
                theme=body.theme,
                ids=body.ids,
                segment=body.segment,
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


# --------------------------------------------------------------------------- #
# Topic theses (P9): /investments/topics/{segment}/thesis
# --------------------------------------------------------------------------- #

topics_router = APIRouter(prefix="/topics")


class TopicThesisBody(BaseModel):
    model_config = {"extra": "forbid"}

    thesis: str
    invalidation: str | None = None


class TopicViewBody(BaseModel):
    model_config = {"extra": "forbid"}

    assessment: str | None = None
    outlook: str | None = None
    sources: list[dict] | None = None
    """Optional: left out keeps the stored view sources, null or ``[]`` clears them."""


def _topic_error(error: Exception) -> HTTPException:
    return _coded(422, str(error), "research_invalid")


@topics_router.get("/{segment}/thesis")
def topic_thesis_get(profile: CurrentProfile, segment: str) -> dict | None:
    """The profile's thesis on a topic (a segment catalog key), or ``null`` when it has none."""
    from .research import topic_theses

    with get_session() as s:
        try:
            key = topic_theses.check_segment(segment)
        except topic_theses.TopicThesisError as e:
            raise _topic_error(e) from None
        return topic_theses.thesis_dict(topic_theses.get(s, profile.id, key))


@topics_router.put("/{segment}/thesis")
def topic_thesis_put(profile: CurrentProfile, segment: str, body: TopicThesisBody) -> dict:
    """The owner writes the topic thesis: creates it or replaces its text (``invalidation`` null
    clears it); saving clears ``draft`` (confirms an agent draft)."""
    from .research import topic_theses

    with get_session() as s:
        try:
            row, _created = topic_theses.save_owner(
                s, profile.id, segment, body.thesis, body.invalidation
            )
        except topic_theses.TopicThesisError as e:
            raise _topic_error(e) from None
        return topic_theses.thesis_dict(row)


@topics_router.put("/{segment}/view")
def topic_view_put(profile: CurrentProfile, segment: str, body: TopicViewBody) -> dict:
    """The owner edits the market view under the topic thesis (``Ocena teraz`` / ``Perspektywa``);
    a null or blank field clears it. ``sources`` is optional (left out keeps the stored ones, null
    or ``[]`` clears them, else 1-6 like a research note's); clearing both fields drops them. 422
    without a live thesis or for buy / sell or price-call wording. Returns the thesis (with the
    view)."""
    from .research import topic_theses

    sources = body.sources if "sources" in body.model_fields_set else topic_theses.KEEP
    with get_session() as s:
        try:
            row = topic_theses.set_market_view(
                s,
                profile.id,
                segment,
                body.assessment,
                body.outlook,
                sources=sources,
                by=topic_theses.OWNER,
            )
        except topic_theses.TopicThesisError as e:
            raise _topic_error(e) from None
        return topic_theses.thesis_dict(row)


@topics_router.delete("/{segment}/thesis")
def topic_thesis_delete(profile: CurrentProfile, segment: str) -> dict:
    """Delete the topic thesis -> ``{"deleted": true}`` (``false`` when there was none). Kept as a
    rejection: the research agent may not propose a draft for the topic for 90 days. Notes that
    bore on it keep their ``thesis_relation`` (research is never dropped)."""
    from .research import topic_theses

    with get_session() as s:
        try:
            deleted = topic_theses.delete(s, profile.id, segment)
        except topic_theses.TopicThesisError as e:
            raise _topic_error(e) from None
        return {"deleted": deleted}
