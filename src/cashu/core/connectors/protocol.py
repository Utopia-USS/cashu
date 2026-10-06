"""The connector protocol (api_version 1): one JSON request on stdin, one JSON response on stdout.

Commands: ``detect`` (file kind: does this file look like mine?), ``convert`` (file kind: export file ->
import document), ``fetch`` (fetch kind: API -> import document + cursor), ``check`` (fetch kind: are the
credentials and the API reachable, no data). Exit code 0 = a response of the command's shape, exit code 1
= an ``{"error": {...}}`` object; anything else is a ``protocol`` failure. The pydantic models here are the
source of ``docs/schemas/connector-protocol.v1.json`` (scripts/gen_connector_schemas.py).
"""

from __future__ import annotations

import json
import math
from dataclasses import dataclass
from decimal import Decimal
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, ValidationError

API_VERSION = 1
COMMANDS = ("detect", "convert", "fetch", "check")
FILE_COMMANDS = ("detect", "convert")
FETCH_COMMANDS = ("fetch", "check")

MAX_STDOUT_BYTES = 64 * 1024 * 1024
MAX_CURSOR_CHARS = 4096
MAX_MESSAGE_CHARS = 500

# Error kinds a connector reports itself (exit code 1).
CONNECTOR_ERROR_KINDS = (
    "bad_file",
    "unsupported_version",
    "auth_failed",
    "rate_limited",
    "network",
    "upstream",
    "internal",
)
# Error kinds the app assigns.
APP_ERROR_KINDS = (
    "protocol",  # bad exit code, invalid JSON, wrong shape, oversize output
    "timeout",
    "sandbox_unavailable",  # no sandbox on this platform: nothing runs
    "spawn_failed",  # the process could not be started
    "not_approved",  # pending, changed or disabled: refused before anything runs
    "interpreter_changed",
    "missing",  # the installed directory is gone
    "bad_request",  # the app could not build the request (wrong extension, file too large)
)
ERROR_KINDS = CONNECTOR_ERROR_KINDS + APP_ERROR_KINDS

Command = Literal["detect", "convert", "fetch", "check"]
Module = Literal["investments", "budget"]


class _Model(BaseModel):
    """Responses: unknown keys and loosely typed values ("yes" for true) are a protocol error."""

    model_config = ConfigDict(extra="forbid", strict=True)


class _RequestModel(BaseModel):
    """Requests: a connector must ignore keys it does not know (later api versions only add keys)."""

    model_config = ConfigDict(extra="ignore")


# --------------------------------------------------------------------------- #
# Request
# --------------------------------------------------------------------------- #


class RequestFile(_RequestModel):
    path: str = Field(description="Absolute path of the input copy inside the run directory.")
    name: str = Field(description="The original file name (never its original location).")


class RequestAccount(_RequestModel):
    currency: str = Field(description="ISO 4217 currency of the target account.")
    label: str = Field(description="The account's display name.")


class Request(_RequestModel):
    """What the app writes to the connector's stdin."""

    api_version: Literal[1] = API_VERSION
    command: Command
    module: Module
    file: RequestFile | None = Field(default=None, description="detect / convert only.")
    account: RequestAccount | None = None
    params: dict[str, Any] = Field(default_factory=dict)
    secrets: dict[str, str] | None = Field(default=None, description="fetch / check only.")
    since: str | None = Field(default=None, description="fetch only: YYYY-MM-DD.")
    cursor: str | None = Field(default=None, description="fetch only: opaque, from the last fetch.")

    def to_bytes(self) -> bytes:
        data = self.model_dump(exclude_none=True)
        if self.command == "fetch":  # cursor is always present for fetch (null on the first one)
            data.setdefault("cursor", None)
        return json.dumps(data, ensure_ascii=False).encode("utf-8")


# --------------------------------------------------------------------------- #
# Responses
# --------------------------------------------------------------------------- #


class DetectResponse(_Model):
    match: bool
    confidence: Annotated[float, Field(ge=0, le=1)] = 1.0


class DocumentResponse(_Model):
    """``convert`` / ``fetch``: the import document in the module's format."""

    document: dict[str, Any] = Field(
        description="investments: cashu-import v1 JSON; budget: cashu-budget-import v1 JSON."
    )
    cursor: Annotated[str, StringConstraints(max_length=MAX_CURSOR_CHARS)] | None = Field(
        default=None, description="fetch only: opaque state handed back on the next fetch."
    )


class CheckResponse(_Model):
    ok: Literal[True]


class ErrorDetail(_Model):
    kind: Annotated[str, StringConstraints(pattern=r"^[a-z][a-z0-9_]{0,39}$")]
    message: str = ""


class ErrorResponse(_Model):
    """Exit code 1. ``message`` is shown to the owner only (it may contain data), never to MCP."""

    error: ErrorDetail


RESPONSE_MODELS: dict[str, type[BaseModel]] = {
    "detect": DetectResponse,
    "convert": DocumentResponse,
    "fetch": DocumentResponse,
    "check": CheckResponse,
}


