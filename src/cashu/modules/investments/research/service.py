"""Research runs and notes of one profile: start / finish runs, add notes (validated, sourced, linked
to a held / watched instrument, a theme or a candidate), dismiss / restore notes (the signal follows),
accept a candidate (watchlist + draft thesis) or dismiss it (90-day cooldown), and housekeeping
(expired notes resolve their signal, runs left running are marked failed).

Every function works in the caller's transaction and only ever touches the given profile's rows.
Errors: :class:`ResearchError` (422, ``research_invalid``), :class:`ResearchConflict` (409,
``research_conflict``), :class:`UndoExpired` (409, ``undo_expired``), :class:`ResearchNotFound` (404).
"""

from __future__ import annotations

import datetime as dt
from collections.abc import Iterable
from dataclasses import dataclass, field

from sqlalchemy import func
from sqlmodel import Session, select

from cashu.core.models import Profile, utcnow

from ..domain import Instrument, opened_on
from ..models import (
    RESEARCH_CANDIDATE_COOLDOWN_DAYS,
    RESEARCH_RESTORE_MINUTES,
    InvResearchNote,
    InvResearchRun,
    InvThesis,
)
from ..portfolio import build_snapshot
from ..store import alerts as alert_store
from ..store import convert, instruments, journal, transactions
from . import signals as research_signals
from .scoring import CANDIDATE_KIND, HEALTH_WINDOW_DAYS, clean_theme, theme_key
from .validation import (
    REASON_MAX,
    NoteInput,
    ResearchInputError,
    RunScope,
    validate_counts,
)

RESTORE_WINDOW = dt.timedelta(minutes=RESEARCH_RESTORE_MINUTES)
CANDIDATE_COOLDOWN = dt.timedelta(days=RESEARCH_CANDIDATE_COOLDOWN_DAYS)
RUN_STALE = dt.timedelta(hours=4)
"""A run still ``running`` with no note for this long is treated as interrupted (failed)."""
MAX_NOTES_PER_RUN = 150
DUPLICATE_WINDOW = dt.timedelta(days=14)
DRAFT_THESIS_PREFIX = "Szkic z researchu: "


class ResearchError(ValueError):
    """Invalid research input or state (422 ``research_invalid``); the message is safe to show."""


class ResearchConflict(ResearchError):
    """The request conflicts with the stored state (409 ``research_conflict``)."""


class UndoExpired(ResearchConflict):
    """The undo window (15 minutes) passed (409 ``undo_expired``)."""


class ResearchNotFound(LookupError):
    """No such run / note / instrument in this profile (404)."""


def _now(now: dt.datetime | None) -> dt.datetime:
    return convert.aware(now or utcnow())


def aware(value: dt.datetime | None) -> dt.datetime | None:
    return None if value is None else convert.aware(value)


# --------------------------------------------------------------------------- #
# Instruments the research may talk about
# --------------------------------------------------------------------------- #


def owner_named(inst: Instrument | None) -> bool:
    """An instrument the owner named (claim, other, manually valued without an ISIN): private, never
    researched (same rule as the MCP privacy layer)."""
    if inst is None:
        return False
    mode = inst.valuation_mode.value if inst.valuation_mode else None
    return inst.asset_class.value in ("claim", "other") or (mode == "manual" and not inst.isin)


def researchable(inst: Instrument | None) -> bool:
    return inst is not None and not owner_named(inst) and inst.asset_class.value != "cash"


def held_since(
    session: Session, profile_id: int, as_of: dt.date | None = None
) -> dict[int, dt.date | None]:
    """Instruments the profile holds today (from its transactions; no valuation) -> the open date of
    the oldest still-open lot of the holding (P1: whether a held-only plan predates it)."""
    snapshot = build_snapshot(
        convert.sid(profile_id),
        transactions.transactions(session, profile_id),
        as_of or dt.date.today(),  # noqa: DTZ011 - naive local date, like trade dates
        renames=transactions.renames(session, profile_id),
    )
    grouped: dict[int, list] = {}
    for h in snapshot.holdings:
        grouped.setdefault(convert.pk(h.instrument_id), []).append(h)
    return {key: opened_on(holdings, snapshot.realized) for key, holdings in grouped.items()}


def held_instrument_ids(
    session: Session, profile_id: int, as_of: dt.date | None = None
) -> set[int]:
    """Instruments the profile holds today (from its transactions; no valuation)."""
    return set(held_since(session, profile_id, as_of))


def watched_instrument_ids(session: Session, profile_id: int) -> set[int]:
    return alert_store.watched_instrument_ids(session, profile_id)


