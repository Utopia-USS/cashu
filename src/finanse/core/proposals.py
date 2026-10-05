"""Proposals: changes an agent suggested over MCP, applied only when the owner approves them in the app.

A proposal has a ``kind`` (``strategy``, ``custom_rule``, ``import``), a validated ``payload`` and a
status (``pending`` -> ``approved`` | ``rejected``; ``failed`` when approving could not apply it, with the
reason in ``result.error``). MCP write tools only *create* proposals; ``approve`` / ``reject`` are called
by the app's API (``core.agent_api``), never by MCP.

Each kind is a :class:`ProposalKind`: ``detail`` adds what the app shows before deciding (the strategy
diff, the custom rule's backtest, the import preview summary) and ``apply`` performs the change. The
investments kinds live in ``core.mcp.tools.investments_proposals`` and are loaded lazily (core never
imports module internals at import time).
"""

from __future__ import annotations

import importlib
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from sqlmodel import Session, select

from . import locks
from .agent_models import PROPOSAL_STATUSES, Proposal
from .db import get_session
from .models import Profile, utcnow

MAX_SUMMARY = 200
MAX_REASON = 4000

# Modules providing proposal kinds (each exports ``KINDS: tuple[ProposalKind, ...]``).
KIND_PROVIDERS = ("finanse.core.mcp.tools.investments_proposals",)


class ProposalError(ValueError):
    """The proposal is invalid or cannot be applied. The message is English and safe to show;
    ``code`` is a stable machine code the app can localize (``result.error_code``)."""

    def __init__(self, message: str, code: str = "invalid") -> None:
        super().__init__(message)
        self.code = code


class ProposalNotFound(LookupError):
    pass


class ProposalConflict(ProposalError):
    """The proposal is not pending any more."""

    def __init__(self, message: str, code: str = "not_pending") -> None:
        super().__init__(message, code)


@dataclass(frozen=True)
class ProposalKind:
    kind: str
    detail: Callable[[Session, Profile, Proposal], dict[str, Any]]
    """Extra fields for the app's detail view (diff, backtest, preview summary)."""
    apply: Callable[[Profile, Proposal], dict[str, Any]]
    """Perform the change (opens its own sessions); returns the ``result``; raises ProposalError."""
    discard: Callable[[Proposal], None] | None = None
    """Clean up after a rejection (e.g. the stored export file of an import)."""


_kinds: dict[str, ProposalKind] | None = None


def kinds() -> dict[str, ProposalKind]:
    global _kinds
    if _kinds is None:
        loaded: dict[str, ProposalKind] = {}
        for name in KIND_PROVIDERS:
            for k in importlib.import_module(name).KINDS:
                loaded[k.kind] = k
        _kinds = loaded
    return _kinds


def _pid(profile: Profile | int) -> int:
    return int(profile.id if isinstance(profile, Profile) else profile)


def create(
    session: Session,
    profile: Profile | int,
    kind: str,
    payload: dict[str, Any],
    *,
    summary: str,
    summary_params: dict[str, Any] | None = None,
    reason: str | None = None,
    source: str = "mcp",
) -> Proposal:
    """Store a pending proposal (the caller validated ``payload``). ``summary`` is one English line;
    ``summary_params`` its values for a localized line in the app (stored in the payload)."""
    if kind not in kinds():
        raise ProposalError(f"unknown proposal kind {kind!r}", "unknown_kind")
    reason = (reason or "").strip() or None
    if reason is not None and len(reason) > MAX_REASON:
        raise ProposalError(f"reason is too long (max {MAX_REASON} characters)", "too_long")
    row = Proposal(
        profile_id=_pid(profile),
        kind=kind,
        status="pending",
        summary=(summary or kind).strip()[:MAX_SUMMARY],
        reason=reason,
        payload=dict(payload) | {"summary_params": dict(summary_params or {})},
        result={},
        source=source,
        created_at=utcnow(),
    )
    session.add(row)
    session.flush()
    return row


