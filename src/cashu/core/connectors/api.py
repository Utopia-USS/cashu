"""Connector HTTP API. Every route sits under ``/api`` and is protected by ``LocalOnlyMiddleware`` (Host
check + per-launch token), like the rest of the API.

Global (``/api/connectors``, mounted once, not profile-scoped: a connector is code, not data):

- ``GET    /connectors``                         installed connectors (status re-checked from disk)
- ``GET    /connectors/{id}``                    manifest facts, files (size, sha256), hash, interpreter,
  status, the diff against the approved file list when ``changed``, the last 10 runs (with the redacted
  stderr tail: the owner's view, never MCP)
- ``GET    /connectors/{id}/files/{relpath}``    a text file for the code viewer (<= 200 KiB; 415 binary,
  413 too large)
- ``POST   /connectors/{id}/approve``  ``{content_sha256, interpreter_path}``: the server recomputes both,
  409 when either differs (the owner must look again). The only way to approve (no CLI, no MCP).
- ``GET    /connectors/{id}/runs?limit=20``     recorded runs, newest first (max 100), the owner's view
- ``GET    /connectors/{id}/diff/{relpath}``     unified diff (text, <= 200 KiB) of one file between the
  approved copy (``<data dir>/connectors/.approved/<id>/``) and the installed one
- ``POST   /connectors/{id}/disable``
- ``DELETE /connectors/{id}``                    removes the dir, the approved copy, bindings, their
  secrets and runs

Per profile (``/api/p/{slug}/connectors/bindings``, no legacy alias):

- ``GET    /connectors/bindings``, ``GET /connectors/bindings/{id}``
- ``POST   /connectors/bindings``  ``{account_id, connector_id, params?, secrets?, auto_commit?}`` (201)
- ``PUT    /connectors/bindings/{id}``  ``{params?, auto_commit?}``
- ``PUT    /connectors/bindings/{id}/secrets``  ``{secrets: {id: value | null}}``: write-only; answers
  only which secret ids are set
- ``POST   /connectors/bindings/{id}/check``     run ``check`` (credentials and reachability, no data)
- ``POST   /connectors/bindings/{id}/sync``      run ``fetch``, preview, then commit or store a proposal
  (``connectors.sync``); 409 ``connector_busy`` while another sync of the binding runs
- ``DELETE /connectors/bindings/{id}``           the binding and its secrets

Errors: ``detail`` is an English string (an object ``{message, params: {id: message}}`` for
``connector_params``), the stable code rides in ``X-Cashu-Error-Code`` (``not_found``,
``connector_invalid``, ``connector_changed``, ``connector_conflict``, ``connector_binding_exists``,
``connector_not_approved``, ``connector_params``, ``connector_busy``, ``connector_file_too_large``,
``connector_file_binary``, ``connector.keychain``).
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel, ConfigDict

from ..api import CurrentProfile
from ..db import get_session
from . import service

router = APIRouter(prefix="/connectors")  # global: mounted under /api
profile_router = APIRouter(prefix="/connectors")  # mounted under /api/p/{slug}


def _http(e: service.ConnectorError) -> HTTPException:
    detail: Any = str(e)
    if e.issues:
        detail = f"{detail}: {'; '.join(e.issues)}"
    if isinstance(e, service.ParamsError):
        detail = {"message": detail, "params": e.params}
    return HTTPException(status_code=e.status, detail=detail, headers={"X-Cashu-Error-Code": e.code})


def _secrets_error() -> HTTPException:
    return HTTPException(
        status_code=503,
        detail="the OS keychain is not available",
        headers={"X-Cashu-Error-Code": "connector.keychain"},
    )


# --------------------------------------------------------------------------- #
# Global: install registry and approval
# --------------------------------------------------------------------------- #


@router.get("")
def list_connectors() -> list[dict]:
    with get_session() as s:
        return service.list_connectors(s)


@router.get("/{connector_id}")
def get_connector(connector_id: str) -> dict:
    with get_session() as s:
        try:
            return service.detail_dict(s, connector_id)
        except service.ConnectorError as e:
            raise _http(e) from None


@router.get("/{connector_id}/files/{relpath:path}")
def get_connector_file(connector_id: str, relpath: str) -> PlainTextResponse:
    with get_session() as s:
        try:
            text = service.read_file(s, connector_id, relpath)
        except service.ConnectorError as e:
            raise _http(e) from None
    # Shown in a code viewer, never rendered: plain text, no sniffing.
    return PlainTextResponse(text, headers={"X-Content-Type-Options": "nosniff"})


@router.get("/{connector_id}/runs")
def connector_runs(connector_id: str, limit: int = 20) -> list[dict]:
    with get_session() as s:
        try:
            return service.list_runs(s, connector_id, limit)
        except service.ConnectorError as e:
            raise _http(e) from None


@router.get("/{connector_id}/diff/{relpath:path}")
def connector_diff(connector_id: str, relpath: str) -> PlainTextResponse:
    with get_session() as s:
        try:
            text = service.diff_file(s, connector_id, relpath)
        except service.ConnectorError as e:
            raise _http(e) from None
    return PlainTextResponse(text, headers={"X-Content-Type-Options": "nosniff"})


class ApproveBody(BaseModel):
    model_config = ConfigDict(extra="forbid")

    content_sha256: str
    interpreter_path: str


@router.post("/{connector_id}/approve")
def approve_connector(connector_id: str, body: ApproveBody) -> dict:
    try:
        return service.approve(connector_id, body.content_sha256, body.interpreter_path)
    except service.ConnectorError as e:
        raise _http(e) from None


@router.post("/{connector_id}/disable")
def disable_connector(connector_id: str) -> dict:
    try:
        return service.disable(connector_id)
    except service.ConnectorError as e:
        raise _http(e) from None


@router.delete("/{connector_id}")
def delete_connector(connector_id: str) -> dict:
    try:
        removed = service.remove(connector_id)
    except service.ConnectorError as e:
        raise _http(e) from None
    return {"ok": True, "bindings": removed.bindings, "secrets_left": removed.secrets_left}


# --------------------------------------------------------------------------- #
# Per profile: fetch bindings
# --------------------------------------------------------------------------- #


class BindingCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    account_id: int
    connector_id: str
    params: dict[str, Any] | None = None
    secrets: dict[str, str] | None = None
    auto_commit: bool = False


class BindingUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    params: dict[str, Any] | None = None
    auto_commit: bool | None = None


class SecretsBody(BaseModel):
    model_config = ConfigDict(extra="forbid")

    secrets: dict[str, str | None]


@profile_router.get("/bindings")
def list_bindings(profile: CurrentProfile) -> list[dict]:
    return service.list_bindings(profile)


@profile_router.get("/bindings/{binding_id}")
def get_binding(profile: CurrentProfile, binding_id: int) -> dict:
    try:
        return service.get_binding(profile, binding_id)
    except service.ConnectorError as e:
        raise _http(e) from None


@profile_router.post("/bindings", status_code=201)
def create_binding(profile: CurrentProfile, body: BindingCreate) -> dict:
    from .. import secrets

    try:
        return service.create_binding(
            profile, account_id=body.account_id, connector_id=body.connector_id,
            params=body.params, secrets=body.secrets, auto_commit=body.auto_commit,
        )
    except service.ConnectorError as e:
        raise _http(e) from None
    except secrets.SecretsError:
        raise _secrets_error() from None


@profile_router.put("/bindings/{binding_id}")
def update_binding(profile: CurrentProfile, binding_id: int, body: BindingUpdate) -> dict:
    try:
        return service.update_binding(
            profile, binding_id, params=body.params, auto_commit=body.auto_commit
        )
    except service.ConnectorError as e:
        raise _http(e) from None


@profile_router.put("/bindings/{binding_id}/secrets")
def put_binding_secrets(profile: CurrentProfile, binding_id: int, body: SecretsBody) -> dict:
    from .. import secrets

    try:
        return {"secrets_set": service.set_binding_secrets(profile, binding_id, body.secrets)}
    except service.ConnectorError as e:
        raise _http(e) from None
    except secrets.SecretsError:
        raise _secrets_error() from None


@profile_router.post("/bindings/{binding_id}/check")
def check_binding(profile: CurrentProfile, binding_id: int) -> dict:
    try:
        result = service.check_binding(profile, binding_id)
    except service.ConnectorError as e:
        raise _http(e) from None
    return service.run_dict(result) | {"stderr_tail": result.stderr_tail}


@profile_router.post("/bindings/{binding_id}/sync")
def sync_binding(profile: CurrentProfile, binding_id: int) -> dict:
    """``{binding_id, connector_id, connector_name, module, account, run (run_dict + stderr_tail),
    since, preview {new, duplicates, warnings, blocking, ...} | null, proposal_id | null,
    committed {inserted, duplicates, batch_id} | null, problem {code, message} | null}``."""
    from . import sync

    try:
        return sync.sync_binding(profile, binding_id).owner_dict()
    except service.ConnectorError as e:
        raise _http(e) from None


@profile_router.delete("/bindings/{binding_id}")
def delete_binding(profile: CurrentProfile, binding_id: int) -> dict:
    try:
        removed = service.delete_binding(profile, binding_id)
    except service.ConnectorError as e:
        raise _http(e) from None
    return {"ok": True, "secrets_left": removed.secrets_left}