def _instrument_keys(inst: Instrument) -> set[str]:
    keys = {k.upper() for k in (inst.symbol, inst.isin) if k}
    keys |= {a.value.upper() for a in inst.aliases if a.value}
    return keys


# --------------------------------------------------------------------------- #
# Runs
# --------------------------------------------------------------------------- #


def run(session: Session, profile_id: int, run_id: int) -> InvResearchRun | None:
    row = session.get(InvResearchRun, run_id)
    return row if row is not None and row.profile_id == profile_id else None


def runs(session: Session, profile_id: int, limit: int = 20) -> list[InvResearchRun]:
    return list(
        session.exec(
            select(InvResearchRun)
            .where(InvResearchRun.profile_id == profile_id)
            .order_by(InvResearchRun.started_at.desc(), InvResearchRun.id.desc())
            .limit(limit)
        ).all()
    )


def latest_run(
    session: Session, profile_id: int, *, status: str | None = None
) -> InvResearchRun | None:
    """The newest run (of ``status`` when given)."""
    query = select(InvResearchRun).where(InvResearchRun.profile_id == profile_id)
    if status is not None:
        query = query.where(InvResearchRun.status == status)
    return session.exec(
        query.order_by(InvResearchRun.started_at.desc(), InvResearchRun.id.desc())
    ).first()


def _last_activity(session: Session, row: InvResearchRun) -> dt.datetime:
    newest = session.exec(
        select(InvResearchNote.created_at)
        .where(InvResearchNote.run_id == row.id)
        .order_by(InvResearchNote.created_at.desc())
    ).first()
    started = aware(row.started_at)
    return max(started, aware(newest)) if newest is not None else started


def is_stale(session: Session, row: InvResearchRun, now: dt.datetime) -> bool:
    """A ``running`` run without a note for :data:`RUN_STALE` (the agent was interrupted)."""
    return row.status == "running" and _now(now) - _last_activity(session, row) > RUN_STALE


def run_counts(session: Session, row: InvResearchRun) -> dict:
    """Server-side counts of a run: notes (non-candidate kinds and candidates) and signals."""
    notes = session.exec(select(InvResearchNote).where(InvResearchNote.run_id == row.id)).all()
    by_kind: dict[str, int] = {}
    for note in notes:
        by_kind[note.kind] = by_kind.get(note.kind, 0) + 1
    return {
        "notes": len(notes),
        "signals": len({n.signal_id for n in notes if n.signal_id is not None}),
        "candidates": by_kind.get(CANDIDATE_KIND, 0),
        "by_kind": by_kind,
    }


def _fail_stale_runs(session: Session, profile_id: int, now: dt.datetime) -> int:
    failed = 0
    for row in session.exec(
        select(InvResearchRun).where(
            InvResearchRun.profile_id == profile_id, InvResearchRun.status == "running"
        )
    ).all():
        if is_stale(session, row, now):
            row.status = "failed"
            row.finished_at = _last_activity(session, row)
            row.counts = {**run_counts(session, row), **(row.counts or {}), "reason": "interrupted"}
            session.add(row)
            failed += 1
    if failed:
        session.flush()
    return failed


def running_run(
    session: Session, profile_id: int, now: dt.datetime | None = None
) -> InvResearchRun | None:
    """The profile's newest ``running`` run that is not stale."""
    now = _now(now)
    for row in session.exec(
        select(InvResearchRun)
        .where(InvResearchRun.profile_id == profile_id, InvResearchRun.status == "running")
        .order_by(InvResearchRun.started_at.desc(), InvResearchRun.id.desc())
    ).all():
        if not is_stale(session, row, now):
            return row
    return None


def resolve_reference(session: Session, profile_id: int, reference: str) -> int:
    """An instrument the profile references, by id, symbol, ISIN or price alias (case-insensitive);
    owner-named and cash instruments are refused (never researched)."""
    ids = instruments.profile_instrument_ids(session, profile_id)
    text = (reference or "").strip()
    loaded = instruments.load(session, ids, profile_id=profile_id)
    if text.isdigit() and int(text) in loaded:
        matches = [int(text)]
    else:
        wanted = text.upper()
        matches = [i for i, inst in loaded.items() if wanted in _instrument_keys(inst)]
    if not matches:
        raise ResearchNotFound(
            "no such instrument in this profile (held, watched or with an alert; see research_context)"
        )
    if len(matches) > 1:
        raise ResearchError(
            "several instruments match; pass the instrument_id from research_context"
        )
    if not researchable(loaded[matches[0]]):
        raise ResearchError(
            "that instrument is owner-named (private) or cash: it is not researched"
        )
    return matches[0]


