"""JSON views of the research layer for the API (and the inputs of the MCP tools): note and run dicts,
the summary (thesis health per position, relation counts, 8-week sentiment and direction per
instrument and theme, last researched) and the review-digest block. Shapes: the CONTRACT in
``stock/docs/fork/progress/F6-RS.md``.
"""

from __future__ import annotations

import datetime as dt
from collections import defaultdict
from collections.abc import Iterable

from sqlmodel import Session, select

from finanse.core.models import Profile, utcnow

from ..domain import Instrument
from ..models import RESEARCH_NOTE_TTL_DAYS, InvResearchNote, InvResearchRun, InvSignal, InvThesis
from ..store import convert, instruments, journal
from . import service
from .keys import is_research_key
from .scoring import (
    CANDIDATE_KIND,
    HEALTH_WINDOW_DAYS,
    SENTIMENT_WEEKS,
    Health,
    HealthResult,
    ScoredNote,
    direction,
    health_rank,
    iso_week,
    sentiment_weeks,
    theme_key,
    thesis_health,
    week_starts,
    window_notes,
)

HISTORY_DAYS = 7 * SENTIMENT_WEEKS + HEALTH_WINDOW_DAYS + 7
"""How far back notes are loaded for summaries (8 weeks of sentiment + the health window)."""


def iso(value: dt.date | dt.datetime | None) -> str | None:
    return None if value is None else value.isoformat()


def _aware(value: dt.datetime | None) -> dt.datetime | None:
    return None if value is None else convert.aware(value)


def scored(row: InvResearchNote) -> ScoredNote:
    return ScoredNote(
        id=row.id,
        kind=row.kind,
        polarity=row.polarity,
        strength=row.strength,
        thesis_relation=row.thesis_relation,
        observed_at=convert.aware(row.observed_at),
        created_at=convert.aware(row.created_at),
        expires_at=convert.aware(row.expires_at),
        dismissed_at=_aware(row.dismissed_at),
        thesis_field=row.thesis_field,
    )


def instrument_brief(inst: Instrument | None) -> dict | None:
    if inst is None:
        return None
    return {
        "id": convert.maybe_pk(inst.id),
        "label": inst.label,
        "symbol": inst.symbol,
        "name": inst.name,
        "isin": inst.isin,
        "currency": str(inst.currency),
        "asset_class": inst.asset_class.value,
    }


# --------------------------------------------------------------------------- #
# Runs
# --------------------------------------------------------------------------- #


def run_dict(
    session: Session, row: InvResearchRun | None, now: dt.datetime | None = None
) -> dict | None:
    if row is None:
        return None
    now = convert.aware(now or utcnow())
    stale = service.is_stale(session, row, now)
    counts = dict(row.counts or {})
    live = service.run_counts(session, row)
    scope = dict(row.scope or {})
    started, finished = _aware(row.started_at), _aware(row.finished_at)
    return {
        "id": row.id,
        "status": "failed" if stale else row.status,
        "interrupted": stale or counts.get("reason") == "interrupted",
        "reason": counts.get("reason") or ("interrupted" if stale else None),
        "started_at": iso(started),
        "finished_at": iso(finished),
        "duration_s": int((finished - started).total_seconds()) if finished and started else None,
        "scheduled": bool(scope.get("scheduled")),
        "scope": {
            "held": bool(scope.get("held", True)),
            "watchlist": bool(scope.get("watchlist", True)),
            "candidates": bool(scope.get("candidates", True)),
            "themes": list(scope.get("themes") or []),
            "instrument_ids": list(scope.get("instrument_ids") or []),
            "covered_instrument_ids": list(scope.get("covered_instrument_ids") or []),
        },
        "counts": {**counts, **live},
        "notes": live["notes"],
        "signals": live["signals"],
        "created_by": row.created_by,
    }


