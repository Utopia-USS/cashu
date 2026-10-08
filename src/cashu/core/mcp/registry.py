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
    "cashu.core.mcp.tools.core",
    "cashu.core.mcp.tools.budget",
    "cashu.core.mcp.tools.loans",
    "cashu.core.mcp.tools.investments",
    "cashu.core.mcp.tools.alerts",
    "cashu.core.mcp.tools.research",
    "cashu.core.mcp.tools.connectors",
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
    instead (e.g. ``converter``: MCP never makes the app run code; the app runs only connectors the
    owner approved in the app). Not part of the schema."""
    refused_values: dict[str, dict[Any, str]] = field(default_factory=dict)
    """Values of an argument outside its enum that get their own message instead of the generic enum
    error (e.g. a macro note key given as an instrument segment). Not part of the schema."""
    nullable: tuple[str, ...] = ()
    """Arguments that must be given but may be an explicit null (e.g. ``segment: null`` clears a
    value): required in the schema, typed ``[<type>, "null"]``, passed to the handler as None."""
    also: tuple[str, ...] = ()
    """More modules that make the tool available (any of ``module`` and these; e.g. ``inspect_export``
    serves the investments and the budget import)."""

    def enabled_in(self, enabled) -> bool:
        """Listed and callable for a profile with these modules enabled."""
        return self.module == "core" or self.module in enabled or any(m in enabled for m in self.also)

    def listed_module(self, enabled) -> str:
        """The module the tool is listed under for this profile (the first enabled one)."""
        if self.module == "core" or self.module in enabled:
            return self.module
        return next((m for m in self.also if m in enabled), self.module)

    @property
    def input_schema(self) -> dict[str, Any]:
        properties = dict(self.properties)
        for name in self.nullable:
            schema = dict(properties[name])
            schema["type"] = [schema.get("type", "string"), "null"]
            if "enum" in schema:
                schema["enum"] = [*schema["enum"], None]
            properties[name] = schema
        return {
            "type": "object",
            "properties": properties,
            "required": [*self.required, *(n for n in self.nullable if n not in self.required)],
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
        if args.get(name) is None and name not in spec.nullable:
            raise ToolError(f"missing argument: {name}", "invalid_arguments")
    for name in spec.nullable:
        if name not in args:
            raise ToolError(f"missing argument: {name} (null clears it)", "invalid_arguments")
    out: dict[str, Any] = {}
    for name, schema in spec.properties.items():
        if name in spec.nullable and name in args and args[name] is None:
            out[name] = None
            continue
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
        refused = spec.refused_values.get(name, {})
        if isinstance(value, str) and value in refused:
            raise ToolError(refused[value], "invalid_arguments")
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
