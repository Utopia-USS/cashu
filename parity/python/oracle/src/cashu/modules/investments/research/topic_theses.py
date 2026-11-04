"""Topic theses (P9): the owner's thesis on a market topic (a segment of ``segments.SEGMENTS``), one
per profile and topic, with an optional invalidation. The owner writes it in the app (saving clears
``draft``); the research agent may only create or update a draft (``upsert_draft``) and never touches
an owner thesis. A topic note may then carry ``thesis_relation`` (supports | weakens | invalidates)
once the thesis is not a draft. Deleting a thesis (any: the owner's, a confirmed or an agent draft)
keeps the row as a rejection (``rejected_at``):
it reads as "no thesis" everywhere, and the agent may not propose a draft for that topic for
:data:`TOPIC_DRAFT_COOLDOWN_DAYS` days (P9 review fix). Under a live thesis (draft or confirmed) sits one
market view (P11, :func:`set_market_view`): the topic's market now and its outlook, kept current by the
agent and editable by the owner.

Every function works in the caller's transaction and only touches the given profile's rows. Errors:
:class:`TopicThesisError` (422, message safe to show), :class:`OwnerThesis` (409 for the agent).
"""

from __future__ import annotations

import datetime as dt
import re

from sqlmodel import Session, select

from cashu.core.models import utcnow

from ..models import (
    TOPIC_DRAFT_COOLDOWN_DAYS,
    TOPIC_INVALIDATION_MAX,
    TOPIC_THESIS_MAX,
    InvTopicThesis,
)
from ..store import convert
from .segments import SEGMENT_KEYS, is_macro_key, is_segment, segment_label

OWNER = "owner"
AGENT = "agent"
_CONTROL = re.compile(r"[\x00-\x08\x0b-\x1f\x7f]")


class TopicThesisError(ValueError):
    """Invalid topic thesis input (message safe to show)."""


class OwnerThesis(TopicThesisError):
    """The agent tried to change the owner's thesis."""


class RejectedDraft(OwnerThesis):
    """The agent proposed a draft for a topic whose draft the owner deleted (cooldown)."""


KEEP = object()
"""``set_market_view(sources=KEEP)``: the owner's edit leaves the stored view sources as they are."""


def check_segment(segment: object) -> str:
    if is_macro_key(segment):
        raise TopicThesisError("a macro regime has no thesis; a thesis belongs to a topic")
    if not is_segment(segment):
        raise TopicThesisError(f"segment must be one of: {', '.join(SEGMENT_KEYS)}")
    return str(segment)


def _clean(value: object, *, field: str, maximum: int, required: bool) -> str | None:
    if value is None or (isinstance(value, str) and not value.strip()):
        if required:
            raise TopicThesisError(f"{field} is required")
        return None
    if not isinstance(value, str):
        raise TopicThesisError(f"{field} must be text")
    text = value.strip().replace("\r\n", "\n").replace("\r", "\n")
    text = re.sub(r"\n{3,}", "\n\n", text)
    if _CONTROL.search(text):
        raise TopicThesisError(f"{field} must not contain control characters")
    if len(text) > maximum:
        raise TopicThesisError(f"{field} is too long (max {maximum} characters)")
    return text


def _row(session: Session, profile_id: int, segment: str) -> InvTopicThesis | None:
    """The stored row, a rejection included."""
    return session.exec(
        select(InvTopicThesis).where(
            InvTopicThesis.profile_id == profile_id, InvTopicThesis.segment == segment
        )
    ).first()


def get(session: Session, profile_id: int, segment: str) -> InvTopicThesis | None:
    """The topic's live thesis or draft (a rejected draft reads as None)."""
    row = _row(session, profile_id, segment)
    return None if row is None or row.rejected_at is not None else row


def by_segment(session: Session, profile_id: int) -> dict[str, InvTopicThesis]:
    """Live theses and drafts per topic (rejections left out)."""
    return {
        r.segment: r
        for r in session.exec(
            select(InvTopicThesis).where(
                InvTopicThesis.profile_id == profile_id, InvTopicThesis.rejected_at.is_(None)
            )
        ).all()
    }


