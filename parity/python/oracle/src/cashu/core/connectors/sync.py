"""Fetch sync of a binding: run ``fetch``, preview the document, then commit it or store a proposal.

One sync (``sync_binding``; the app's per-binding ``Synchronizuj``, the module sync actions and the
worker job ``connectors.fetch``) holds the binding's run lock (``connector-binding-<id>``; a second
sync of the same binding answers busy) and goes:

1. ``fetch`` (``service.run_fetch``): the attempt is recorded on the binding before the process
   starts; a ``rate_limited`` answer sets ``backoff_until`` (48 h). No database transaction is open
   while the connector runs.
2. Preview with the module's import service (investments: the canonical importer over the document;
   budget: ``from_document`` into the bound account), read-only.
3. Decide:
   - blocking problems: nothing is stored, the cursor stays (the owner sees the problem);
   - no new records: nothing to import; once the binding has an approved commit, the new cursor is
     saved (the next fetch starts there), before that nothing is saved;
   - ``auto_commit`` AND the binding already had an owner-approved commit AND the preview is clean (no
     blocking issue, no warnings, only new records: duplicates are skipped by dedup, but no new
     instruments, renames, status changes or reconciliation mismatches) -> commit, save the cursor;
   - otherwise a pending proposal (investments kind ``import``, budget kind ``budget_import``) whose
     payload carries the new cursor and the binding's sync state at fetch time; approving it commits
     the stored document and saves the cursor unless the binding moved on meanwhile
     (``cursor_conflict``). The first sync of a binding is therefore always a proposal.

A binding has at most one pending sync proposal: while one waits for the owner, a sync runs nothing
(no fetch, no attempt recorded) and answers ``outcome: "pending_exists"`` with that proposal's id and
preview; the worker and the module sync actions skip the binding (``pending_exists``) without a new
notification. Every proposal stages its own document file (``<sha>-<token>.json``), so rejecting or
approving one never removes another's file.

The cursor and ``last_ok_at`` move together and only on a commit (direct or approved): ``since`` of
the next fetch is the day of the last committed fetch. Nothing here reaches MCP: connector messages
and stderr tails stay in the owner's app.
"""

from __future__ import annotations

import datetime as dt
import hashlib
import uuid
from dataclasses import dataclass, field
from typing import Any

from sqlmodel import col, select

from .. import locks
from ..agent_models import Proposal
from ..db import get_session
from ..models import Account, Profile, utcnow
from . import protocol as proto
from . import service
from .models import Connector, ConnectorBinding, ConnectorRun
from .runner import RunResult
from .sandbox import ConnectorSandbox

MIN_INTERVAL = dt.timedelta(hours=20)
RATE_LIMIT_BACKOFF = dt.timedelta(hours=48)
PROPOSAL_KINDS = {"investments": "import", "budget": "budget_import"}


class Busy(service.ConnectorError):
    status = 409
    code = "connector_busy"


def lock_name(binding_id: int) -> str:
    return f"connector-binding-{int(binding_id)}"


def stamp(value: dt.datetime | None) -> str | None:
    """A stored time as a comparable string (naive UTC: SQLite returns naive values)."""
    if value is None:
        return None
    if value.tzinfo is not None:
        value = value.astimezone(dt.UTC).replace(tzinfo=None)
    return value.isoformat()


def _aware(value: dt.datetime | None) -> dt.datetime | None:
    if value is None:
        return None
    return value if value.tzinfo is not None else value.replace(tzinfo=dt.UTC)


