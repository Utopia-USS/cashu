"""Proposals: changes an agent suggested over MCP, applied only when the owner approves them in the app.

A proposal has a ``kind`` (``strategy``, ``custom_rule``, ``import``, ``budget_import``), a validated
``payload`` and a
status (``pending`` -> ``applying`` -> ``approved`` | ``failed``, or ``pending`` -> ``rejected``;
``failed`` carries the reason in ``result.error``). MCP write tools only *create* proposals; ``approve``
/ ``reject`` are called by the app's API (``core.agent_api``), never by MCP.

Approving and rejecting hold the same per-profile run lock (``proposals-<id>``, every process of the
data dir), so a rejection never races an approval: it waits for the running one (or answers busy), and
it never overwrites an applied approval or deletes a staged file while an approval reads it. While a
change is applied the proposal is ``applying`` (only possible under the lock; one found without the
lock held by an approval was interrupted by a crash and is closed out as ``failed``).

A kind's ``apply`` may return a :class:`Staged` change: its ``record`` step runs in the transaction
that marks the proposal approved (the strategy version and the status commit together), its
``publish`` step after that commit (atomic file writes), and when publishing fails ``undo`` reverts
the recorded rows in the transaction that marks the proposal failed.

Each kind is a :class:`ProposalKind`: ``detail`` adds what the app shows before deciding (the strategy
diff, the custom rule's backtest, the import preview summary) and ``apply`` performs the change. The
investments kinds live in ``core.mcp.tools.investments_proposals`` and are loaded lazily (core never
imports module internals at import time).
"""

from __future__ import annotations

import importlib
import logging
from collections.abc import Callable, Iterator
from contextlib import contextmanager, nullcontext
from dataclasses import dataclass
from typing import Any

from sqlmodel import Session, select

from . import locks
from .agent_models import PROPOSAL_STATUSES, Proposal
from .db import get_session
from .models import Profile, utcnow

MAX_SUMMARY = 200
MAX_REASON = 4000
APPROVE_WAIT = 30.0  # seconds an approval waits for another approval / rejection of the profile
REJECT_WAIT = 10.0  # seconds a rejection waits for a running approval, then "busy"
_log = logging.getLogger("finanse.proposals")

# Modules providing proposal kinds (each exports ``KINDS: tuple[ProposalKind, ...]``).
KIND_PROVIDERS = (
    "finanse.core.mcp.tools.investments_proposals",
    "finanse.core.connectors.proposals",  # budget_import (fetch connector syncs, F10)
)


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


class ProposalBusy(ProposalError):
    """Another approval / rejection of the profile (or a job the change must not race, such as the
    daily check) holds the lock. Nothing was changed; the proposal is still pending."""

    def __init__(self, message: str = "another approval is running; try again in a moment") -> None:
        super().__init__(message, "busy")


@dataclass(frozen=True)
class Staged:
    """An ``apply`` result finished together with the approval (see the module docstring)."""

    result: dict[str, Any]
    record: Callable[[Session], dict[str, Any]] | None = None
    """Runs in the transaction that marks the proposal approved; returns more ``result`` fields."""
    publish: Callable[[], None] | None = None
    """Runs after that commit (e.g. atomic file writes); an exception fails the proposal."""
    undo: Callable[[Session], None] | None = None
    """Reverts what ``record`` stored, in the transaction that marks the proposal failed."""
    lock: str | None = None
    """A run lock held from ``record`` to the end of ``publish`` (another writer of the same data)."""
    lock_wait: float = 30.0


@dataclass(frozen=True)
class ProposalKind:
    kind: str
    detail: Callable[[Session, Profile, Proposal], dict[str, Any]]
    """Extra fields for the app's detail view (diff, backtest, preview summary)."""
    apply: Callable[[Profile, Proposal], dict[str, Any] | Staged]
    """Prepare / perform the change (opens its own sessions); returns the ``result`` or a
    :class:`Staged` change; raises ProposalError (ProposalBusy: nothing changed, still pending)."""
    discard: Callable[[Proposal], None] | None = None
    """Clean up after a rejection or a failed approval (e.g. the stored export of an import)."""


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
    from .api import utc_iso  # never naive (F7 FE1)

    return utc_iso(value)


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


@contextmanager
def _serialized(profile_id: int, wait: float, busy: str) -> Iterator[None]:
    """Hold the per-profile lock of approvals and rejections; ``ProposalBusy`` when it stays taken
    for ``wait`` seconds (a ``LockBusy`` raised inside the block passes through unchanged)."""
    entered = False
    try:
        with locks.run_lock(_lock_name(profile_id), wait=wait):
            entered = True
            yield
    except locks.LockBusy:
        if entered:
            raise
        raise ProposalBusy(busy) from None


INTERRUPTED = (
    "the approval was interrupted (the app stopped); check the result before proposing again"
)