def start_run(
    session: Session,
    profile: Profile,
    scope: RunScope,
    *,
    now: dt.datetime | None = None,
    created_by: str = "agent",
) -> InvResearchRun:
    """Open a run. Another non-stale ``running`` run is a conflict (finish it first); stale ones are
    marked failed. The stored scope lists the instruments the run covers (``covered_instrument_ids``:
    held / watched as asked, plus explicit ones), so thesis health knows what was researched."""
    assert profile.id is not None
    now = _now(now)
    _fail_stale_runs(session, profile.id, now)
    current = running_run(session, profile.id, now)
    if current is not None:
        raise ResearchConflict(
            f"research run {current.id} is still running (started "
            f"{aware(current.started_at).isoformat(timespec='minutes')}); finish it first "
            "(finish_research_run with status done or failed)"
        )
    explicit = [resolve_reference(session, profile.id, ref) for ref in scope.instruments]
    covered: set[int] = set(explicit)
    loaded_ids: set[int] = set()
    if scope.held:
        loaded_ids |= held_instrument_ids(session, profile.id)
    if scope.watchlist:
        loaded_ids |= watched_instrument_ids(session, profile.id)
    loaded = instruments.load(session, loaded_ids, profile_id=profile.id)
    covered |= {i for i, inst in loaded.items() if researchable(inst)}
    row = InvResearchRun(
        profile_id=profile.id,
        started_at=now,
        status="running",
        scope={
            "held": scope.held,
            "watchlist": scope.watchlist,
            "candidates": scope.candidates,
            "themes": list(scope.themes),
            "instrument_ids": explicit,
            "covered_instrument_ids": sorted(covered),
            "scheduled": scope.scheduled,
        },
        counts={},
        created_by=created_by,
    )
    session.add(row)
    session.flush()
    return row


def finish_run(
    session: Session,
    profile: Profile,
    run_id: int,
    *,
    status: str = "done",
    counts: dict | None = None,
    reason: str | None = None,
    now: dt.datetime | None = None,
) -> InvResearchRun:
    """Close a running run as ``done`` or ``failed`` with the agent's counters (validated) merged
    under the server's (notes, signals, candidates, by_kind)."""
    assert profile.id is not None
    now = _now(now)
    row = run(session, profile.id, run_id)
    if row is None:
        raise ResearchNotFound(f"no research run {run_id} in this profile")
    if status not in ("done", "failed"):
        raise ResearchError("status must be done or failed")
    if row.status != "running":
        raise ResearchConflict(f"research run {run_id} is already {row.status}")
    try:
        agent_counts = validate_counts(counts)
    except ResearchInputError as e:
        raise ResearchError(str(e)) from None
    text = (reason or "").strip() or None
    if text is not None and len(text) > REASON_MAX:
        raise ResearchError(f"reason is too long (max {REASON_MAX} characters)")
    row.status = status
    row.finished_at = now
    row.counts = {**agent_counts, **run_counts(session, row)}
    if text is not None:
        row.counts["reason"] = text
    session.add(row)
    session.flush()
    housekeeping(session, profile, now=now)
    return row


# --------------------------------------------------------------------------- #
# Notes
# --------------------------------------------------------------------------- #


def note(session: Session, profile_id: int, note_id: int) -> InvResearchNote | None:
    row = session.get(InvResearchNote, note_id)
    return row if row is not None and row.profile_id == profile_id else None


def notes(
    session: Session,
    profile_id: int,
    *,
    instrument_id: int | None = None,
    theme: str | None = None,
    kinds: Iterable[str] | None = None,
    since: dt.datetime | None = None,
    run_id: int | None = None,
    include_dismissed: bool = False,
    include_expired: bool = False,
    now: dt.datetime | None = None,
    limit: int | None = None,
) -> list[InvResearchNote]:
    """The profile's notes, newest observation first (``since`` filters by storing time, for polling
    while a run is going)."""
    now = _now(now)
    query = select(InvResearchNote).where(InvResearchNote.profile_id == profile_id)
    if instrument_id is not None:
        query = query.where(InvResearchNote.instrument_id == instrument_id)
    wanted_kinds = list(kinds or [])
    if wanted_kinds:
        query = query.where(InvResearchNote.kind.in_(wanted_kinds))
    if since is not None:
        query = query.where(InvResearchNote.created_at >= convert.aware(since))
    if run_id is not None:
        query = query.where(InvResearchNote.run_id == run_id)
    if not include_dismissed:
        query = query.where(InvResearchNote.dismissed_at.is_(None))
    if not include_expired:
        query = query.where(InvResearchNote.expires_at > now)
    rows = list(
        session.exec(
            query.order_by(InvResearchNote.observed_at.desc(), InvResearchNote.id.desc())
        ).all()
    )
    if theme is not None:
        key = theme_key(theme)
        rows = [r for r in rows if r.theme and theme_key(r.theme) == key]
    return rows[:limit] if limit else rows