@dataclass
class SyncResult:
    binding_id: int
    run: RunResult | None  # None when nothing ran (``pending_exists``)
    since: str | None
    module: str
    connector_id: str
    connector_name: str
    account_label: str | None = None
    preview: dict[str, int] | None = None
    proposal_id: int | None = None
    committed: dict[str, Any] | None = None
    problem: dict[str, str] | None = None
    cursor_saved: bool = False
    outcome: str = "synced"  # synced | pending_exists (nothing ran: a proposal already waits)

    def owner_dict(self) -> dict[str, Any]:
        """The owner's view (the app): the run with its message and redacted stderr tail. Never MCP."""
        run = None
        if self.run is not None:
            run = service.run_dict(self.run) | {"stderr_tail": self.run.stderr_tail}
        return {
            "outcome": self.outcome,
            "binding_id": self.binding_id,
            "connector_id": self.connector_id,
            "connector_name": self.connector_name,
            "module": self.module,
            "account": self.account_label,
            "run": run,
            "since": self.since,
            "preview": self.preview,
            "proposal_id": self.proposal_id,
            "committed": self.committed,
            "problem": self.problem,
        }


@dataclass(frozen=True)
class _State:
    """The binding at fetch time (what a commit or an approval compares against)."""

    module: str
    connector_id: str
    connector_name: str
    account_id: int
    account_label: str
    auto_commit: bool
    has_commit: bool
    base_cursor: str | None
    base_ok_at: str | None


def _state(profile: Profile, binding_id: int) -> _State:
    with get_session() as s:
        row = s.get(ConnectorBinding, binding_id)
        if row is None or row.profile_id != profile.id:
            raise service.NotFound(f"no binding {binding_id}")
        connector = s.get(Connector, row.connector_id)
        if connector is None:
            raise service.NotFound(f"no connector {row.connector_id!r}")
        account = s.get(Account, row.account_id)
        return _State(
            connector.module,
            connector.id,
            connector.name,
            row.account_id,
            account.name if account is not None else str(row.account_id),
            row.auto_commit,
            row.last_ok_at is not None,
            row.cursor,
            stamp(row.last_ok_at),
        )


def has_commit(row: ConnectorBinding) -> bool:
    """The binding had an owner-approved commit (``last_ok_at`` moves only on a commit, and the
    first commit of a binding is always an approved proposal)."""
    return row.last_ok_at is not None


# --------------------------------------------------------------------------- #
# Cursor
# --------------------------------------------------------------------------- #


def save_cursor(
    session,
    binding_id: int,
    *,
    base_cursor: str | None,
    base_ok_at: str | None,
    cursor: str | None,
    fetched_at: dt.datetime | str,
) -> bool:
    """Move the binding's cursor and ``last_ok_at`` to this fetch, only when the binding is still where
    it was at fetch time (compare-and-set). False = gone or moved on meanwhile."""
    row = session.get(ConnectorBinding, binding_id)
    if row is None or row.cursor != base_cursor or stamp(row.last_ok_at) != base_ok_at:
        return False
    if isinstance(fetched_at, str):
        fetched_at = dt.datetime.fromisoformat(fetched_at)
    row.cursor = cursor
    row.last_ok_at = fetched_at
    row.updated_at = utcnow()
    session.add(row)
    return True


def _link_run(run_id: int | None, *, proposal_id: int | None = None, batch_ref: str | None = None) -> None:
    if run_id is None:
        return
    with get_session() as s:
        run = s.get(ConnectorRun, run_id)
        if run is None:
            return
        if proposal_id is not None:
            run.proposal_id = proposal_id
        if batch_ref is not None:
            run.batch_ref = batch_ref
        s.add(run)


def _backoff(binding_id: int, now: dt.datetime) -> None:
    with get_session() as s:
        row = s.get(ConnectorBinding, binding_id)
        if row is not None:
            row.backoff_until = now + RATE_LIMIT_BACKOFF
            row.updated_at = utcnow()
            s.add(row)


# --------------------------------------------------------------------------- #
# Sync
# --------------------------------------------------------------------------- #


def sync_binding(
    profile: Profile,
    binding_id: int,
    *,
    sandbox: ConnectorSandbox | None = None,
    now: dt.datetime | None = None,
) -> SyncResult:
    """One sync of a binding (see the module doc). Raises :class:`Busy` when another sync of the
    binding runs, ``service.NotFound`` for an unknown binding; a failing connector is a result."""
    try:
        with locks.run_lock(lock_name(binding_id)):
            return _sync(profile, binding_id, sandbox, now or utcnow())
    except locks.LockBusy:
        raise Busy("a sync of this binding is already running") from None


