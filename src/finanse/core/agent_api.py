"""Agent layer API (profile-scoped, mounted under ``/api/p/{slug}`` only): proposals the owner approves
or rejects, weekly reviews, the MCP call audit log and the MCP connection snippet.

- ``GET  /proposals?status=&limit=``             list (newest first, no payload)
- ``GET  /proposals/{id}``                       payload + detail (strategy diff, rule backtest, import
  preview summary and converter script with its sha256)
- ``POST /proposals/{id}/approve``               apply it (409 not pending, 422 cannot apply: then
  ``failed`` with ``result.error``)
- ``POST /proposals/{id}/reject``  ``{note?}``
- ``GET  /reviews?module=&limit=``, ``POST /reviews`` ``{module, notes?}`` (201)
- ``GET  /mcp/calls?limit=``                     audit rows (argument names and types only)
- ``GET  /mcp``                                  server name, ``claude mcp add`` command, privacy, tools
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from . import locks, proposals, reviews
from .api import CurrentProfile
from .db import get_session

router = APIRouter()


def _404(e: Exception) -> HTTPException:
    return HTTPException(status_code=404, detail=str(e))


def _422(e: Exception) -> HTTPException:
    return HTTPException(status_code=422, detail=str(e), headers=_code(e))


def _code(e: Exception) -> dict[str, str]:
    """``detail`` stays an English string (the app shows it); the stable code rides in a header."""
    code = getattr(e, "code", None)
    return {"X-Finanse-Error-Code": code} if code else {}


# --------------------------------------------------------------------------- #
# Proposals
# --------------------------------------------------------------------------- #


@router.get("/proposals")
def list_proposals(
    profile: CurrentProfile, status: str | None = None, limit: int = 100
) -> list[dict]:
    with get_session() as s:
        try:
            rows = proposals.list_proposals(s, profile, status, limit)
        except proposals.ProposalError as e:
            raise _422(e) from None
        return [proposals.proposal_dict(r) for r in rows]


@router.get("/proposals/{proposal_id}")
def get_proposal(profile: CurrentProfile, proposal_id: int) -> dict:
    with get_session() as s:
        try:
            row = proposals.get(s, profile, proposal_id)
        except proposals.ProposalNotFound as e:
            raise _404(e) from None
        return proposals.detail_dict(s, profile, row)


@router.post("/proposals/{proposal_id}/approve")
def approve_proposal(profile: CurrentProfile, proposal_id: int) -> dict:
    try:
        row = proposals.approve(profile, proposal_id)
    except proposals.ProposalNotFound as e:
        raise _404(e) from None
    except proposals.ProposalConflict as e:
        raise HTTPException(status_code=409, detail=str(e), headers=_code(e)) from None
    except proposals.ProposalError as e:
        raise _422(e) from None
    except locks.LockBusy:
        raise HTTPException(
            status_code=409,
            detail="another approval is running",
            headers={"X-Finanse-Error-Code": "busy"},
        ) from None
    return proposals.proposal_dict(row)


class RejectBody(BaseModel):
    note: str | None = None


@router.post("/proposals/{proposal_id}/reject")
def reject_proposal(
    profile: CurrentProfile, proposal_id: int, body: RejectBody | None = None
) -> dict:
    with get_session() as s:
        try:
            row = proposals.reject(s, profile, proposal_id, body.note if body else None)
        except proposals.ProposalNotFound as e:
            raise _404(e) from None
        except proposals.ProposalConflict as e:
            raise HTTPException(status_code=409, detail=str(e), headers=_code(e)) from None
        return proposals.proposal_dict(row)


# --------------------------------------------------------------------------- #
# Reviews
# --------------------------------------------------------------------------- #


@router.get("/reviews")
def list_reviews(profile: CurrentProfile, module: str | None = None, limit: int = 50) -> list[dict]:
    with get_session() as s:
        return [reviews.review_dict(r) for r in reviews.list_reviews(s, profile, module, limit)]


class ReviewBody(BaseModel):
    module: str
    notes: str | None = None


def _module_stats(session, profile_id: int, module: str) -> dict[str, Any]:
    if module == "investments":
        from .mcp.tools.investments import investments_review_stats

        return {"source": "app"} | investments_review_stats(session, profile_id)
    return {"source": "app"}


@router.post("/reviews", status_code=201)
def create_review(profile: CurrentProfile, body: ReviewBody) -> dict:
    with get_session() as s:
        try:
            stats = _module_stats(s, profile.id, body.module) if body.module else {}
            row = reviews.mark_done(s, profile, body.module, body.notes, stats)
        except reviews.ReviewError as e:
            raise _422(e) from None
        return reviews.review_dict(row)


# --------------------------------------------------------------------------- #
# MCP audit and connection
# --------------------------------------------------------------------------- #


@router.get("/mcp/calls")
def mcp_calls(profile: CurrentProfile, limit: int = 100) -> list[dict]:
    from .mcp import audit

    with get_session() as s:
        return [audit.call_dict(r) for r in audit.calls(s, profile.id, limit)]


@router.get("/mcp")
def mcp_info(profile: CurrentProfile) -> dict:
    from . import profiles
    from .mcp.registry import all_tools

    with get_session() as s:
        enabled = set(profiles.enabled_modules(s, profile.id))
    tools = [
        {"name": t.name, "module": t.module, "write": t.write}
        for t in all_tools().values()
        if t.module == "core" or t.module in enabled
    ]
    return {
        "server_name": f"finanse-{profile.slug}",
        "command": f"finanse mcp --profile {profile.slug}",
        "claude_mcp_add": f"claude mcp add finanse-{profile.slug} -- finanse mcp --profile {profile.slug}",
        "privacy": profile.mcp_privacy,
        "tools": tools,
    }
