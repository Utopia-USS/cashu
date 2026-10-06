"""Audit log of MCP calls (``mcp_calls``): tool, profile, privacy level, time, outcome, duration and
the argument *names* with their JSON types. Argument values are never stored: they may be paths,
merchant names or strategy text. Shown in Settings > Agent AI (``GET /api/p/{slug}/mcp/calls``)."""

from __future__ import annotations

import logging
from typing import Any

from sqlmodel import Session, select

from ..agent_models import McpCall
from ..api import utc_iso
from ..db import get_session
from ..models import Profile, utcnow

_log = logging.getLogger(__name__)

OUTCOMES = ("ok", "error", "refused", "started")  # started: logged, outcome not recorded


def json_type(value: Any) -> str:
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "boolean"
    if isinstance(value, int):
        return "integer"
    if isinstance(value, float):
        return "number"
    if isinstance(value, str):
        return "string"
    if isinstance(value, (list, tuple)):
        return "array"
    if isinstance(value, dict):
        return "object"
    return "other"


def summarize_args(arguments: dict[str, Any] | None, known: set[str]) -> dict[str, Any]:
    """``{name: json type}`` for the tool's declared arguments; unknown names are only counted (an
    agent-chosen key could itself carry data)."""
    out: dict[str, Any] = {}
    unknown = 0
    for name, value in (arguments or {}).items():
        if name in known:
            out[name] = json_type(value)
        else:
            unknown += 1
    if unknown:
        out["_unknown"] = unknown
    return out


class AuditUnavailable(RuntimeError):
    """The audit row could not be written: the call must not run."""


def start(profile_id: int, tool: str, args: dict[str, Any]) -> int:
    """Write the audit row of a call about to run (outcome ``started``); raises
    :class:`AuditUnavailable` when that is impossible (the server then refuses the call)."""
    try:
        with get_session() as s:
            if s.get(Profile, profile_id) is None:
                raise AuditUnavailable("profile missing")
            row = McpCall(
                profile_id=profile_id,
                tool=tool[:80],
                privacy="strict",
                called_at=utcnow(),
                args=args,
                outcome="started",
            )
            s.add(row)
            s.flush()
            return row.id
    except AuditUnavailable:
        raise
    except Exception as e:  # noqa: BLE001 - any database problem means: do not run the call
        _log.exception("could not write the MCP audit row")
        raise AuditUnavailable(str(type(e).__name__)) from None


def finish(
    call_id: int, privacy: str, outcome: str, error_kind: str | None, duration_ms: int
) -> None:
    """Complete the audit row. A failure here leaves the row as ``started`` (the call is still
    logged) and is reported on stderr."""
    try:
        with get_session() as s:
            row = s.get(McpCall, call_id)
            if row is None:
                return
            row.privacy = privacy
            row.outcome = outcome if outcome in OUTCOMES else "error"
            row.error_kind = error_kind
            row.duration_ms = max(0, int(duration_ms))
            s.add(row)
    except Exception:  # noqa: BLE001 - the answer is computed; the row already exists
        _log.exception("could not complete the MCP audit row")


def calls(session: Session, profile_id: int, limit: int = 100) -> list[McpCall]:
    limit = max(1, min(int(limit), 1000))
    return list(
        session.exec(
            select(McpCall)
            .where(McpCall.profile_id == profile_id)
            .order_by(McpCall.called_at.desc(), McpCall.id.desc())
            .limit(limit)
        ).all()
    )


def call_dict(row: McpCall) -> dict[str, Any]:
    return {
        "id": row.id,
        "tool": row.tool,
        "privacy": row.privacy,
        "called_at": utc_iso(row.called_at),
        "args": dict(row.args or {}),
        "outcome": row.outcome,
        "error_kind": row.error_kind,
        "duration_ms": row.duration_ms,
    }