def pending_proposal(profile_id: int, binding_id: int) -> tuple[int, dict | None] | None:
    """The binding's sync proposal still waiting for the owner (pending or being applied): its id and
    stored preview. None when there is none."""
    with get_session() as s:
        rows = s.exec(
            select(Proposal)
            .where(
                Proposal.profile_id == profile_id,
                Proposal.source == "connector",
                col(Proposal.kind).in_(tuple(PROPOSAL_KINDS.values())),
                col(Proposal.status).in_(("pending", "applying")),
            )
            .order_by(col(Proposal.id))
        ).all()
        for row in rows:
            payload = row.payload or {}
            if int(payload.get("binding_id") or 0) == int(binding_id):
                return row.id, payload.get("preview")
    return None


def _sync(profile: Profile, binding_id: int, sandbox, now: dt.datetime) -> SyncResult:
    state = _state(profile, binding_id)
    waiting = pending_proposal(profile.id, binding_id)
    if waiting is not None:
        return SyncResult(
            binding_id, None, None, state.module, state.connector_id, state.connector_name,
            state.account_label, preview=waiting[1], proposal_id=waiting[0], outcome="pending_exists",
        )
    outcome = service.run_fetch(profile, binding_id, sandbox=sandbox)
    out = SyncResult(
        binding_id, outcome.result, outcome.since, state.module, state.connector_id,
        state.connector_name, state.account_label,
    )
    if outcome.result.error_kind == "rate_limited":
        _backoff(binding_id, now)
    if outcome.document is None:
        return out
    fetched_at = outcome.result.started_at
    content = proto.document_bytes(outcome.document)
    ctx = _Ctx(profile, binding_id, state, outcome.cursor, fetched_at, outcome.since, content, out)
    if state.module == "investments":
        _investments(ctx)
    else:
        _budget(ctx)
    return out


@dataclass
class _Ctx:
    profile: Profile
    binding_id: int
    state: _State
    cursor: str | None
    fetched_at: dt.datetime
    since: str
    content: bytes
    out: SyncResult
    sha: str = field(init=False)

    def __post_init__(self) -> None:
        self.sha = hashlib.sha256(self.content).hexdigest()

    def staged_name(self, prefix: str = "") -> str:
        """A staged document file of its own (never shared with another proposal)."""
        return f"{prefix}{self.sha}-{uuid.uuid4().hex[:12]}.json"

    @property
    def file_name(self) -> str:
        return f"{self.state.connector_id}-{self.fetched_at.date().isoformat()}.json"

    def save_cursor_now(self) -> bool:
        with get_session() as s:
            saved = save_cursor(
                s, self.binding_id, base_cursor=self.state.base_cursor,
                base_ok_at=self.state.base_ok_at, cursor=self.cursor, fetched_at=self.fetched_at,
            )
        self.out.cursor_saved = saved
        return saved

    def payload(self, staged: str, preview: dict) -> dict[str, Any]:
        """What a sync proposal carries (both kinds): the stored document, the cursor to save on
        approval and the binding's state at fetch time (the conflict check)."""
        return {
            "source": "connector",
            "connector_id": self.state.connector_id,
            "connector_name": self.state.connector_name,
            "binding_id": self.binding_id,
            "account_id": self.state.account_id,
            "account_label": self.state.account_label,
            "file_name": self.file_name,
            "file_sha256": self.sha,
            "staged": staged,
            "since": self.since,
            "cursor": self.cursor,
            "base_cursor": self.state.base_cursor,
            "base_ok_at": self.state.base_ok_at,
            "fetched_at": self.fetched_at.isoformat(),
            "run_id": self.out.run.run_id,
            "preview": preview,
        }


def _decide(ctx: _Ctx, *, new: int, clean: bool) -> str:
    """``nothing`` | ``commit`` | ``propose``."""
    if new == 0:
        if ctx.state.has_commit:
            ctx.save_cursor_now()
        return "nothing"
    if ctx.state.auto_commit and ctx.state.has_commit and clean:
        return "commit"
    return "propose"