def runs_view(session: Session, profile: Profile, limit: int = 20) -> list[dict]:
    assert profile.id is not None
    now = convert.aware(utcnow())
    return [run_dict(session, r, now) for r in service.runs(session, profile.id, limit)]


# --------------------------------------------------------------------------- #
# Notes
# --------------------------------------------------------------------------- #


def note_dict(
    row: InvResearchNote,
    *,
    insts: dict[int, Instrument] | None = None,
    signals: dict[int, InvSignal] | None = None,
    held: set[int] | None = None,
    watched: set[int] | None = None,
    now: dt.datetime | None = None,
) -> dict:
    now = convert.aware(now or utcnow())
    details = dict(row.details or {})
    candidate = details.pop("candidate", None)
    accepted = {
        "accepted_at": details.pop("accepted_at", None),
        "watchlist_item_id": details.pop("watchlist_item_id", None),
        "thesis_id": details.pop("thesis_id", None),
    }
    for key in ("created_watchlist_item", "created_thesis", "previous_instrument_id"):
        details.pop(key, None)
    signal = (signals or {}).get(row.signal_id) if row.signal_id is not None else None
    dismissed = _aware(row.dismissed_at)
    expires = convert.aware(row.expires_at)
    inst = (insts or {}).get(row.instrument_id) if row.instrument_id is not None else None
    return {
        "id": row.id,
        "run_id": row.run_id,
        "kind": row.kind,
        "polarity": row.polarity,
        "strength": row.strength,
        "thesis_relation": row.thesis_relation,
        "thesis_field": row.thesis_field,
        "title": row.title,
        "summary": row.summary,
        "sources": [
            {
                "title": s.get("title"),
                "url": s.get("url"),
                "publisher": s.get("publisher"),
                "published_at": s.get("published_at"),
            }
            for s in row.sources or []
        ],
        "instrument_id": row.instrument_id,
        "instrument": instrument_brief(inst),
        "theme": row.theme,
        "candidate": None
        if row.kind != CANDIDATE_KIND
        else {
            "symbol": (candidate or {}).get("symbol") or (inst.symbol if inst else None),
            "name": (candidate or {}).get("name") or (inst.name if inst else None),
            "exchange": (candidate or {}).get("exchange"),
            "currency": (candidate or {}).get("currency"),
            "key": row.candidate_key,
            **accepted,
        },
        "details": details or None,
        "signal_id": row.signal_id,
        "signal": None
        if signal is None
        else {"id": signal.id, "status": signal.status, "severity": signal.severity},
        "held": row.instrument_id in (held or set()) if row.instrument_id is not None else False,
        "watched": row.instrument_id in (watched or set())
        if row.instrument_id is not None
        else False,
        "observed_at": iso(_aware(row.observed_at)),
        "expires_at": iso(expires),
        "expired": expires <= now,
        "created_by": row.created_by,
        "created_at": iso(_aware(row.created_at)),
        "dismissed": dismissed is not None,
        "dismissed_at": iso(dismissed),
        "restorable_until": iso(dismissed + service.RESTORE_WINDOW) if dismissed else None,
        "cooldown_until": iso(_aware(row.cooldown_until)),
    }


def _context(session: Session, profile_id: int, rows: Iterable[InvResearchNote]) -> dict:
    rows = list(rows)
    ids = {r.instrument_id for r in rows if r.instrument_id is not None}
    signal_ids = {r.signal_id for r in rows if r.signal_id is not None}
    signals = (
        {
            s.id: s
            for s in session.exec(select(InvSignal).where(InvSignal.id.in_(signal_ids))).all()
            if s.profile_id == profile_id
        }
        if signal_ids
        else {}
    )
    return {
        "insts": instruments.load(session, ids, profile_id=profile_id),
        "signals": signals,
        "held": service.held_instrument_ids(session, profile_id),
        "watched": service.watched_instrument_ids(session, profile_id),
    }