def _stored_theme(session: Session, profile_id: int, theme: str | None) -> str | None:
    """The spelling of ``theme`` already used in the profile (themes group case-insensitively)."""
    text = clean_theme(theme)
    if text is None:
        return None
    key = theme_key(text)
    for existing in session.exec(
        select(InvResearchNote.theme)
        .where(InvResearchNote.profile_id == profile_id, InvResearchNote.theme.is_not(None))
        .order_by(InvResearchNote.id)
    ).all():
        if existing and theme_key(existing) == key:
            return existing
    return text


def _cooldown(
    session: Session,
    profile_id: int,
    *,
    key: str | None,
    instrument_id: int | None,
    now: dt.datetime,
) -> InvResearchNote | None:
    query = select(InvResearchNote).where(
        InvResearchNote.profile_id == profile_id,
        InvResearchNote.kind == CANDIDATE_KIND,
        InvResearchNote.cooldown_until.is_not(None),
        InvResearchNote.cooldown_until > now,
    )
    for row in session.exec(query).all():
        if (key and row.candidate_key == key) or (
            instrument_id is not None and row.instrument_id == instrument_id
        ):
            return row
    return None


def _open_candidate(
    session: Session,
    profile_id: int,
    *,
    key: str | None,
    instrument_id: int | None,
    now: dt.datetime,
) -> InvResearchNote | None:
    for row in notes(session, profile_id, kinds=[CANDIDATE_KIND], now=now):
        if (row.details or {}).get("accepted_at"):
            continue
        if (key and row.candidate_key == key) or (
            instrument_id is not None and row.instrument_id == instrument_id
        ):
            return row
    return None


def _duplicate(
    session: Session,
    profile_id: int,
    data: NoteInput,
    instrument_id: int | None,
    theme: str | None,
    candidate_key: str | None,
    now: dt.datetime,
) -> InvResearchNote | None:
    first_url = data.sources[0].url if data.sources else None
    title = data.title.casefold()
    since = now - DUPLICATE_WINDOW
    rows = session.exec(
        select(InvResearchNote).where(
            InvResearchNote.profile_id == profile_id,
            InvResearchNote.created_at >= since,
        )
    ).all()
    tkey = theme_key(theme) if theme else None
    for row in rows:
        same_scope = (
            (instrument_id is not None and row.instrument_id == instrument_id)
            or (
                instrument_id is None
                and candidate_key is not None
                and row.candidate_key == candidate_key
            )
            or (
                instrument_id is None
                and candidate_key is None
                and tkey is not None
                and row.instrument_id is None
                and row.theme is not None
                and theme_key(row.theme) == tkey
            )
        )
        if not same_scope:
            continue
        row_urls = {s.get("url") for s in row.sources or []}
        if row.title.casefold() == title or (first_url and first_url in row_urls):
            return row
    return None


@dataclass
class AddedNote:
    note: InvResearchNote
    signal: research_signals.SyncResult | None = None
    warnings: list[str] = field(default_factory=list)


def _candidate_profile_match(
    session: Session, profile_id: int, key: str, held: set[int], watched: set[int]
) -> int | None:
    """A held or watched instrument whose symbol / ISIN / price alias equals ``key``."""
    loaded = instruments.load(session, held | watched, profile_id=profile_id)
    bare = key.split(".")[0].split(":")[0]
    for iid, inst in loaded.items():
        keys = _instrument_keys(inst)
        if key in keys or (inst.symbol and inst.symbol.upper() == bare):
            return iid
    return None


