"""The profile-bound tool host and its stdio transport.

``CashuMcp(profile_id)`` serves exactly one profile: it is bound by id when the server starts
(``cashu mcp --profile <slug>``), tools take no profile argument, and every call re-reads that profile
(its privacy level applies from the next call after a change in the app) and its enabled modules (a
disabled module's tools are not listed and are refused). One call = one database session: the handler
runs, the redaction and the leak check pass, then the session commits (a write whose answer fails the
privacy check is rolled back). Every call is audited (``audit.start`` writes the row before the
tool runs, so a call that cannot be logged is not run; ``audit.finish`` adds the outcome).
Every call renders in Polish (``i18n.use_language("pl")``): MCP output is for the agent, and the
stored app language of the dashboard must never change it (docs/agents/localization.md).

A server whose app was replaced since it started (an auto-update, ``runtime.bundle_replaced``)
touches nothing anymore: the next call is refused with a message to reconnect, before the audit and
the database, and the process exits right after that answer.

``build_server`` wraps the host in the official MCP SDK's low-level ``Server`` (tools only);
``run_stdio`` serves it over stdin/stdout. Nothing else may write to stdout in that process.
"""

from __future__ import annotations

import datetime as dt
import json
import logging
import os
import threading
import time
from dataclasses import dataclass
from typing import Any

from sqlmodel import Session

from ... import __version__
from .. import profiles, runtime
from ..db import get_session
from ..i18n import use_language
from ..models import Profile
from . import audit
from .host_policy import NativeGuardSources, augment_guard, parse_guard_sources
from .redaction import LeakDetected, Redactor, UnlabelledValue, leak_check, scrub_text
from .registry import ToolContext, ToolError, ToolSpec, all_tools, validate_arguments

_log = logging.getLogger(__name__)

INSTRUCTIONS = (
    "cashU: local personal finance data of ONE profile. Every answer passes a privacy layer: in "
    "'strict' mode you get shares and percentages, never absolute amounts; identifiers (account "
    "numbers, IBANs, person names) are never sent in any mode. Call profile_overview first: it says "
    "which modules are enabled and the privacy level. Write tools only create records or proposals; "
    "the owner approves proposals in the app. Do not ask the user for raw exports or database files."
)
APP_UPDATED = (
    "cashU was updated while this MCP server was running, so this server stops now and nothing was "
    "run. Reconnect it (Claude Code: /mcp) to use the new version, then repeat the call."
)
EXIT_DELAY_S = 1.0  # time for the refusal to reach the client before the process exits

# TRANSITIONAL(S38f): restrictive policy bridge for tools still delegated by the native host.
PRIVACY_CEILING_META = "cashu/privacyCeiling"
EFFECTIVE_PRIVACY_META = "cashu/effectivePrivacy"
HOST_POLICY_CAPABILITY = "cashu/hostPolicyV1"
NAME_GUARD_META = "cashu/nameGuard"
NAME_GUARD_APPLIED_META = "cashu/nameGuardApplied"
_NO_CEILING = object()
_NO_GUARD = object()


@dataclass
class CallResult:
    ok: bool
    data: dict[str, Any] | None = None
    error: str | None = None
    error_kind: str | None = None
    effective_privacy: str = "strict"
    name_guard_applied: bool = False