def notes_view(session: Session, profile: Profile, rows: list[InvResearchNote]) -> list[dict]:
    assert profile.id is not None
    ctx = _context(session, profile.id, rows)
    now = convert.aware(utcnow())
    return [note_dict(r, now=now, **ctx) for r in rows]


def one_note(session: Session, profile: Profile, row: InvResearchNote) -> dict:
    return notes_view(session, profile, [row])[0]


# --------------------------------------------------------------------------- #
# Summary
# --------------------------------------------------------------------------- #


def _recent_notes(session: Session, profile_id: int, since: dt.datetime) -> list[InvResearchNote]:
    return list(
        session.exec(
            select(InvResearchNote).where(
                InvResearchNote.profile_id == profile_id,
                InvResearchNote.observed_at >= since,
            )
        ).all()
    )


def _theses_by_instrument(session: Session, profile_id: int) -> dict[int, InvThesis]:
    out: dict[int, InvThesis] = {}
    for t in journal.theses(session, profile_id):  # newest first
        out.setdefault(t.instrument_id, t)
    return out


def _health(
    notes: list[ScoredNote],
    thesis: InvThesis | None,
    at: dt.datetime,
    covered_at: dt.datetime | None,
) -> HealthResult:
    if thesis is not None and convert.aware(thesis.created_at) > at:
        thesis = None  # the thesis did not exist yet at ``at``
    changed = None
    if thesis is not None:
        updated = convert.aware(thesis.updated_at)
        changed = updated if updated <= at else convert.aware(thesis.created_at)
    return thesis_health(
        notes,
        at,
        has_thesis=thesis is not None,
        thesis_changed_at=changed,
        researched=covered_at is not None,
    )


def _field_counts(notes: list[ScoredNote]) -> list[dict]:
    fields: dict[str, dict[str, int]] = {}
    for n in notes:
        if n.thesis_field and n.thesis_relation in (
            "supports",
            "weakens",
            "invalidates",
            "neutral",
        ):
            entry = fields.setdefault(
                n.thesis_field,
                {"supports": 0, "weakens": 0, "invalidates": 0, "neutral": 0},
            )
            entry[n.thesis_relation] += 1
    return [{"field": k, **v} for k, v in sorted(fields.items())]


def _latest(rows: list[InvResearchNote], now: dt.datetime) -> InvResearchNote | None:
    active = [
        r
        for r in rows
        if r.dismissed_at is None and convert.aware(r.expires_at) > now and r.kind != CANDIDATE_KIND
    ]
    if not active:
        return None
    return max(active, key=lambda r: (convert.aware(r.observed_at), r.id))


def _brief_note(row: InvResearchNote | None) -> dict | None:
    if row is None:
        return None
    return {
        "id": row.id,
        "title": row.title,
        "kind": row.kind,
        "polarity": row.polarity,
        "thesis_relation": row.thesis_relation,
        "observed_at": iso(_aware(row.observed_at)),
    }