def _recover(session: Session, profile_id: int) -> None:
    """Close out ``applying`` proposals left by a crash (call with the lock held: no approval of
    this profile is running then)."""
    for row in session.exec(
        select(Proposal).where(Proposal.profile_id == profile_id, Proposal.status == "applying")
    ).all():
        row.status = "failed"
        row.reviewed_at = utcnow()
        row.result = {"error": INTERRUPTED, "error_code": "interrupted"}
        session.add(row)
    session.flush()


def _move(profile: Profile, proposal_id: int, src: str, dst: str, result=None) -> bool:
    """Status ``src`` -> ``dst`` in its own transaction; False when the status was not ``src``
    (never overwrites another outcome)."""
    with get_session() as s:
        row = get(s, profile, proposal_id)
        if row.status != src:
            return False
        row.status = dst
        if dst != "pending":
            row.reviewed_at = utcnow()
        if result is not None:
            row.result = result
        s.add(row)
        return True


def _fail(profile: Profile, row: Proposal, kind: ProposalKind, message: str, code: str) -> None:
    if _move(profile, row.id, "applying", "failed", {"error": message, "error_code": code}):
        _discard(kind, row)


def _discard(kind: ProposalKind | None, row: Proposal) -> None:
    if kind is None or kind.discard is None:
        return
    try:
        kind.discard(row)
    except Exception:  # noqa: BLE001 - cleanup must never change the outcome
        _log.exception("discarding proposal %s failed", row.id)


def approve(profile: Profile, proposal_id: int) -> Proposal:
    """Apply a pending proposal and mark it approved (``failed`` with the reason when it cannot be
    applied; the error is raised again for the API). Serialized per profile with ``reject``."""
    with _serialized(
        profile.id, APPROVE_WAIT, "another approval is running; try again in a moment"
    ):
        with get_session() as s:
            _recover(s, profile.id)
        with get_session() as s:
            row = get(s, profile, proposal_id)
            if row.status != "pending":
                raise ProposalConflict(f"Proposal {proposal_id} is {row.status}, not pending")
            kind = kinds().get(row.kind)
            if kind is None:
                raise ProposalError(f"unknown proposal kind {row.kind!r}", "unknown_kind")
            row.status = "applying"
            s.add(row)
        try:
            outcome = kind.apply(profile, row)
            staged = outcome if isinstance(outcome, Staged) else Staged(dict(outcome))
            return _finish(profile, row, kind, staged)
        except ProposalBusy:
            _move(profile, proposal_id, "applying", "pending")  # nothing was changed
            raise
        except ProposalError as e:
            _fail(profile, row, kind, str(e), e.code)
            raise
        except Exception as e:
            _log.exception("approving proposal %s failed", proposal_id)
            message = "approving failed unexpectedly (details are in the app's log)"
            _fail(profile, row, kind, message, "apply_failed")
            raise ProposalError(message, "apply_failed") from e


def _finish(profile: Profile, row: Proposal, kind: ProposalKind, staged: Staged) -> Proposal:
    """Record + mark approved in one transaction, then publish; a failed publish undoes the record
    and marks the proposal failed."""
    try:
        guard = locks.run_lock(staged.lock, wait=staged.lock_wait) if staged.lock else nullcontext()
        with guard:
            with get_session() as s:
                done = get(s, profile, row.id)
                if done.status != "applying":  # pragma: no cover - impossible under the lock
                    raise ProposalConflict(f"Proposal {row.id} is {done.status}, not applying")
                extra = staged.record(s) if staged.record is not None else {}
                done.status = "approved"
                done.reviewed_at = utcnow()
                done.result = dict(staged.result) | dict(extra or {})
                s.add(done)
                s.flush()
            if staged.publish is not None:
                try:
                    staged.publish()
                except Exception as e:
                    _log.exception("publishing proposal %s failed", row.id)
                    message = "the files could not be written; nothing was changed"
                    with get_session() as s:
                        if staged.undo is not None:
                            staged.undo(s)
                        failed = get(s, profile, row.id)
                        failed.status = "failed"
                        failed.result = {"error": message, "error_code": "write_failed"}
                        s.add(failed)
                    _discard(kind, row)
                    raise ProposalError(message, "write_failed") from e
            return done
    except locks.LockBusy:
        raise ProposalBusy(
            "a background job is changing the same data; try again in a minute"
        ) from None


def reject(profile: Profile | int, proposal_id: int, note: str | None = None) -> Proposal:
    """Reject a pending proposal (waits up to ``REJECT_WAIT`` for a running approval, then
    ``ProposalBusy``); its staged files are removed after the rejection is committed."""
    pid = _pid(profile)
    with _serialized(pid, REJECT_WAIT, "an approval is running; try again in a moment"):
        with get_session() as s:
            _recover(s, pid)
        with get_session() as s:
            row = get(s, pid, proposal_id)
            if row.status != "pending":
                raise ProposalConflict(f"Proposal {proposal_id} is {row.status}, not pending")
            row.status = "rejected"
            row.reviewed_at = utcnow()
            note = (note or "").strip()
            row.result = {"note": note[:MAX_REASON]} if note else {}
            s.add(row)
            s.flush()
        _discard(kinds().get(row.kind), row)
        return row
