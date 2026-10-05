"""The profile-bound tool host and its stdio transport.

``FinanseMcp(profile_id)`` serves exactly one profile: it is bound by id when the server starts
(``finanse mcp --profile <slug>``), tools take no profile argument, and every call re-reads that profile
(its privacy level applies from the next call after a change in the app) and its enabled modules (a
disabled module's tools are not listed and are refused). One call = one database session: the handler
runs, the redaction and the leak check pass, then the session commits (a write whose answer fails the
privacy check is rolled back). Every call is audited (``audit.start`` writes the row before the
tool runs, so a call that cannot be logged is not run; ``audit.finish`` adds the outcome).

``build_server`` wraps the host in the official MCP SDK's low-level ``Server`` (tools only);
``run_stdio`` serves it over stdin/stdout. Nothing else may write to stdout in that process.
"""

from __future__ import annotations

import datetime as dt
import json
import logging
import time
from dataclasses import dataclass
from typing import Any

from sqlmodel import Session

from ... import __version__
from .. import profiles
from ..db import get_session
from ..models import Profile
from . import audit
from .redaction import LeakDetected, Redactor, UnlabelledValue, leak_check, scrub_text
from .registry import ToolContext, ToolError, ToolSpec, all_tools, validate_arguments

_log = logging.getLogger(__name__)

INSTRUCTIONS = (
    "finanse: local personal finance data of ONE profile. Every answer passes a privacy layer: in "
    "'strict' mode you get shares and percentages, never absolute amounts; identifiers (account "
    "numbers, IBANs, person names) are never sent in any mode. Call profile_overview first: it says "
    "which modules are enabled and the privacy level. Write tools only create records or proposals; "
    "the owner approves proposals in the app. Do not ask the user for raw exports or database files."
)


@dataclass
class CallResult:
    ok: bool
    data: dict[str, Any] | None = None
    error: str | None = None
    error_kind: str | None = None


class FinanseMcp:
    def __init__(self, profile_id: int, *, today: dt.date | None = None) -> None:
        self.profile_id = profile_id
        self._today = today
        self._tools = all_tools()

    @classmethod
    def for_slug(cls, slug: str) -> FinanseMcp:
        with get_session() as s:
            profile = profiles.get_by_slug(s, slug)
            if profile is None:
                raise profiles.ProfileNotFound(f"No profile '{slug}'")
            return cls(profile.id)

    def today(self) -> dt.date:
        return self._today or dt.date.today()  # noqa: DTZ011 - naive local date, like booking dates

    def _profile(self, s: Session) -> Profile | None:
        return s.get(Profile, self.profile_id)

    def _available(self, s: Session, profile: Profile) -> list[ToolSpec]:
        enabled = set(profiles.enabled_modules(s, profile.id))
        return [t for t in self._tools.values() if t.module == "core" or t.module in enabled]

    # ------------------------------------------------------------------ #

    def list_tools(self) -> list[ToolSpec]:
        with get_session() as s:
            profile = self._profile(s)
            if profile is None:
                return []
            return self._available(s, profile)

    def call(self, name: str, arguments: dict[str, Any] | None = None) -> CallResult:
        """Run one tool call. The audit row is written BEFORE the tool runs (no audit, no call) and
        completed afterwards with the outcome and the duration."""
        started = time.monotonic()
        spec = self._tools.get(name)
        known = set(spec.properties) if spec else set()
        try:
            call_id = audit.start(
                self.profile_id,
                name if spec else "(unknown)",
                audit.summarize_args(arguments, known),
            )
        except audit.AuditUnavailable as e:
            if str(e) == "profile missing":
                return CallResult(
                    False,
                    error="the profile of this server no longer exists",
                    error_kind="profile_missing",
                )
            return CallResult(
                False,
                error="the call was not run: the audit log cannot be written (is the app's "
                "database available?)",
                error_kind="audit_unavailable",
            )
        privacy = "strict"
        result: CallResult
        try:
            result, privacy = self._call(spec, name, arguments)
        except Exception:  # noqa: BLE001 - never crash the server; never send exception text
            _log.exception("MCP tool %s failed", name)
            result = CallResult(
                False, error="internal error (details are in the app's log)", error_kind="internal"
            )
        outcome = "ok" if result.ok else ("refused" if result.error_kind in _REFUSED else "error")
        audit.finish(
            call_id, privacy, outcome, result.error_kind, int((time.monotonic() - started) * 1000)
        )
        return result

    def _call(
        self, spec: ToolSpec | None, name: str, arguments: dict[str, Any] | None
    ) -> tuple[CallResult, str]:
        with get_session() as s:
            profile = self._profile(s)
            if profile is None:
                return CallResult(
                    False,
                    error="the profile of this server no longer exists",
                    error_kind="profile_missing",
                ), "strict"
            privacy = "amounts" if profile.mcp_privacy == "amounts" else "strict"
            if spec is None:
                return CallResult(False, error="unknown tool", error_kind="unknown_tool"), privacy
            if spec not in self._available(s, profile):
                return CallResult(
                    False,
                    error=f"tool {spec.name} belongs to the module '{spec.module}', which is not "
                    "enabled for this profile",
                    error_kind="module_disabled",
                ), privacy
            try:
                args = validate_arguments(spec, arguments)
                ctx = ToolContext(s, profile, privacy, self.today())
                tree = spec.handler(ctx, **args)
                redactor = Redactor(privacy, ctx.guard)
                data = redactor.apply(tree)
                if not isinstance(data, dict):
                    raise UnlabelledValue("a tool must return an object")
                leak_check(data, strict=redactor.strict, isins=redactor.isins)
            except ToolError as e:
                s.rollback()
                message = scrub_text(str(e), strict=True, guard=_safe_guard(s, profile))
                return CallResult(False, error=message, error_kind=e.kind), privacy
            except LeakDetected:
                s.rollback()
                _log.error("MCP tool %s: response withheld by the privacy check", name)
                return CallResult(
                    False,
                    error="the answer was withheld by the privacy check (nothing was sent or saved)",
                    error_kind="privacy_check",
                ), privacy
            except UnlabelledValue:
                s.rollback()
                _log.exception("MCP tool %s returned an unlabelled value", name)
                return CallResult(
                    False,
                    error="the answer was withheld by the privacy check (nothing was sent or saved)",
                    error_kind="unlabelled",
                ), privacy
            return CallResult(True, data=data), privacy