def summary(
    session: Session,
    profile: Profile,
    *,
    positions: list[dict] | None = None,
    now: dt.datetime | None = None,
) -> dict:
    """Thesis health and sentiment per position (held, watched, or with notes) and per theme.
    ``positions``: rows of ``views.positions`` (for weights; loaded when None)."""
    assert profile.id is not None
    pid = profile.id
    now = convert.aware(now or utcnow())
    if positions is None:
        from ..service import views as inv_views

        positions = inv_views.positions(session, profile)["positions"]
    weights = {
        p["instrument"]["id"]: p.get("weight")
        for p in positions
        if isinstance(p.get("instrument", {}).get("id"), int)
    }
    held = set(weights)
    watched = service.watched_instrument_ids(session, pid)
    rows = _recent_notes(session, pid, now - dt.timedelta(days=HISTORY_DAYS))
    by_instrument: dict[int, list[InvResearchNote]] = defaultdict(list)
    for r in rows:
        if r.instrument_id is not None and r.kind != CANDIDATE_KIND:
            by_instrument[r.instrument_id].append(r)
    theses = _theses_by_instrument(session, pid)
    covered = service.covered_recently(session, pid, now)
    last_note_at: dict[int, dt.datetime] = {}
    for iid, created in session.exec(
        select(InvResearchNote.instrument_id, InvResearchNote.created_at).where(
            InvResearchNote.profile_id == pid, InvResearchNote.instrument_id.is_not(None)
        )
    ).all():
        moment = convert.aware(created)
        if iid not in last_note_at or last_note_at[iid] < moment:
            last_note_at[iid] = moment
    candidate_ids = set(by_instrument)
    ids = held | watched | candidate_ids
    loaded = instruments.load(session, ids, profile_id=pid)
    items = []
    for iid, inst in loaded.items():
        if not service.researchable(inst):
            continue
        own = by_instrument.get(iid, [])
        notes = [scored(r) for r in own]
        thesis = theses.get(iid)
        window = window_notes(notes, now)
        health = _health(notes, thesis, now, covered.get(iid) or (now if window else None))
        values = sentiment_weeks(notes, now)
        latest = _latest(own, now)
        researched = [t for t in (last_note_at.get(iid), covered.get(iid)) if t is not None]
        items.append(
            {
                "instrument_id": iid,
                "instrument": instrument_brief(inst),
                "label": inst.label,
                "held": iid in held,
                "watched": iid in watched,
                "weight": weights.get(iid),
                "has_thesis": thesis is not None,
                "entry_type": thesis.entry_type if thesis is not None else None,
                "health": health.state.value,
                "health_rank": health_rank(health.state),
                "counts": health.counts,
                "thesis_relation": health.relation,
                "note_ids": list(health.note_ids),
                "fields": _field_counts(
                    window_notes(
                        notes,
                        now,
                        since=convert.aware(thesis.updated_at) if thesis is not None else None,
                    )
                ),
                "latest_polarity": latest.polarity if latest is not None else None,
                "latest_note": _brief_note(latest),
                "notes": len(window),
                "sentiment_8w": values,
                "direction": direction(values).value,
                "last_researched_at": iso(max(researched)) if researched else None,
            }
        )
    items.sort(
        key=lambda x: (
            x["health_rank"],
            not x["held"],
            -(x["weight"] or 0),
            (x["label"] or "").casefold(),
        )
    )
    themes = _themes(rows, now)
    latest_run = service.latest_run(session, pid)
    running = service.running_run(session, pid, now)
    candidate_rows = [r for r in rows if r.kind == CANDIDATE_KIND]
    return {
        "as_of": now.date().isoformat(),
        "window_days": HEALTH_WINDOW_DAYS,
        "note_ttl_days": RESEARCH_NOTE_TTL_DAYS,
        "weeks": [iso_week(d) for d in week_starts(now.date())],
        "week_starts": [d.isoformat() for d in week_starts(now.date())],
        "last_run": run_dict(session, latest_run, now),
        "running": running is not None,
        "instruments": items,
        "themes": themes,
        "candidates": _candidate_counts(session, pid, now),
        "totals": {
            "notes_active": sum(
                1
                for r in rows
                if r.dismissed_at is None
                and convert.aware(r.expires_at) > now
                and r.kind != CANDIDATE_KIND
            ),
            "notes_this_week": sum(
                1
                for r in rows
                if r.dismissed_at is None
                and iso_week(convert.aware(r.created_at).date()) == iso_week(now.date())
            ),
            "candidates_open": sum(
                1
                for r in candidate_rows
                if r.dismissed_at is None
                and convert.aware(r.expires_at) > now
                and not (r.details or {}).get("accepted_at")
            ),
            "signals_open": _open_research_signals(session, pid),
        },
    }