def add_note(
    session: Session,
    profile: Profile,
    data: NoteInput,
    *,
    instrument_id: int | None = None,
    run_id: int | None = None,
    now: dt.datetime | None = None,
    created_by: str = "agent",
) -> AddedNote:
    """Store a validated note (``instrument_id``: already resolved with :func:`resolve_reference`).
    Checks the run, the per-run limit, the scope (instrument / theme / candidate), the thesis relation
    (needs a thesis), candidate rules (new instruments only, the 90-day cooldown, one open proposal),
    duplicates (same scope with the same title or first source within 14 days). A qualifying note
    creates or joins the research signal of its instrument / theme and week."""
    assert profile.id is not None
    pid = profile.id
    now = _now(now)
    warnings: list[str] = []
    _fail_stale_runs(session, pid, now)
    if run_id is not None:
        run_row = run(session, pid, run_id)
        if run_row is None:
            raise ResearchNotFound(f"no research run {run_id} in this profile")
        if run_row.status != "running":
            raise ResearchConflict(
                f"research run {run_id} is {run_row.status}; start a new one (start_research_run)"
            )
    else:
        run_row = running_run(session, pid, now)
    if run_row is not None:
        stored = len(
            session.exec(
                select(InvResearchNote.id).where(InvResearchNote.run_id == run_row.id)
            ).all()
        )
        if stored >= MAX_NOTES_PER_RUN:
            raise ResearchConflict(f"a run holds at most {MAX_NOTES_PER_RUN} notes")

    theme = _stored_theme(session, pid, data.theme)
    held = held_instrument_ids(session, pid)
    watched = watched_instrument_ids(session, pid)
    candidate_key: str | None = None
    details = dict(data.details or {})
    if data.kind == CANDIDATE_KIND:
        if instrument_id is not None:
            if instrument_id in held or instrument_id in watched:
                raise ResearchConflict(
                    "that instrument is already held or watched; a candidate is a new instrument "
                    "(write a news / trend note instead)"
                )
            inst = instruments.load(session, {instrument_id}, profile_id=pid).get(instrument_id)
            candidate_key = ((inst.isin or inst.symbol) if inst else None) or str(instrument_id)
            candidate_key = candidate_key.upper()
        elif data.candidate is not None:
            candidate_key = data.candidate.key
            match = _candidate_profile_match(session, pid, candidate_key, held, watched)
            if match is not None:
                raise ResearchConflict(
                    "that instrument is already held or watched; a candidate is a new instrument"
                )
        else:
            raise ResearchError(
                "a candidate note names its instrument: candidate {symbol_or_isin, name}"
            )
        blocked = _cooldown(session, pid, key=candidate_key, instrument_id=instrument_id, now=now)
        if blocked is not None:
            until = aware(blocked.cooldown_until).date().isoformat()
            raise ResearchConflict(
                f"the owner dismissed this candidate (note {blocked.id}); do not propose it again "
                f"before {until}"
            )
        proposed = _open_candidate(
            session, pid, key=candidate_key, instrument_id=instrument_id, now=now
        )
        if proposed is not None:
            raise ResearchConflict(f"this candidate is already proposed (note {proposed.id})")
        if data.candidate is not None:
            details["candidate"] = data.candidate.as_json()
    else:
        if instrument_id is None and theme is None:
            raise ResearchError("a note is about an instrument (instrument) or a theme (theme)")
    if data.thesis_relation != "none":
        if instrument_id is None:
            raise ResearchError(
                "thesis_relation needs an instrument with a thesis (use none for theme notes)"
            )
        if not journal.theses(session, pid, instrument_id):
            raise ResearchError(
                "that instrument has no thesis: use thesis_relation none (see research_context)"
            )
    duplicate = _duplicate(session, pid, data, instrument_id, theme, candidate_key, now)
    if duplicate is not None:
        state = " (dismissed by the owner)" if duplicate.dismissed_at is not None else ""
        raise ResearchConflict(
            f"duplicate of note {duplicate.id}{state} (same scope, title or source)"
        )
    if instrument_id is not None and instrument_id not in held | watched:
        warnings.append("the instrument is neither held nor watched (it carries an alert)")

    observed = data.observed_at or now
    row = InvResearchNote(
        profile_id=pid,
        run_id=run_row.id if run_row is not None else None,
        instrument_id=instrument_id,
        theme=theme,
        kind=data.kind,
        polarity=data.polarity,
        strength=data.strength,
        thesis_relation=data.thesis_relation,
        thesis_field=data.thesis_field,
        title=data.title,
        summary=data.summary,
        sources=data.sources_json(),
        details=details or None,
        candidate_key=candidate_key,
        observed_at=observed,
        expires_at=observed + dt.timedelta(days=data.expires_in_days),
        created_by=created_by,
        created_at=now,
        updated_at=now,
        # the owner's own notes are born read; the agent's wait for the owner (F8 Q10)
        read_at=None if created_by == AGENT else now,
    )
    session.add(row)
    session.flush()
    result = AddedNote(row, warnings=warnings)
    key = research_signals.note_key(row)
    if key is not None and research_signals.severity_of(row, now) is not None:
        result.signal = research_signals.sync(session, profile, key, now=now)
        session.refresh(row)
    return result


# --------------------------------------------------------------------------- #
# Read marks (F8, home v3 Q10)
# --------------------------------------------------------------------------- #

AGENT = "agent"
MAX_READ_IDS = 500