def cooldown_until(row: InvTopicThesis) -> dt.datetime | None:
    if row.rejected_at is None:
        return None
    return convert.aware(row.rejected_at) + dt.timedelta(days=TOPIC_DRAFT_COOLDOWN_DAYS)


def cooldowns(
    session: Session, profile_id: int, now: dt.datetime | None = None
) -> dict[str, dt.datetime]:
    """Topic -> until when the agent may not propose a draft (the owner deleted one)."""
    now = convert.aware(now or utcnow())
    out = {}
    for r in session.exec(
        select(InvTopicThesis).where(
            InvTopicThesis.profile_id == profile_id, InvTopicThesis.rejected_at.is_not(None)
        )
    ).all():
        until = cooldown_until(r)
        if until is not None and until > now:
            out[r.segment] = until
    return out


def _write(
    session: Session,
    profile_id: int,
    segment: str,
    thesis: object,
    invalidation: object,
    *,
    by: str,
    keep_invalidation: bool,
) -> tuple[InvTopicThesis, bool]:
    text = _clean(thesis, field="thesis", maximum=TOPIC_THESIS_MAX, required=True)
    inval = _clean(
        invalidation, field="invalidation", maximum=TOPIC_INVALIDATION_MAX, required=False
    )
    now = utcnow()
    row = _row(session, profile_id, segment)
    if row is not None and row.rejected_at is not None:
        # a rejected draft: the owner's own thesis (or a new draft after the cooldown) starts over
        row.rejected_at = None
        row.created_by = by
        row.draft = by == AGENT
        row.created_at = now
        row.core_changed_at = now
        row.invalidation = None
        row.assessment = None
        row.outlook = None
        row.view_updated_at = None
        row.view_sources = None
        keep_invalidation = False
        created = True
    else:
        created = row is None
    if row is None:
        row = InvTopicThesis(
            profile_id=profile_id,
            segment=segment,
            thesis=text,
            invalidation=inval,
            draft=by == AGENT,
            created_by=by,
            core_changed_at=now,
            created_at=now,
            updated_at=now,
        )
    else:
        if keep_invalidation and invalidation is None:
            inval = row.invalidation
        if (row.thesis, row.invalidation) != (text, inval):
            row.core_changed_at = now  # the market view stays: it is about the topic's market
        row.thesis, row.invalidation = text, inval
        row.updated_at = now
        if by == OWNER:
            row.draft = False
    session.add(row)
    session.flush()
    return row, created


def save_owner(
    session: Session, profile_id: int, segment: str, thesis: object, invalidation: object = None
) -> tuple[InvTopicThesis, bool]:
    """The owner's save (``PUT``): creates or replaces the text and clears ``draft`` (confirming an
    agent draft); ``invalidation`` None clears it. Returns ``(row, created)``."""
    return _write(
        session,
        profile_id,
        check_segment(segment),
        thesis,
        invalidation,
        by=OWNER,
        keep_invalidation=False,
    )


def upsert_draft(
    session: Session, profile_id: int, segment: str, thesis: object, invalidation: object = None
) -> tuple[InvTopicThesis, bool]:
    """The agent's write: creates a draft or updates its own draft (``invalidation`` None keeps the
    stored one); an owner thesis (or a confirmed draft) is refused with :class:`OwnerThesis`."""
    segment = check_segment(segment)
    row = _row(session, profile_id, segment)
    if row is not None and row.rejected_at is not None:
        until = cooldown_until(row)
        if until is not None and until > convert.aware(utcnow()):
            raise RejectedDraft(
                f"the owner deleted the thesis on {segment} ({segment_label(segment)}); "
                f"do not propose one again before {until.date().isoformat()}"
            )
    elif row is not None and not row.draft:
        raise OwnerThesis(
            f"the owner already has a thesis on {segment} ({segment_label(segment)}); never "
            "overwrite it: write notes with thesis_relation instead"
        )
    return _write(
        session, profile_id, segment, thesis, invalidation, by=AGENT, keep_invalidation=True
    )