_REFUSED = {"privacy_check", "unlabelled", "module_disabled", "profile_missing"}


def _safe_guard(s: Session, profile: Profile):
    try:
        from .names import collect

        return collect(s, profile)
    except Exception:  # noqa: BLE001 - masking names is best effort for error text
        return None


# --------------------------------------------------------------------------- #
# MCP SDK wiring
# --------------------------------------------------------------------------- #


def build_server(host: FinanseMcp, name: str):
    import anyio
    import mcp_types as types
    from mcp.server import Server

    async def on_list_tools(_ctx, _params) -> types.ListToolsResult:
        specs = await anyio.to_thread.run_sync(host.list_tools)
        return types.ListToolsResult(
            tools=[
                types.Tool(
                    name=spec.name,
                    description=spec.description,
                    input_schema=spec.input_schema,
                    annotations=types.ToolAnnotations(
                        read_only_hint=not spec.write,
                        destructive_hint=False,
                        open_world_hint=False,
                    ),
                )
                for spec in specs
            ]
        )

    async def on_call_tool(_ctx, params: types.CallToolRequestParams) -> types.CallToolResult:
        result = await anyio.to_thread.run_sync(host.call, params.name, params.arguments or {})
        if not result.ok:
            return types.CallToolResult(
                content=[types.TextContent(text=result.error or "error")], is_error=True
            )
        text = json.dumps(result.data, ensure_ascii=False, indent=1)
        return types.CallToolResult(
            content=[types.TextContent(text=text)], structured_content=result.data
        )

    return Server(
        name,
        version=__version__,
        instructions=INSTRUCTIONS,
        on_list_tools=on_list_tools,
        on_call_tool=on_call_tool,
    )


def run_stdio(slug: str) -> None:
    import anyio
    from mcp.server.stdio import stdio_server

    host = FinanseMcp.for_slug(slug)
    server = build_server(host, f"finanse-{slug}")
    from .. import runtime

    runtime.note_mcp_started()

    async def main() -> None:
        async with stdio_server() as (read_stream, write_stream):
            await server.run(read_stream, write_stream, server.create_initialization_options())

    anyio.run(main)