def _open_research_signals(session: Session, profile_id: int) -> int:
    from ..store import signals as signal_store

    return sum(
        1
        for r in signal_store.open_signal_rows(session, profile_id)
        if is_research_key(r.dedup_key)
    )


def _candidate_counts(session: Session, profile_id: int, now: dt.datetime) -> dict:
    rows = session.exec(
        select(InvResearchNote).where(
            InvResearchNote.profile_id == profile_id, InvResearchNote.kind == CANDIDATE_KIND
        )
    ).all()
    open_ = accepted = cooldown = 0
    for r in rows:
        if (r.details or {}).get("accepted_at"):
            accepted += 1
        elif r.dismissed_at is not None:
            if r.cooldown_until is not None and convert.aware(r.cooldown_until) > now:
                cooldown += 1
        elif convert.aware(r.expires_at) > now:
            open_ += 1
    return {"open": open_, "accepted": accepted, "dismissed_in_cooldown": cooldown}


def _themes(rows: list[InvResearchNote], now: dt.datetime) -> list[dict]:
    groups: dict[str, list[InvResearchNote]] = defaultdict(list)
    for r in rows:
        if r.theme and r.kind != CANDIDATE_KIND:
            groups[theme_key(r.theme)].append(r)
    out = []
    for key, group in groups.items():
        notes = [scored(r) for r in group]
        values = sentiment_weeks(notes, now)
        latest = _latest(group, now)
        stored = [r for r in group if r.dismissed_at is None]
        if not stored:
            continue
        newest = max(stored, key=lambda r: (convert.aware(r.observed_at), r.id))
        out.append(
            {
                "theme": newest.theme,
                "key": key,
                "sentiment_8w": values,
                "direction": direction(values).value,
                "notes": sum(
                    1 for r in group if r.dismissed_at is None and convert.aware(r.expires_at) > now
                ),
                "instruments": sorted(
                    {r.instrument_id for r in stored if r.instrument_id is not None}
                ),
                "last_note": _brief_note(latest or newest),
                "last_observed_at": iso(convert.aware(newest.observed_at)),
            }
        )
    out.sort(key=lambda t: t["last_observed_at"] or "", reverse=True)
    return out


# --------------------------------------------------------------------------- #
# Review digest
# --------------------------------------------------------------------------- #


def _since_moment(since: dt.date | dt.datetime | None, now: dt.datetime) -> dt.datetime:
    if since is None:
        return now - dt.timedelta(days=7)
    if isinstance(since, dt.datetime):
        return convert.aware(since)
    return dt.datetime.combine(since, dt.time(), tzinfo=dt.UTC)