def is_unread(row: InvResearchNote, now: dt.datetime) -> bool:
    """An agent note (not a candidate) the owner has not opened, still live (not dismissed, not
    expired)."""
    return (
        row.read_at is None
        and row.dismissed_at is None
        and convert.aware(row.expires_at) > convert.aware(now)
        and row.created_by == AGENT
        and row.kind != CANDIDATE_KIND
    )


def _unread_conditions(profile_id: int, now: dt.datetime) -> tuple:
    return (
        InvResearchNote.profile_id == profile_id,
        InvResearchNote.read_at.is_(None),
        InvResearchNote.dismissed_at.is_(None),
        InvResearchNote.expires_at > convert.aware(now),
        InvResearchNote.created_by == AGENT,
        InvResearchNote.kind != CANDIDATE_KIND,
    )


def _unread_query(profile_id: int, now: dt.datetime):
    return select(InvResearchNote).where(*_unread_conditions(profile_id, now))


def unread_notes(
    session: Session, profile_id: int, *, now: dt.datetime | None = None
) -> list[InvResearchNote]:
    return list(session.exec(_unread_query(profile_id, _now(now))).all())


def unread_by_instrument(
    session: Session, profile_id: int, *, now: dt.datetime | None = None
) -> dict[int, int]:
    """Instrument id -> number of its unread notes (instruments without any are absent); one grouped
    query (index ``ix_research_notes_unread``)."""
    query = (
        select(InvResearchNote.instrument_id, func.count(InvResearchNote.id))
        .where(*_unread_conditions(profile_id, _now(now)))
        .where(InvResearchNote.instrument_id.is_not(None))
        .group_by(InvResearchNote.instrument_id)
    )
    return {int(iid): int(n) for iid, n in session.exec(query).all()}


def mark_read(
    session: Session,
    profile: Profile,
    *,
    instrument_id: int | None = None,
    theme: str | None = None,
    ids: list[int] | None = None,
    now: dt.datetime | None = None,
) -> int:
    """Set ``read_at`` on the profile's unread notes of one instrument, one theme (case-insensitive)
    or the given ids (other profiles' and unknown ids are ignored); returns how many changed
    (idempotent). Exactly one selector. :class:`ResearchNotFound` for an instrument that is not the
    profile's, :class:`ResearchError` for a bad selector."""
    assert profile.id is not None
    now = _now(now)
    given = [x is not None for x in (instrument_id, theme, ids)]
    if sum(given) != 1:
        raise ResearchError("give exactly one of instrument_id, theme or ids")
    query = _unread_query(profile.id, now)
    key: str | None = None
    if instrument_id is not None:
        own_note = session.exec(
            select(InvResearchNote.id).where(
                InvResearchNote.profile_id == profile.id,
                InvResearchNote.instrument_id == instrument_id,
            )
        ).first()
        if own_note is None and instrument_id not in instruments.profile_instrument_ids(
            session, profile.id
        ):
            raise ResearchNotFound(f"no instrument {instrument_id} in this profile")
        query = query.where(InvResearchNote.instrument_id == instrument_id)
    elif theme is not None:
        text = clean_theme(theme)
        if text is None:
            raise ResearchError("theme must not be empty")
        key = theme_key(text)
        query = query.where(InvResearchNote.theme.is_not(None))
    else:
        wanted = list(ids or [])
        if not wanted or len(wanted) > MAX_READ_IDS:
            raise ResearchError(f"ids: give 1 to {MAX_READ_IDS} note ids")
        query = query.where(InvResearchNote.id.in_(wanted))
    marked = 0
    for row in session.exec(query).all():
        if key is not None and theme_key(row.theme or "") != key:
            continue
        row.read_at = now
        session.add(row)
        marked += 1
    session.flush()
    return marked


def dismiss(
    session: Session, profile: Profile, note_id: int, *, now: dt.datetime | None = None
) -> InvResearchNote:
    """Dismiss a note (idempotent): its signal resolves when no other note keeps it open
    (``odrzucono notatkę``); a dismissed candidate is not proposed again for 90 days."""
    assert profile.id is not None
    now = _now(now)
    row = note(session, profile.id, note_id)
    if row is None:
        raise ResearchNotFound(f"no research note {note_id} in this profile")
    if row.dismissed_at is not None:
        return row
    row.dismissed_at = now
    row.updated_at = now
    if row.kind == CANDIDATE_KIND:
        row.cooldown_until = now + CANDIDATE_COOLDOWN
    session.add(row)
    session.flush()
    key = research_signals.note_key(row)
    if key is not None and row.signal_id is not None:
        research_signals.sync(
            session, profile, key, now=now, reason=research_signals.CLOSED_DISMISSED
        )
    return row