def delete(session: Session, profile_id: int, segment: str) -> bool:
    """The owner deletes the topic thesis (his own, a confirmed draft or an agent draft): the row stays
    as a rejection (``rejected_at``), so the agent may not propose a draft for the topic for
    :data:`TOPIC_DRAFT_COOLDOWN_DAYS` days."""
    row = get(session, profile_id, check_segment(segment))
    if row is None:
        return False
    now = utcnow()
    row.rejected_at = now
    row.updated_at = now
    session.add(row)
    session.flush()
    return True


def set_market_view(
    session: Session,
    profile_id: int,
    segment: str,
    assessment: object,
    outlook: object,
    *,
    sources: object = KEEP,
    by: str = AGENT,
) -> InvTopicThesis:
    """The market view under a live topic thesis (P11): ``assessment`` (the topic's market now) and
    ``outlook`` (where its market / adoption / demand is heading, with a horizon and the main risks),
    never a buy / sell call or a security price prediction (:func:`validation.market_view_problem`).

    The agent (``set_topic_market_view``) writes both, over any earlier view, the owner's included:
    it keeps the view current. Its outlook must name a quantitative industry estimate of market /
    demand growth (who, how much, horizon; owner decision 2026-10-10) and ``sources`` (1-6, like a
    research note's) are required and replace the stored ones. The owner (``PUT topics/{segment}/
    view``) may edit or clear either field (None or blank clears it); his ``sources`` are optional
    (:data:`KEEP` leaves them, None or ``[]`` clears them) and a view cleared of both fields drops
    them. The thesis itself (draft or confirmed) is never changed, and sourced research notes are
    never touched (research is never dropped)."""
    from .validation import (
        ResearchInputError,
        validate_assessment,
        validate_outlook,
        validate_view_sources,
    )

    key = check_segment(segment)
    row = get(session, profile_id, key)
    if row is None:
        raise TopicThesisError(
            f"topic {key} ({segment_label(key)}) needs a thesis (or an agent draft) before its "
            "market view can be saved"
        )

    def blank(value: object) -> bool:
        return value is None or (isinstance(value, str) and not value.strip())

    agent = by == AGENT
    problems: list[str] = []

    def check(fn, *args, **kwargs):
        try:
            return fn(*args, **kwargs)
        except ResearchInputError as error:
            problems.extend(
                f"{where}: {message}" if where else message for where, message in error.issues
            )
            return None

    new_assessment = (
        check(validate_assessment, assessment) if agent or not blank(assessment) else None
    )
    new_outlook = (
        check(validate_outlook, outlook, quantitative=agent)
        if agent or not blank(outlook)
        else None
    )
    if agent or (sources is not KEEP and sources not in (None, [])):
        new_sources = check(validate_view_sources, sources, now=convert.aware(utcnow()))
    elif sources is KEEP:
        new_sources = row.view_sources
    else:
        new_sources = None
    if problems:
        raise TopicThesisError("; ".join(problems))
    if not (new_assessment or new_outlook):
        new_sources = None  # a cleared view keeps no sources
    if (row.assessment, row.outlook, row.view_sources) != (
        new_assessment,
        new_outlook,
        new_sources,
    ):
        now = utcnow()
        row.assessment, row.outlook = new_assessment, new_outlook
        row.view_sources = new_sources or None
        row.view_updated_at = now if (new_assessment or new_outlook) else None
        row.updated_at = now
        session.add(row)
        session.flush()
    return row


def thesis_dict(row: InvTopicThesis | None) -> dict | None:
    """API shape (``GET /investments/topics/{segment}/thesis``, ``research/segments`` rows)."""
    from .views import iso

    if row is None:
        return None
    return {
        "id": row.id,
        "segment": row.segment,
        "label": segment_label(row.segment),
        "thesis": row.thesis,
        "invalidation": row.invalidation,
        "assessment": row.assessment,
        "outlook": row.outlook,
        "view_updated_at": iso(convert.aware(row.view_updated_at)) if row.view_updated_at else None,
        "view_sources": list(row.view_sources or []),
        "draft": row.draft,
        "created_by": row.created_by,
        "core_changed_at": iso(convert.aware(row.core_changed_at)),
        "created_at": iso(convert.aware(row.created_at)),
        "updated_at": iso(convert.aware(row.updated_at)),
    }