def research_digest(
    session: Session,
    profile_id: int,
    since: dt.date | dt.datetime | None = None,
    *,
    now: dt.datetime | None = None,
) -> dict:
    """The review digest's ``research`` block: what research found since the last review (``since``,
    a date = local midnight taken as UTC, or an aware timestamp; None = the last 7 days)."""
    now = convert.aware(now or utcnow())
    start = _since_moment(since, now)
    rows = _recent_notes(session, profile_id, min(start, now) - dt.timedelta(days=HISTORY_DAYS))
    new_rows = [r for r in rows if convert.aware(r.created_at) >= start]
    new_active = [r for r in new_rows if r.dismissed_at is None]
    counts = {"supports": 0, "weakens": 0, "invalidates": 0, "neutral": 0, "community": 0}
    by_kind: dict[str, int] = {}
    for r in new_active:
        by_kind[r.kind] = by_kind.get(r.kind, 0) + 1
        if r.thesis_relation in counts:
            counts[r.thesis_relation] += 1
        if r.kind == "community":
            counts["community"] += 1

    theses = _theses_by_instrument(session, profile_id)
    by_instrument: dict[int, list[InvResearchNote]] = defaultdict(list)
    for r in rows:
        if r.instrument_id is not None and r.kind != CANDIDATE_KIND:
            by_instrument[r.instrument_id].append(r)
    ids = set(theses) | set(by_instrument)
    loaded = instruments.load(session, ids, profile_id=profile_id)
    covered_now = service.covered_recently(session, profile_id, now)
    covered_then = service.covered_recently(session, profile_id, start)
    changed: list[dict] = []
    unchanged = 0
    for iid in sorted(ids):
        inst = loaded.get(iid)
        if not service.researchable(inst):
            continue
        notes = [scored(r) for r in by_instrument.get(iid, [])]
        thesis = theses.get(iid)
        if thesis is None:
            continue
        before = _health(
            notes,
            thesis,
            start,
            covered_then.get(iid) or (start if window_notes(notes, start) else None),
        )
        after = _health(
            notes,
            thesis,
            now,
            covered_now.get(iid) or (now if window_notes(notes, now) else None),
        )
        if before.state == after.state:
            unchanged += 1
            continue
        changed.append(
            {
                "instrument_id": iid,
                "label": inst.label if inst else None,
                "from": before.state.value,
                "to": after.state.value,
                "note_ids": list(after.note_ids or before.note_ids),
                "counts": after.counts,
            }
        )
    changed.sort(key=lambda c: (health_rank(c["to"]), c["label"] or ""))

    themes_changed = []
    groups: dict[str, list[InvResearchNote]] = defaultdict(list)
    for r in rows:
        if r.theme and r.kind != CANDIDATE_KIND:
            groups[theme_key(r.theme)].append(r)
    for key, group in groups.items():
        notes = [scored(r) for r in group]
        then_values, now_values = sentiment_weeks(notes, start), sentiment_weeks(notes, now)
        if not any(v is not None for v in now_values):
            continue
        then_dir, now_dir = direction(then_values), direction(now_values)
        if then_dir != now_dir:
            newest = max(group, key=lambda r: (convert.aware(r.observed_at), r.id))
            themes_changed.append(
                {
                    "theme": newest.theme,
                    "key": key,
                    "from": then_dir.value,
                    "to": now_dir.value,
                    "sentiment_8w": now_values,
                }
            )
    themes_changed.sort(key=lambda t: t["theme"].casefold())

    candidates = sorted(
        (
            r
            for r in new_active
            if r.kind == CANDIDATE_KIND and not (r.details or {}).get("accepted_at")
        ),
        key=lambda r: (convert.aware(r.created_at), r.id),
        reverse=True,
    )
    highlights = sorted(
        (
            r
            for r in new_active
            if r.kind != CANDIDATE_KIND
            and (
                r.signal_id is not None
                or r.strength >= 3
                or r.thesis_relation in ("invalidates", "weakens")
            )
        ),
        key=lambda r: (
            {"invalidates": 0, "weakens": 1}.get(r.thesis_relation, 2),
            -r.strength,
            -convert.aware(r.created_at).timestamp(),
        ),
    )
    runs_in_period = [
        r
        for r in session.exec(
            select(InvResearchRun).where(
                InvResearchRun.profile_id == profile_id, InvResearchRun.started_at >= start
            )
        ).all()
    ]
    signals_new = sum(
        1
        for s in session.exec(
            select(InvSignal).where(
                InvSignal.profile_id == profile_id,
                InvSignal.dedup_key.startswith("research:"),
                InvSignal.first_seen_at >= start,
            )
        ).all()
    )
    return {
        "since": iso(start),
        "run": run_dict(session, service.latest_run(session, profile_id), now),
        "ran_in_period": bool(runs_in_period),
        "runs_in_period": len(runs_in_period),
        "notes_count": len(new_active),
        "signals_count": signals_new,
        "counts": counts,
        "by_kind": by_kind,
        "theses_changed": changed,
        "theses_unchanged": unchanged,
        "themes_changed": themes_changed,
        "candidates": [r.id for r in candidates],
        "highlights": [r.id for r in highlights[:10]],
        "health_states": [h.value for h in Health],
    }