def restore(
    session: Session, profile: Profile, note_id: int, *, now: dt.datetime | None = None
) -> InvResearchNote:
    """Undo a dismissal within :data:`RESTORE_WINDOW` (idempotent for a note that is not
    dismissed); the signal the dismissal resolved reopens (same row)."""
    assert profile.id is not None
    now = _now(now)
    row = note(session, profile.id, note_id)
    if row is None:
        raise ResearchNotFound(f"no research note {note_id} in this profile")
    if row.dismissed_at is None:
        return row
    if now - aware(row.dismissed_at) > RESTORE_WINDOW:
        raise UndoExpired(
            f"a dismissal can be undone for {RESEARCH_RESTORE_MINUTES} minutes after it"
        )
    row.dismissed_at = None
    row.cooldown_until = None
    row.updated_at = now
    session.add(row)
    session.flush()
    research_signals.reopen_dismissed(session, profile.id, row, now=now, window=RESTORE_WINDOW)
    key = research_signals.note_key(row)
    if key is not None and research_signals.severity_of(row, now) is not None:
        research_signals.sync(session, profile, key, now=now)
    return row


# --------------------------------------------------------------------------- #
# Candidates
# --------------------------------------------------------------------------- #


@dataclass
class AcceptResult:
    note: InvResearchNote
    watchlist_item_id: int
    thesis: InvThesis | None
    created_instrument: bool = False
    warnings: list[str] = field(default_factory=list)


def accept_candidate(
    session: Session, profile: Profile, note_id: int, *, now: dt.datetime | None = None
) -> AcceptResult:
    """``Obserwuj``: put the candidate on the watchlist (source user, note ``kandydat: <title>``; an
    instrument already watched is kept) and create a draft thesis with the candidate's entry type
    when the instrument has none, so the research keeps tracking it. Undo with :func:`undo_accept`
    within 15 minutes."""
    from ..service import watchlist as watch_service

    assert profile.id is not None
    pid = profile.id
    now = _now(now)
    row = note(session, pid, note_id)
    if row is None:
        raise ResearchNotFound(f"no research note {note_id} in this profile")
    if row.kind != CANDIDATE_KIND:
        raise ResearchConflict("only candidate notes can be accepted")
    if row.dismissed_at is not None:
        raise ResearchConflict("the candidate is dismissed; restore it first")
    details = dict(row.details or {})
    if details.get("accepted_at"):
        raise ResearchConflict("the candidate is already accepted")
    candidate = details.get("candidate") or {}
    watch_note = f"kandydat: {row.title}"[: watch_service.MAX_NOTE_LENGTH]
    created_item = False
    created_instrument = False
    warnings: list[str] = []
    try:
        if (
            row.instrument_id is not None
            and row.instrument_id in instruments.profile_instrument_ids(session, pid)
        ):
            existing = alert_store.watched_item_for(session, pid, row.instrument_id)
            if existing is not None:
                item_id, instrument_id = existing.id, existing.instrument_id
            else:
                added = watch_service.add(
                    session, profile, instrument_id=row.instrument_id, note=watch_note
                )
                item_id, instrument_id = added.item.id, added.item.instrument_id
                created_item = True
        else:
            symbol = candidate.get("symbol") or row.candidate_key
            if not symbol:
                raise ResearchError("the candidate has no symbol or ISIN to watch")
            try:
                added = watch_service.add(
                    session,
                    profile,
                    symbol,
                    name=candidate.get("name"),
                    currency=candidate.get("currency"),
                    exchange=candidate.get("exchange"),
                    note=watch_note,
                )
                item_id, instrument_id = added.item.id, added.item.instrument_id
                created_item, created_instrument = True, added.created_instrument
                warnings += added.warnings
            except watch_service.WatchlistConflict:
                resolved = watch_service.resolve_instrument(
                    session,
                    profile,
                    symbol,
                    name=candidate.get("name"),
                    currency=candidate.get("currency"),
                    exchange=candidate.get("exchange"),
                )
                existing = alert_store.watched_item_for(session, pid, resolved.instrument_id)
                assert existing is not None
                item_id, instrument_id = existing.id, existing.instrument_id
    except watch_service.WatchlistNotFound as e:
        raise ResearchNotFound(str(e)) from None
    except watch_service.WatchlistError as e:
        raise ResearchError(str(e)) from None

    thesis_row: InvThesis | None = None
    created_thesis = False
    existing_theses = journal.theses(session, pid, instrument_id)
    if existing_theses:
        thesis_row = existing_theses[0]
    else:
        thesis_row = journal.create_thesis(
            session,
            pid,
            instrument_id,
            {
                "entry_type": details.get("entry_type") or "trend",
                "thesis": (DRAFT_THESIS_PREFIX + row.title)[:500],
            },
        )
        created_thesis = True
    details.update(
        {
            "accepted_at": now.isoformat(),
            "watchlist_item_id": item_id,
            "thesis_id": thesis_row.id if thesis_row is not None else None,
            "created_watchlist_item": created_item,
            "created_thesis": created_thesis,
            "previous_instrument_id": row.instrument_id,
        }
    )
    row.details = details
    row.instrument_id = instrument_id
    row.updated_at = now
    session.add(row)
    session.flush()
    return AcceptResult(row, item_id, thesis_row, created_instrument, warnings)


