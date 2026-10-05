"""Workspace API.

Profile-scoped (``/api/p/{slug}`` only, no legacy alias):

- ``GET  /workspace``  status: path, exists, managed version, outdated items, skills,
  ``claude_command`` (``cd <path> && claude``)
- ``POST /workspace``  ``{path?, force?, routine_permissions?}`` create or update (also moves the
  workspace to ``path``; ``routine_permissions`` switches the opt-in rules of the unattended research
  routine: WebSearch, WebFetch, Edit of research/ and notes/);
  the status plus ``changes``. 422 invalid path, 409 another profile's folder or busy; the stable
  code rides in ``X-Finanse-Error-Code`` (``path_*``, ``translocated``, ``workspace_taken``, ``busy``,
  ``write_failed``; see ``service.WorkspaceError``).

Platform: ``GET /api/workspaces/default?name=`` the default folder of a profile about to be created
(the wizard).
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from ..api import CurrentProfile
from ..db import get_session
from . import service

router = APIRouter()
platform_router = APIRouter()


class WorkspaceRequest(BaseModel):
    path: str | None = None
    force: bool = False
    # Opt-in unattended research routine permissions; None keeps the stored choice.
    routine_permissions: bool | None = None


def _error(e: service.WorkspaceError) -> HTTPException:
    status = 409 if isinstance(e, service.WorkspaceTaken | service.WorkspaceBusy) else 422
    return HTTPException(
        status_code=status, detail=str(e), headers={"X-Finanse-Error-Code": e.code}
    )


@router.get("/workspace")
def get_workspace(profile: CurrentProfile) -> dict:
    with get_session() as s:
        try:
            return service.status(s, profile)
        except service.WorkspaceError as e:
            raise _error(e) from None


@router.post("/workspace")
def post_workspace(profile: CurrentProfile, body: WorkspaceRequest | None = None) -> dict:
    body = body or WorkspaceRequest()
    with get_session() as s:
        try:
            return service.apply(
                s,
                profile,
                path=body.path or None,
                force=body.force,
                routine=body.routine_permissions,
            )
        except service.WorkspaceError as e:
            raise _error(e) from None
        except OSError as e:
            raise HTTPException(
                status_code=422,
                detail=f"cannot write the workspace: {e.strerror or 'file system error'}",
                headers={"X-Finanse-Error-Code": "write_failed"},
            ) from None


@platform_router.get("/workspaces/default")
def workspace_default(name: str = "") -> dict:
    with get_session() as s:
        return service.default_for_name(s, name)