def _investments(ctx: _Ctx) -> None:
    from cashu.core import proposals
    from cashu.modules.investments.importing import ImportFile
    from cashu.modules.investments.service import files, imports

    request = imports.ImportRequest(
        ImportFile(ctx.file_name, ctx.content),
        ctx.state.account_id,
        f"connector:{ctx.state.connector_id}",
        None,
        connector_name=ctx.state.connector_name,
        bound_account=True,
    )
    try:
        with get_session() as s:
            fresh = s.get(Profile, ctx.profile.id)
            pv = imports.preview(s, fresh, request)
    except imports.ImportFailure as e:
        ctx.out.problem = {"code": "import_failed", "message": str(e)}
        return
    plan = pv.plan
    recon = pv.reconciliation
    summary = {
        "new": plan.new_count if plan else 0,
        "duplicates": plan.duplicate_count if plan else 0,
        "warnings": len(pv.warnings),
        "blocking": len(pv.errors),
        "rows": len(plan.rows) if plan else 0,
        "positions": len(plan.positions) if plan else 0,
        "new_instruments": len(plan.new_instruments) if plan else 0,
    }
    ctx.out.preview = summary
    if not pv.can_commit:
        shown = "; ".join(str(e) for e in pv.errors[:5])
        ctx.out.problem = {"code": "import_blocked", "message": shown or "nothing to import"}
        return
    only_new = bool(plan) and not (
        plan.renames or plan.status_changes or plan.new_instruments
        or (recon is not None and recon.mismatches)
    )
    decision = _decide(ctx, new=summary["new"], clean=not pv.warnings and only_new)
    if decision == "commit":
        try:
            result = imports.commit(pv)
        except imports.ImportFailure as e:
            ctx.out.problem = {"code": "import_failed", "message": str(e)}
            return
        ctx.out.committed = {
            "inserted": result.inserted, "duplicates": result.duplicates, "batch_id": result.batch_id,
        }
        ctx.save_cursor_now()
        _link_run(ctx.out.run.run_id, batch_ref=f"investments:{result.batch_id}")
        return
    if decision != "propose":
        return
    target = files.imports_dir(ctx.profile.slug) / ".proposals" / ctx.staged_name()
    files.write_private(target, ctx.content)
    payload = ctx.payload(files.relative_to_data_dir(target), {
        "importer": request.importer,
        "can_commit": True,
        **{k: v for k, v in summary.items() if k != "blocking"},
        "errors": 0,
    }) | {"importer": request.importer, "mapping_yaml": None}
    label, name = ctx.state.account_label, ctx.state.connector_name
    with get_session() as s:
        row = proposals.create(
            s, ctx.profile.id, "import", payload,
            summary=f"Import into {label} (connector {name}): {summary['new']} new rows",
            summary_params={
                "account": label, "importer": request.importer, "connector": name,
                "new": summary["new"], "duplicates": summary["duplicates"],
            },
            source="connector",
        )
        ctx.out.proposal_id = row.id
    _link_run(ctx.out.run.run_id, proposal_id=ctx.out.proposal_id)