def undo_accept(
    session: Session, profile: Profile, note_id: int, *, now: dt.datetime | None = None
) -> InvResearchNote:
    """Undo ``Obserwuj`` within 15 minutes: the watchlist item and the draft thesis it created go
    away (a thesis the owner edited since stays), the candidate is open again."""
    from ..models import InvWatchlistItem

    assert profile.id is not None
    pid = profile.id
    now = _now(now)
    row = note(session, pid, note_id)
    if row is None:
        raise ResearchNotFound(f"no research note {note_id} in this profile")
    details = dict(row.details or {})
    accepted = details.get("accepted_at")
    if row.kind != CANDIDATE_KIND or not accepted:
        raise ResearchConflict("the candidate is not accepted")
    if now - convert.aware(dt.datetime.fromisoformat(accepted)) > RESTORE_WINDOW:
        raise UndoExpired(f"accepting can be undone for {RESEARCH_RESTORE_MINUTES} minutes")
    if details.get("created_watchlist_item") and details.get("watchlist_item_id"):
        item = session.get(InvWatchlistItem, details["watchlist_item_id"])
        if item is not None and item.profile_id == pid:
            session.delete(item)
    if details.get("created_thesis") and details.get("thesis_id"):
        thesis_row = journal.thesis(session, pid, details["thesis_id"])
        untouched = thesis_row is not None and aware(thesis_row.updated_at) <= aware(
            thesis_row.created_at
        ) + dt.timedelta(seconds=1)
        if untouched and thesis_row.thesis.startswith(DRAFT_THESIS_PREFIX):
            journal.delete_thesis(session, thesis_row)
    row.instrument_id = details.get("previous_instrument_id")
    for key in (
        "accepted_at",
        "watchlist_item_id",
        "thesis_id",
        "created_watchlist_item",
        "created_thesis",
        "previous_instrument_id",
    ):
        details.pop(key, None)
    row.details = details or None
    row.updated_at = now
    session.add(row)
    session.flush()
    return row


# --------------------------------------------------------------------------- #
# Housekeeping
# --------------------------------------------------------------------------- #


def housekeeping(
    session: Session, profile: Profile, *, now: dt.datetime | None = None
) -> dict[str, int]:
    """Resolve research signals none of whose notes qualify any more (expired) and mark runs left
    running for :data:`RUN_STALE` as failed (interrupted). For the daily check; cheap when empty."""
    assert profile.id is not None
    now = _now(now)
    resolved = 0
    policy: frozenset | None = None
    for row in research_signals.open_research_rows(session, profile.id):
        notes_left = research_signals.candidate_for(
            row.dedup_key, research_signals._week_notes(session, profile.id, row.dedup_key), now
        )
        if notes_left is None:
            if policy is None:
                policy = research_signals.notify_policy(session, profile)
            research_signals.sync(session, profile, row.dedup_key, now=now, notify=policy)
            resolved += 1
    return {
        "research_signals_resolved": resolved,
        "research_runs_interrupted": _fail_stale_runs(session, profile.id, now),
    }


def covered_recently(
    session: Session, profile_id: int, at: dt.datetime, days: int = HEALTH_WINDOW_DAYS
) -> dict[int, dt.datetime]:
    """Instrument id -> the newest finish of a ``done`` run that covered it within ``days``."""
    since = convert.aware(at) - dt.timedelta(days=days)
    out: dict[int, dt.datetime] = {}
    for row in session.exec(
        select(InvResearchRun).where(
            InvResearchRun.profile_id == profile_id,
            InvResearchRun.status == "done",
            InvResearchRun.started_at >= since - dt.timedelta(days=1),
        )
    ).all():
        finished = aware(row.finished_at) or aware(row.started_at)
        if finished < since or finished > convert.aware(at):
            continue
        for iid in (row.scope or {}).get("covered_instrument_ids") or []:
            if isinstance(iid, int) and (iid not in out or out[iid] < finished):
                out[iid] = finished
    return out