def list_proposals(
    session: Session, profile: Profile | int, status: str | None = None, limit: int = 100
) -> list[Proposal]:
    query = select(Proposal).where(Proposal.profile_id == _pid(profile))
    if status:
        if status not in PROPOSAL_STATUSES:
            raise ProposalError(
                f"status must be one of: {', '.join(PROPOSAL_STATUSES)}", "invalid_status"
            )
        query = query.where(Proposal.status == status)
    limit = max(1, min(int(limit), 500))
    return list(
        session.exec(
            query.order_by(Proposal.created_at.desc(), Proposal.id.desc()).limit(limit)
        ).all()
    )


def get(session: Session, profile: Profile | int, proposal_id: int) -> Proposal:
    row = session.get(Proposal, proposal_id)
    if row is None or row.profile_id != _pid(profile):
        raise ProposalNotFound(f"No proposal {proposal_id} in this profile")
    return row


def _iso(value) -> str | None:
    return None if value is None else value.isoformat()


def proposal_dict(row: Proposal) -> dict[str, Any]:
    """List shape (no payload). ``summary`` is English; ``summary_code`` (= the kind) and
    ``summary_params`` let the app build a localized line."""
    return {
        "id": row.id,
        "kind": row.kind,
        "status": row.status,
        "summary": row.summary,
        "summary_code": row.kind,
        "summary_params": dict((row.payload or {}).get("summary_params") or {}),
        "reason": row.reason,
        "source": row.source,
        "created_at": _iso(row.created_at),
        "reviewed_at": _iso(row.reviewed_at),
        "result": dict(row.result or {}),
    }


def detail_dict(session: Session, profile: Profile, row: Proposal) -> dict[str, Any]:
    """Detail shape: the list shape plus the payload and the kind's extra fields."""
    out = proposal_dict(row) | {"payload": dict(row.payload or {})}
    kind = kinds().get(row.kind)
    if kind is not None:
        try:
            out |= kind.detail(session, profile, row)
        except ProposalError as e:
            out["detail_error"] = str(e)
    return out


def _lock_name(profile_id: int) -> str:
    return f"proposals-{profile_id}"


def approve(profile: Profile, proposal_id: int) -> Proposal:
    """Apply a pending proposal and mark it approved (``failed`` with the reason when it cannot be
    applied; the error is raised again for the API). Serialized per profile."""
    with locks.run_lock(_lock_name(profile.id), wait=30):
        with get_session() as s:
            row = get(s, profile, proposal_id)
            if row.status != "pending":
                raise ProposalConflict(f"Proposal {proposal_id} is {row.status}, not pending")
            kind = kinds().get(row.kind)
            if kind is None:
                raise ProposalError(f"unknown proposal kind {row.kind!r}", "unknown_kind")
        try:
            result = kind.apply(profile, row)
        except ProposalError as e:
            with get_session() as s:
                failed = get(s, profile, proposal_id)
                failed.status = "failed"
                failed.reviewed_at = utcnow()
                failed.result = {"error": str(e), "error_code": e.code}
                s.add(failed)
            raise
        with get_session() as s:
            done = get(s, profile, proposal_id)
            done.status = "approved"
            done.reviewed_at = utcnow()
            done.result = dict(result)
            s.add(done)
            s.flush()
            return done


def reject(
    session: Session, profile: Profile | int, proposal_id: int, note: str | None = None
) -> Proposal:
    row = get(session, profile, proposal_id)
    if row.status != "pending":
        raise ProposalConflict(f"Proposal {proposal_id} is {row.status}, not pending")
    row.status = "rejected"
    row.reviewed_at = utcnow()
    note = (note or "").strip()
    row.result = {"note": note[:MAX_REASON]} if note else {}
    session.add(row)
    session.flush()
    kind = kinds().get(row.kind)
    if kind is not None and kind.discard is not None:
        kind.discard(row)
    return row