class CashuMcp:
    def __init__(self, profile_id: int, *, today: dt.date | None = None) -> None:
        self.profile_id = profile_id
        self._today = today
        self._tools = all_tools()
        self.stopping = False  # the app was replaced: refuse everything, the process exits

    def _replaced(self) -> bool:
        if not self.stopping and runtime.bundle_replaced():
            _log.warning("cashU.app was replaced since this MCP server started: stopping")
            self.stopping = True
        return self.stopping

    @classmethod
    def for_slug(cls, slug: str) -> CashuMcp:
        with get_session() as s:
            profile = profiles.get_by_slug(s, slug)
            if profile is None:
                raise profiles.ProfileNotFound(f"No profile '{slug}'")
            return cls(profile.id)

    def today(self) -> dt.date:
        return self._today or dt.date.today()  # naive local date, like booking dates

    def _profile(self, s: Session) -> Profile | None:
        return s.get(Profile, self.profile_id)

    def _available(self, s: Session, profile: Profile) -> list[ToolSpec]:
        enabled = set(profiles.enabled_modules(s, profile.id))
        return [t for t in self._tools.values() if t.enabled_in(enabled)]

    # ------------------------------------------------------------------ #

    def list_tools(self) -> list[ToolSpec]:
        if self._replaced():
            return []
        with get_session() as s:
            profile = self._profile(s)
            if profile is None:
                return []
            return self._available(s, profile)

    def call(
        self,
        name: str,
        arguments: dict[str, Any] | None = None,
        *,
        privacy_ceiling: object = _NO_CEILING,
        name_guard: object = _NO_GUARD,
    ) -> CallResult:
        """Run one tool call. The audit row is written BEFORE the tool runs (no audit, no call) and
        completed afterwards with the outcome and the duration."""
        if self._replaced():
            return CallResult(False, error=APP_UPDATED, error_kind="app_updated")
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
            with use_language("pl"):  # MCP output stays Polish whatever the app language
                if privacy_ceiling is not _NO_CEILING and (
                    not isinstance(privacy_ceiling, str)
                    or privacy_ceiling not in ("strict", "amounts")
                ):
                    result = CallResult(
                        False,
                        error="the call was not run: invalid host privacy policy",
                        error_kind="invalid_privacy_ceiling",
                    )
                else:
                    ceiling = privacy_ceiling if isinstance(privacy_ceiling, str) else None
                    try:
                        sources = (
                            parse_guard_sources(name_guard) if name_guard is not _NO_GUARD else None
                        )
                    except ValueError:
                        result = CallResult(
                            False,
                            error="the call was not run: invalid host name guard",
                            error_kind="invalid_name_guard",
                        )
                    else:
                        result, privacy = self._call(spec, name, arguments, ceiling, sources)
        except Exception:  # noqa: BLE001 - never crash the server; never send exception text
            _log.exception("MCP tool %s failed", name)
            result = CallResult(
                False, error="internal error (details are in the app's log)", error_kind="internal"
            )
        outcome = "ok" if result.ok else ("refused" if result.error_kind in _REFUSED else "error")
        audit.finish(
            call_id, privacy, outcome, result.error_kind, int((time.monotonic() - started) * 1000)
        )
        result.effective_privacy = privacy
        return result

    def _call(
        self,
        spec: ToolSpec | None,
        name: str,
        arguments: dict[str, Any] | None,
        privacy_ceiling: str | None = None,
        guard_sources: NativeGuardSources | None = None,
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
            if privacy_ceiling == "strict":
                privacy = "strict"
            if spec is None:
                return CallResult(False, error="unknown tool", error_kind="unknown_tool"), privacy
            if spec not in self._available(s, profile):
                return CallResult(
                    False,
                    error=f"tool {spec.name} belongs to the module '{spec.module}', which is not "
                    "enabled for this profile",
                    error_kind="module_disabled",
                ), privacy
            bridge_guard = None
            try:
                ctx = ToolContext(s, profile, privacy, self.today())
                if guard_sources is not None:
                    bridge_guard = augment_guard(ctx.guard, guard_sources, strict=ctx.strict)
                    ctx.guard = bridge_guard
                args = validate_arguments(spec, arguments)
                tree = spec.handler(ctx, **args)
                redactor = Redactor(privacy, ctx.guard)
                data = redactor.apply(tree)
                if not isinstance(data, dict):
                    raise UnlabelledValue("a tool must return an object")
                leak_check(
                    data, strict=redactor.strict, isins=redactor.isins, non_money=redactor.non_money
                )
            except ToolError as e:
                s.rollback()
                if guard_sources is not None and bridge_guard is None:
                    message = "the error text was withheld by the privacy check"
                else:
                    message = scrub_text(
                        str(e),
                        strict=not e.system,
                        guard=bridge_guard if bridge_guard is not None else _safe_guard(s, profile),
                    )
                try:
                    leak_check({"error": message}, strict=True)
                except LeakDetected:  # error text goes through the same final check (F13)
                    _log.error("MCP tool %s: error text withheld by the privacy check", name)
                    message = "the error text was withheld by the privacy check"
                return CallResult(
                    False,
                    error=message,
                    error_kind=e.kind,
                    name_guard_applied=bridge_guard is not None,
                ), privacy
            except LeakDetected:
                s.rollback()
                _log.error("MCP tool %s: response withheld by the privacy check", name)
                return CallResult(
                    False,
                    error="the answer was withheld by the privacy check (nothing was sent or saved)",
                    error_kind="privacy_check",
                    name_guard_applied=bridge_guard is not None,
                ), privacy
            except UnlabelledValue:
                s.rollback()
                _log.exception("MCP tool %s returned an unlabelled value", name)
                return CallResult(
                    False,
                    error="the answer was withheld by the privacy check (nothing was sent or saved)",
                    error_kind="unlabelled",
                    name_guard_applied=bridge_guard is not None,
                ), privacy
            return CallResult(True, data=data, name_guard_applied=bridge_guard is not None), privacy


_REFUSED = {
    "privacy_check",
    "unlabelled",
    "module_disabled",
    "profile_missing",
    "invalid_privacy_ceiling",
    "invalid_name_guard",
}


def _safe_guard(s: Session, profile: Profile):
    try:
        from .names import collect

        return collect(s, profile)
    except Exception:  # noqa: BLE001 - masking names is best effort for error text
        return None


# --------------------------------------------------------------------------- #
# MCP SDK wiring
# --------------------------------------------------------------------------- #


def build_server(host: CashuMcp, name: str):
    from functools import partial

    import anyio
    import mcp_types as types
    from mcp.server import Server

    class HostPolicyServer(Server):
        # Both initialize and modern discovery obtain capabilities through this SDK hook.
        def get_capabilities(
            self,
            notification_options=None,
            experimental_capabilities=None,
            extensions=None,
            *,
            protocol_version=None,
        ):
            capabilities = {
                **(experimental_capabilities or {}),
                HOST_POLICY_CAPABILITY: {"privacyCeiling": True, "nameGuard": True},
            }
            return super().get_capabilities(
                notification_options, capabilities, extensions, protocol_version=protocol_version
            )

    async def on_list_tools(_ctx, _params) -> types.ListToolsResult:
        specs = await anyio.to_thread.run_sync(host.list_tools)
        if host.stopping:
            _exit_soon()
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
        ceiling = (params.meta or {}).get(PRIVACY_CEILING_META, _NO_CEILING)
        guard = (params.meta or {}).get(NAME_GUARD_META, _NO_GUARD)
        result = await anyio.to_thread.run_sync(
            partial(
                host.call,
                params.name,
                params.arguments or {},
                privacy_ceiling=ceiling,
                name_guard=guard,
            )
        )
        meta = (
            {EFFECTIVE_PRIVACY_META: result.effective_privacy}
            if ceiling is not _NO_CEILING or guard is not _NO_GUARD
            else None
        )
        if guard is not _NO_GUARD:
            meta[NAME_GUARD_APPLIED_META] = result.name_guard_applied
        if host.stopping:
            _exit_soon()
        if not result.ok:
            return types.CallToolResult(
                content=[types.TextContent(text=result.error or "error")], is_error=True, meta=meta
            )
        text = json.dumps(result.data, ensure_ascii=False, indent=1)
        return types.CallToolResult(
            content=[types.TextContent(text=text)], structured_content=result.data, meta=meta
        )

    return HostPolicyServer(
        name,
        version=__version__,
        instructions=INSTRUCTIONS,
        on_list_tools=on_list_tools,
        on_call_tool=on_call_tool,
    )


def _exit_soon() -> None:
    """Leave the process once the current answer is written (the app was replaced). No database
    session is open: the replaced host refuses before it opens one."""
    timer = threading.Timer(EXIT_DELAY_S, os._exit, args=(0,))
    timer.daemon = True
    timer.start()


def run_stdio(slug: str) -> None:
    import anyio
    from mcp.server.stdio import stdio_server

    host = CashuMcp.for_slug(slug)
    server = build_server(host, f"cashu-{slug}")
    runtime.note_mcp_started()

    async def main() -> None:
        async with stdio_server() as (read_stream, write_stream):
            await server.run(read_stream, write_stream, server.create_initialization_options())

    anyio.run(main)
