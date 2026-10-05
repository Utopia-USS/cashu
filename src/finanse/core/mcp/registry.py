"""Tool specs and the per-call context.

A tool provider module (``core/mcp/tools/<module>.py``) exports ``TOOLS: tuple[ToolSpec, ...]``. A
spec names its module (``core`` = always available, otherwise the tool is listed and callable only while
that module is enabled for the profile), an input schema (JSON Schema, no additional properties, never
a profile argument: the server serves one profile) and a handler ``(ctx, **arguments) -> labelled tree``.
Handlers raise :class:`ToolError` for problems the agent can fix (the message is scrubbed before it is
sent).
"""

from __future__ import annotations

import datetime as dt
import importlib
from collections.abc import Callable
from dataclasses import dataclass, field
from functools import cached_property
from typing import Any

from sqlmodel import Session

from ..models import Profile
from . import names

PROVIDERS = (
    "finanse.core.mcp.tools.core",
    "finanse.core.mcp.tools.budget",
    "finanse.core.mcp.tools.loans",
    "finanse.core.mcp.tools.investments",
    "finanse.core.mcp.tools.alerts",
)

MAX_STRING = 200_000  # strategy YAML / markdown are the longest arguments


class ToolError(Exception):
    """A problem the agent can fix (bad argument, missing data). ``kind`` is a fixed audit code."""

    def __init__(self, message: str, kind: str = "invalid") -> None:
        super().__init__(message)
        self.kind = kind


@dataclass(frozen=True)
class ToolSpec:
    name: str
    module: str  # "core" or a module id
    description: str
    handler: Callable[..., Any]
    properties: dict[str, dict] = field(default_factory=dict)
    required: tuple[str, ...] = ()
    write: bool = False
    refused: dict[str, str] = field(default_factory=dict)
    """Arguments that do not exist (any more), with the message telling the agent what to do
    instead (e.g. ``converter``: the app never runs scripts). Not part of the schema."""

    @property
    def input_schema(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": self.properties,
            "required": list(self.required),
            "additionalProperties": False,
        }


@dataclass
class ToolContext:
    """What a handler works with: one session (committed after the handler and the redaction
    succeed), the bound profile and the privacy level of this call."""

    session: Session
    profile: Profile
    privacy: str
    today: dt.date

    @property
    def profile_id(self) -> int:
        assert self.profile.id is not None
        return self.profile.id

    @property
    def strict(self) -> bool:
        return self.privacy != "amounts"

    @cached_property
    def guard(self) -> names.NameGuard:
        return names.collect(self.session, self.profile)

    @cached_property
    def account_labels(self) -> dict[int, str]:
        from .accounts import account_labels

        return account_labels(self.session, self.profile_id)


def all_tools() -> dict[str, ToolSpec]:
    out: dict[str, ToolSpec] = {}
    for provider in PROVIDERS:
        for spec in importlib.import_module(provider).TOOLS:
            if spec.name in out:
                raise RuntimeError(f"duplicate MCP tool {spec.name}")
            out[spec.name] = spec
    return out


_TYPES: dict[str, tuple[type, ...]] = {
    "string": (str,),
    "integer": (int,),
    "number": (int, float),
    "boolean": (bool,),
    "object": (dict,),
    "array": (list,),
}


def validate_arguments(spec: ToolSpec, arguments: dict[str, Any] | None) -> dict[str, Any]:
    """Check the arguments against the spec (names, types, enums, lengths); defaults filled in.
    Messages name the argument, never echo its value."""
    args = dict(arguments or {})
    for name in sorted(set(args) & set(spec.refused)):
        raise ToolError(spec.refused[name], "invalid_arguments")
    unknown = sorted(set(args) - set(spec.properties))
    if unknown:
        raise ToolError(
            f"unknown argument(s): {len(unknown)}; allowed: {', '.join(spec.properties) or 'none'}",
            "invalid_arguments",
        )
    for name in spec.required:
        if args.get(name) is None:
            raise ToolError(f"missing argument: {name}", "invalid_arguments")
    out: dict[str, Any] = {}
    for name, schema in spec.properties.items():
        if name not in args or args[name] is None:
            if "default" in schema:
                out[name] = schema["default"]
            continue
        value = args[name]
        kinds = schema.get("type", "string")
        allowed = _TYPES.get(kinds, (object,))
        if isinstance(value, bool) and kinds in ("integer", "number"):
            raise ToolError(f"argument {name} must be a {kinds}", "invalid_arguments")
        if not isinstance(value, allowed):
            raise ToolError(f"argument {name} must be a {kinds}", "invalid_arguments")
        if "enum" in schema and value not in schema["enum"]:
            raise ToolError(
                f"argument {name} must be one of: {', '.join(map(str, schema['enum']))}",
                "invalid_arguments",
            )
        if isinstance(value, str):
            limit = schema.get("maxLength", MAX_STRING)
            if len(value) > limit:
                raise ToolError(f"argument {name} is too long (max {limit})", "invalid_arguments")
        if kinds == "integer":
            lo, hi = schema.get("minimum"), schema.get("maximum")
            if (lo is not None and value < lo) or (hi is not None and value > hi):
                raise ToolError(f"argument {name} must be in [{lo}, {hi}]", "invalid_arguments")
        out[name] = value
    return out
