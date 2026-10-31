"""MCP checks: the tool schemas (``core/mcp/registry.py``) and every read tool of
``core/mcp/server.py`` per profile, in both privacy levels (``strict`` and ``amounts`` = full), as the
redacted answer the agent gets and as the raw labelled tree before redaction (for the TS privacy
layer, S37).

A call replays ``CashuMcp._call`` without the audit row (no ``mcp_calls`` insert): argument validation,
the handler with a ``ToolContext`` at the frozen day, the ``Redactor`` and the ``leak_check``; tool
errors keep their scrubbed message and kind. Each call runs in the shared session and is rolled back.
"""

from __future__ import annotations

import canon

from . import Check, Ctx

MODES = ("strict", "amounts")

# Read tools that need a file path, connector code or a running connector: not reachable here.
NEEDS_FILES = {
    "validate_budget_import": "needs a budget import file path (file-based input, not dataset state)",
    "inspect_export": "needs an export file path (file-based input, not dataset state)",
    "validate_import": "needs an import file path (file-based input, not dataset state)",
    "test_connector": "runs connector code from a path in a sandbox subprocess",
}


def _calls(ctx: Ctx) -> list[tuple[str, dict]]:
    calls: list[tuple[str, dict]] = [("profile_overview", {})]
    calls += [("setup_status", {"module": m}) for m in ("budget", "assets", "loans", "investments")]
    calls += [
        ("networth_breakdown", {}),
        ("spending_breakdown", {}),
        ("cashflow_summary", {}),
        ("recurring_payments", {}),
        ("uncategorized_merchants", {}),
        ("loans_summary", {}),
        ("portfolio_overview", {}),
        ("positions", {}),
        ("signals", {"status": "open"}),
        ("signals", {"status": "history"}),
        ("signals", {"status": "all"}),
        ("review_context", {}),
        ("strategy_status", {}),
        ("history_metrics", {}),
        ("theses", {}),
        ("alerts", {}),
        ("alerts", {"status": "all"}),
        ("watchlist", {}),
        ("search_instruments", {"query": "ETF"}),
        ("research_context", {}),
        ("research_notes", {}),
        ("connectors", {}),
    ]
    return calls


def _call_key(name: str, args: dict) -> str:
    # always with parentheses: a bare tool name ("alerts") would act as an id parent in canon.py
    return name + "(" + ",".join(f"{k}={args[k]}" for k in sorted(args)) + ")"


OVERRIDES: dict[str, str] = {}


def _run_all(ctx: Ctx) -> dict:
    """{mode: {profile key: {call key: {"redacted": ..., "raw": ...}}}} computed once per run."""
    if "mcp" in ctx.cache:
        return ctx.cache["mcp"]
    from cashu.core import profiles as core_profiles
    from cashu.core.i18n import use_language
    from cashu.core.mcp.redaction import (
        LeakDetected,
        Redactor,
        UnlabelledValue,
        leak_check,
        scrub_text,
    )
    from cashu.core.mcp.registry import ToolContext, ToolError, all_tools, validate_arguments
    from cashu.core.mcp.server import _safe_guard

    tools = all_tools()
    for name, spec in tools.items():
        if not spec.write and name in NEEDS_FILES:
            ctx.skip("mcp.read", name, NEEDS_FILES[name])
    known_reads = {n for n, t in tools.items() if not t.write} - set(NEEDS_FILES)
    covered = {name for name, _ in _calls(ctx)}
    missing = sorted(known_reads - covered)
    if missing:
        raise RuntimeError(f"read tools without a golden call: {missing}")

    s = ctx.session
    canon_ = canon.Canon(ctx.ids, OVERRIDES)
    result: dict = {m: {} for m in MODES}
    for mode in MODES:
        for p in ctx.profiles:
            enabled = set(core_profiles.enabled_modules(s, p.id))
            per: dict = {}
            for name, arguments in _calls(ctx):
                key = _call_key(name, arguments)
                spec = tools[name]
                if not spec.enabled_in(enabled):
                    per[key] = {"error_kind": "module_disabled"}
                    continue
                entry: dict = {}
                try:
                    with use_language("pl"):
                        args = validate_arguments(spec, arguments)
                        tctx = ToolContext(s, p, mode, ctx.as_of)
                        tree = spec.handler(tctx, **args)
                        entry["raw"] = canon_.value(tree, f"$.{name}")
                        redactor = Redactor(mode, tctx.guard)
                        data = redactor.apply(tree)
                        if not isinstance(data, dict):
                            raise UnlabelledValue("a tool must return an object")
                        leak_check(data, strict=redactor.strict, isins=redactor.isins)
                        entry["redacted"] = canon_.value(data, f"$.{name}")
                except ToolError as e:
                    message = scrub_text(str(e), strict=True, guard=_safe_guard(s, p))
                    entry = {"error": message, "error_kind": e.kind}
                except LeakDetected:
                    entry = {"error_kind": "privacy_check", "raw": entry.get("raw")}
                except UnlabelledValue:
                    entry = {"error_kind": "unlabelled"}
                finally:
                    s.rollback()
                per[key] = entry
            result[mode][ctx.pkey(p)] = per
    ctx.cache["mcp"] = result
    return result


def _pick(ctx: Ctx, mode: str, part: str) -> dict:
    data = _run_all(ctx)[mode]
    out = {}
    for pkey, calls in data.items():
        out[pkey] = {
            k: (v[part] if part in v else {kk: vv for kk, vv in v.items() if kk != "raw"})
            for k, v in calls.items()
        }
    return out


def read_strict(ctx: Ctx) -> dict:
    return _pick(ctx, "strict", "redacted")


def read_amounts(ctx: Ctx) -> dict:
    return _pick(ctx, "amounts", "redacted")


def read_raw(ctx: Ctx) -> dict:
    return {mode: _pick(ctx, mode, "raw") for mode in MODES}


def tool_schemas(ctx: Ctx) -> dict:
    from cashu.core import profiles as core_profiles
    from cashu.core.mcp.registry import PROVIDERS, all_tools
    from cashu.core.mcp.server import INSTRUCTIONS

    tools = all_tools()
    listed = {}
    for p in ctx.profiles:
        enabled = set(core_profiles.enabled_modules(ctx.session, p.id))
        listed[ctx.pkey(p)] = [
            {"name": t.name, "listed_module": t.listed_module(enabled)}
            for t in tools.values()
            if t.enabled_in(enabled)
        ]
    return {
        "instructions": INSTRUCTIONS,
        "providers": list(PROVIDERS),
        "tools": [
            {
                "name": t.name,
                "module": t.module,
                "also": list(t.also),
                "write": t.write,
                "description": t.description,
                "input_schema": t.input_schema,
                "annotations": {
                    "read_only_hint": not t.write,
                    "destructive_hint": False,
                    "open_world_hint": False,
                },
                "refused": t.refused,
                "refused_values": {
                    k: {str(kk): vv for kk, vv in v.items()} for k, v in t.refused_values.items()
                },
                "nullable": list(t.nullable),
            }
            for t in tools.values()
        ],
        "listed": listed,
    }


CHECKS = [
    Check("mcp.tool_schemas", tool_schemas, per_profile=False),
    Check("mcp.read_strict", read_strict, OVERRIDES),
    Check("mcp.read_amounts", read_amounts, OVERRIDES),
    Check("mcp.read_raw", read_raw, OVERRIDES, per_profile=False),
]