class NonFiniteNumber(ValueError):
    """``NaN`` / ``Infinity`` / ``-Infinity`` (or a float overflowing to one) in a connector's stdout."""


def _no_constant(name: str) -> Any:
    raise NonFiniteNumber(name)


def _finite_float(text: str) -> float:
    value = float(text)
    if not math.isfinite(value):
        raise NonFiniteNumber(text)
    return value


def loads(text: str, *, exact: bool) -> Any:
    """Read a connector's stdout. ``exact`` (convert / fetch): every JSON number with a fraction or an
    exponent becomes a :class:`~decimal.Decimal` (never a binary float), integers stay Python ints of
    any size; otherwise (detect / check) a finite float. NaN / Infinity raise :class:`NonFiniteNumber`
    (a ``ValueError``)."""
    return json.loads(
        text, parse_float=Decimal if exact else _finite_float, parse_constant=_no_constant
    )


def _encode(value: Any, out: list[str]) -> None:
    if isinstance(value, Decimal):
        if not value.is_finite():
            raise NonFiniteNumber(str(value))
        out.append(str(value))  # the literal the connector wrote, as a JSON number
    elif isinstance(value, dict):
        out.append("{")
        for i, (key, item) in enumerate(value.items()):
            if i:
                out.append(",")
            out.append(json.dumps(str(key), ensure_ascii=False))
            out.append(":")
            _encode(item, out)
        out.append("}")
    elif isinstance(value, list | tuple):
        out.append("[")
        for i, item in enumerate(value):
            if i:
                out.append(",")
            _encode(item, out)
        out.append("]")
    else:
        out.append(json.dumps(value, ensure_ascii=False, allow_nan=False))


def document_bytes(document: dict) -> bytes:
    """A connector's document as UTF-8 JSON for the module importers, numbers kept exact (a
    :class:`~decimal.Decimal` from :func:`loads` is written back as the same JSON number)."""
    out: list[str] = []
    _encode(document, out)
    return "".join(out).encode("utf-8")


@dataclass(frozen=True, slots=True)
class Parsed:
    """Outcome of reading a finished process: either ``response`` or an error kind (+ message)."""

    response: BaseModel | None = None
    error_kind: str | None = None
    message: str | None = None


def parse_response(command: str, exit_code: int | None, stdout: bytes) -> Parsed:
    """Interpret the stdout of a process that exited by itself (timeouts are handled by the caller)."""
    if exit_code not in (0, 1):
        return Parsed(error_kind="protocol", message=f"exit code {exit_code}")
    try:
        data = loads(stdout.decode("utf-8"), exact=command in ("convert", "fetch"))
    except NonFiniteNumber:
        return Parsed(error_kind="protocol", message="stdout holds NaN or Infinity (not JSON numbers)")
    except (UnicodeDecodeError, ValueError, RecursionError):
        return Parsed(error_kind="protocol", message="stdout is not one UTF-8 JSON value")
    if not isinstance(data, dict):
        return Parsed(error_kind="protocol", message="stdout is not a JSON object")
    if exit_code == 1:
        try:
            error = ErrorResponse.model_validate(data).error
        except ValidationError:
            return Parsed(error_kind="protocol", message="exit code 1 without a valid error object")
        kind = error.kind if error.kind in CONNECTOR_ERROR_KINDS else "internal"
        return Parsed(error_kind=kind, message=error.message[:MAX_MESSAGE_CHARS])
    model = RESPONSE_MODELS[command]
    try:
        response = model.model_validate(data)
    except ValidationError as e:
        where = ", ".join(sorted({".".join(str(p) for p in err["loc"]) or "-" for err in e.errors()}))
        return Parsed(error_kind="protocol", message=f"{command} response has the wrong shape ({where})")
    if command == "convert" and isinstance(response, DocumentResponse) and response.cursor is not None:
        return Parsed(error_kind="protocol", message="convert must not return a cursor")
    if isinstance(response, DocumentResponse):
        try:
            document_bytes(response.document)  # it must go back to the importers as JSON
        except (ValueError, RecursionError):
            return Parsed(error_kind="protocol", message=f"{command} document cannot be read back")
    return Parsed(response=response)


def document_records(module: str, document: dict) -> int:
    """How many records a document holds (investments ``records``, budget ``transactions``)."""
    key = "records" if module == "investments" else "transactions"
    items = document.get(key)
    return len(items) if isinstance(items, list) else 0


__all__ = [
    "API_VERSION",
    "COMMANDS",
    "ERROR_KINDS",
    "MAX_STDOUT_BYTES",
    "CheckResponse",
    "DetectResponse",
    "DocumentResponse",
    "ErrorResponse",
    "Parsed",
    "Request",
    "RequestAccount",
    "RequestFile",
    "document_bytes",
    "document_records",
    "loads",
    "parse_response",
]