def _budget(ctx: _Ctx) -> None:
    from cashu.core import proposals
    from cashu.modules.budget import imports as budget_imports
    from cashu.modules.investments.service import files

    choice = f"connector:{ctx.state.connector_id}"
    target = files.imports_dir(ctx.profile.slug) / ".proposals" / ctx.staged_name("budget-")
    files.write_private(target, ctx.content)
    upload = budget_imports.Upload(ctx.sha, ctx.file_name, target)
    try:
        with get_session() as s:
            fresh = s.get(Profile, ctx.profile.id)
            pv = budget_imports.preview(
                s, fresh, upload, importer=choice, account_id=ctx.state.account_id
            )
    except budget_imports.ImportProblem as e:
        target.unlink(missing_ok=True)
        ctx.out.problem = {"code": e.code, "message": str(e)}
        if e.code == "import_empty":  # a fetch with nothing in it: no new records
            ctx.out.preview = {"new": 0, "duplicates": 0, "warnings": 0, "blocking": 0}
            ctx.out.problem = None
            _decide(ctx, new=0, clean=True)
        return
    counts = pv["counts"]
    summary = {
        "new": counts["new"],
        "duplicates": counts["duplicates"],
        "warnings": len(pv["warnings"]),
        "blocking": 0,
        "rows": counts["rows"],
        "skipped": counts["skipped"],
    }
    ctx.out.preview = summary
    decision = _decide(ctx, new=summary["new"], clean=not pv["warnings"] and not counts["skipped"])
    if decision == "commit":
        try:
            result = budget_imports.commit(
                get_session, ctx.profile, upload, importer=choice, account_id=ctx.state.account_id
            )
        except budget_imports.ImportProblem as e:
            target.unlink(missing_ok=True)
            ctx.out.problem = {"code": e.code, "message": str(e)}
            return
        ctx.out.committed = {
            "inserted": result["inserted"], "duplicates": result["duplicates"],
            "batch_id": result["batch_id"],
        }
        ctx.save_cursor_now()
        _link_run(ctx.out.run.run_id, batch_ref=f"budget:{result['batch_id']}")
        return
    if decision != "propose":
        target.unlink(missing_ok=True)
        return
    preview = {"new": summary["new"], "duplicates": summary["duplicates"], "warnings": summary["warnings"]}
    payload = ctx.payload(files.relative_to_data_dir(target), preview)
    label, name = ctx.state.account_label, ctx.state.connector_name
    with get_session() as s:
        row = proposals.create(
            s, ctx.profile.id, "budget_import", payload,
            summary=f"Statement import into {label} (connector {name}): {summary['new']} new transactions",
            summary_params={"account": label, "connector": name, "new": summary["new"]},
            source="connector",
        )
        ctx.out.proposal_id = row.id
    _link_run(ctx.out.run.run_id, proposal_id=ctx.out.proposal_id)


# --------------------------------------------------------------------------- #
# Approving a sync proposal (both kinds)
# --------------------------------------------------------------------------- #


def check_proposal(payload: dict[str, Any]) -> None:
    """Before a sync proposal is committed: the binding still exists, its connector is approved and
    the binding did not move on since the fetch. Raises ``ProposalError`` (codes ``binding_missing``,
    ``connector_not_approved``, ``cursor_conflict``)."""
    from cashu.core.proposals import ProposalError

    with get_session() as s:
        row = s.get(ConnectorBinding, int(payload.get("binding_id") or 0))
        if row is None or row.connector_id != payload.get("connector_id"):
            raise ProposalError("the connector binding was removed", "binding_missing")
        connector = s.get(Connector, row.connector_id)
        if connector is None or connector.status != "approved":
            raise ProposalError(
                "the connector is not approved; approve it in Settings first", "connector_not_approved"
            )
        if row.cursor != payload.get("base_cursor") or stamp(row.last_ok_at) != payload.get("base_ok_at"):
            raise ProposalError(
                "the account was synchronised after this proposal; run the sync again",
                "cursor_conflict",
            )


def record_approved(session, payload: dict[str, Any], proposal_id: int | None, batch_ref: str) -> dict:
    """In the approval transaction: save the cursor (compare-and-set) and link the run."""
    saved = save_cursor(
        session,
        int(payload.get("binding_id") or 0),
        base_cursor=payload.get("base_cursor"),
        base_ok_at=payload.get("base_ok_at"),
        cursor=payload.get("cursor"),
        fetched_at=payload.get("fetched_at") or utcnow().isoformat(),
    )
    run = session.get(ConnectorRun, payload.get("run_id")) if payload.get("run_id") else None
    if run is not None:
        run.batch_ref = batch_ref
        if proposal_id is not None:
            run.proposal_id = proposal_id
        session.add(run)
    return {"cursor_saved": saved}


# --------------------------------------------------------------------------- #
# Due bindings (worker, module sync actions)
# --------------------------------------------------------------------------- #


@dataclass(frozen=True)
class Due:
    binding_id: int
    connector_id: str
    reason: str | None  # None = due; else why it is skipped
    proposal_id: int | None = None  # pending_exists: the proposal that waits


def bindings_of(profile: Profile, module: str | None = None) -> list[tuple[ConnectorBinding, Connector]]:
    with get_session() as s:
        rows = s.exec(
            select(ConnectorBinding, Connector)
            .where(
                ConnectorBinding.profile_id == profile.id,
                ConnectorBinding.connector_id == Connector.id,
                Connector.kind == "fetch",
            )
            .order_by(ConnectorBinding.id)
        ).all()
        out = []
        for binding, connector in rows:
            if module is not None and connector.module != module:
                continue
            service.refresh(s, connector)
            out.append((binding, connector))
        return out


def due(profile: Profile, module: str | None, now: dt.datetime) -> list[Due]:
    """Every fetch binding of the profile (of ``module``) with why it is not due: connector not
    approved, a sync proposal of the binding waits for the owner, a secret missing, in backoff after a
    rate limit, or tried less than 20 h ago."""
    out = []
    for binding, connector in bindings_of(profile, module):
        reason = None
        backoff = _aware(binding.backoff_until)
        last = _aware(binding.last_run_at)
        waiting = pending_proposal(profile.id, binding.id) if connector.status == "approved" else None
        if connector.status != "approved":
            reason = "not_approved"
        elif waiting is not None:
            out.append(Due(binding.id, connector.id, "pending_exists", waiting[0]))
            continue
        elif backoff is not None and backoff > now:
            reason = "backoff"
        elif last is not None and last + MIN_INTERVAL > now:
            reason = "interval"
        else:
            ids = service.manifest_of(connector).secret_ids
            if ids and len(service.secrets_set(connector.id, profile.slug, binding.id, ids)) < len(ids):
                reason = "missing_secret"
        out.append(Due(binding.id, connector.id, reason))
    return out


def run_due(
    profile: Profile,
    module: str | None = None,
    *,
    now: dt.datetime | None = None,
    sandbox: ConnectorSandbox | None = None,
) -> list[SyncResult | Due]:
    """Sync every due binding (one failing binding never stops the others; a busy one is skipped).
    Returns a :class:`SyncResult` per synced binding and the :class:`Due` of every skipped one."""
    now = now or utcnow()
    out: list[SyncResult | Due] = []
    for item in due(profile, module, now):
        if item.reason is not None:
            out.append(item)
            continue
        try:
            result = sync_binding(profile, item.binding_id, sandbox=sandbox, now=now)
            if result.outcome == "pending_exists":  # proposed meanwhile (e.g. from the app)
                out.append(Due(item.binding_id, item.connector_id, "pending_exists", result.proposal_id))
            else:
                out.append(result)
        except Busy:
            out.append(Due(item.binding_id, item.connector_id, "busy"))
        except Exception:
            import logging

            logging.getLogger("cashu.connectors").exception("sync of binding %s failed", item.binding_id)
            out.append(Due(item.binding_id, item.connector_id, "failed"))
    return out


def summary_dicts(results: list[SyncResult | Due]) -> list[dict[str, Any]]:
    """Module sync actions: one owner-view line per binding (synced or skipped)."""
    out = []
    for r in results:
        if isinstance(r, SyncResult):
            out.append(r.owner_dict() | {"skipped": None})
        else:
            out.append({
                "binding_id": r.binding_id, "connector_id": r.connector_id, "skipped": r.reason,
                "proposal_id": r.proposal_id,
            })
    return out


__all__ = [
    "MIN_INTERVAL",
    "RATE_LIMIT_BACKOFF",
    "Busy",
    "SyncResult",
    "check_proposal",
    "due",
    "pending_proposal",
    "record_approved",
    "run_due",
    "save_cursor",
    "summary_dicts",
    "sync_binding",
]
