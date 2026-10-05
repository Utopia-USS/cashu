"""Core MCP tools: ``profile_overview``, ``setup_status``, ``networth_breakdown``, ``mark_review_done``."""

from __future__ import annotations

import importlib
from collections import defaultdict
from datetime import timedelta
from decimal import Decimal
from typing import Any

from sqlmodel import func, select

from ... import account_types, modules, networth, profiles, reviews
from ...agent_models import Proposal
from ...models import Account, Balance
from .. import labels as L
from ..registry import ToolContext, ToolError, ToolSpec

PRIVACY_NOTES = {
    "strict": "strict: shares and percentages only, no absolute amounts; never identifiers",
    "amounts": "amounts: absolute amounts are sent; identifiers (account numbers, names) never",
}

# Module tool providers that report data freshness: ``freshness(ctx) -> dict`` (labelled).
FRESHNESS = {
    "budget": "finanse.core.mcp.tools.budget",
    "investments": "finanse.core.mcp.tools.investments",
}


def profile_overview(ctx: ToolContext) -> dict:
    s, pid = ctx.session, ctx.profile_id
    enabled = set(profiles.enabled_modules(s, pid))
    from ..registry import all_tools

    by_module: dict[str, list[str]] = defaultdict(list)
    for spec in all_tools().values():
        by_module[spec.module].append(spec.name)
    module_rows = []
    for spec in modules.all_modules():
        on = spec.id in enabled
        state = profiles.module_setup(s, pid, spec.id).state if on else None
        module_rows.append(
            {
                "id": L.category(spec.id),
                "name": L.text(spec.name),
                "enabled": L.flag(on),
                "setup_state": L.category(state),
                "skill": L.text(spec.skill),
                "tools": [L.text(n) for n in sorted(by_module.get(spec.id, []))] if on else [],
            }
        )
    newest_balance = s.exec(
        select(func.max(Balance.date)).where(
            Balance.account_id.in_(select(Account.id).where(Account.profile_id == pid))
        )
    ).one()
    freshness: dict[str, Any] = {"balances_newest": L.date(newest_balance)}
    for module_id, provider in FRESHNESS.items():
        if module_id in enabled:
            freshness[module_id] = importlib.import_module(provider).freshness(ctx)
    pending = s.exec(
        select(func.count()).where(Proposal.profile_id == pid, Proposal.status == "pending")
    ).one()
    last_reviews = []
    for module_id in sorted(enabled):
        row = reviews.last(s, pid, module_id)
        if row is not None:
            last_reviews.append({"module": L.category(module_id), "done_at": L.date(row.done_at)})
    return {
        "privacy": L.category(ctx.privacy),
        "privacy_note": L.text(PRIVACY_NOTES[ctx.privacy]),
        "base_currency": L.category(ctx.profile.base_currency),
        "today": L.date(ctx.today),
        "modules": module_rows,
        "core_tools": [L.text(n) for n in sorted(by_module.get("core", []))],
        "freshness": freshness,
        "pending_proposals": L.count(int(pending)),
        "last_reviews": last_reviews,
    }


def setup_status(ctx: ToolContext, module: str) -> dict:
    try:
        spec = modules.get(module)
    except KeyError:
        raise ToolError(f"unknown module; known: {', '.join(modules.registry())}") from None
    status = profiles.module_setup(ctx.session, ctx.profile_id, module)
    slug = ctx.profile.slug

    def neutral(target: str) -> str:
        # Copyable commands carry the profile slug (often a person's name): send a placeholder.
        return target.replace(f"--profile {slug}", "--profile <profile>")

    steps = []
    next_action = None
    for step in status.step_dicts():
        actions = [
            {
                "kind": L.category(a["kind"]),
                "label": L.text(a["label"]),
                "target": L.text(neutral(a["target"])),
            }
            for a in step["actions"]
        ]
        steps.append(
            {
                "id": L.category(step["id"]),
                "title": L.text(step["title"]),
                "description": L.text(step["description"]),
                "status": L.category(step["status"]),
                "actions": actions,
            }
        )
        if step["status"] == "on" and next_action is None:
            next_action = {"step": L.category(step["id"]), "title": L.text(step["title"])}
    enabled = module in profiles.enabled_modules(ctx.session, ctx.profile_id)
    return {
        "module": L.category(module),
        "enabled": L.flag(enabled),
        "state": L.category(status.state),
        "steps": steps,
        "next_action": next_action,
        "skill": L.text(spec.skill),
    }


def networth_breakdown(ctx: ToolContext) -> dict:
    s, pid = ctx.session, ctx.profile_id
    modules.registry()
    _totals, lines = networth.net_worth(s, profile_id=pid)
    labels = ctx.account_labels
    by_currency: dict[str, list] = defaultdict(list)
    for line in lines:
        by_currency[line.account.currency].append(line)
    out = []
    for currency in sorted(by_currency):
        rows = by_currency[currency]
        assets = sum(
            (ln.contribution for ln in rows if ln.contribution and ln.contribution > 0), Decimal(0)
        )
        liabilities = -sum(
            (ln.contribution for ln in rows if ln.contribution and ln.contribution < 0), Decimal(0)
        )
        buckets: dict[str, Decimal] = defaultdict(Decimal)
        for ln in rows:
            if ln.contribution is not None:
                buckets[account_types.get(ln.account.type).bucket] += ln.contribution
        series = networth.net_worth_component_series(
            s, currency=currency, granularity="monthly", profile_id=pid
        )
        change = None
        if series:
            last_date, last_comps = series[-1]
            now_value = sum(last_comps.values(), Decimal(0))
            target = last_date - timedelta(days=365)
            past = [p for p in series if p[0] <= target]
            if past:
                then = sum(past[-1][1].values(), Decimal(0))
                if then:
                    change = (now_value - then) / abs(then)
        out.append(
            {
                "currency": L.category(currency),
                "base_note": L.text(
                    "bucket and account shares are of gross assets in this currency"
                ),
                "buckets": [
                    {
                        "bucket": L.category(b),
                        "label": L.text(account_types.bucket(b).label),
                        "liability": L.flag(value < 0),
                        "share_of_assets": L.share(abs(value), assets),
                        "value": L.amount(value),
                    }
                    for b, value in sorted(buckets.items(), key=lambda kv: -abs(kv[1]))
                ],
                "asset_liability_ratio": L.share(liabilities, assets),
                "net_share_of_assets": L.share(assets - liabilities, assets),
                "change_12m_pct": L.pct(change),
                "assets": L.amount(assets),
                "liabilities": L.amount(liabilities),
                "net": L.amount(assets - liabilities),
                "accounts": [
                    {
                        "account": L.account(labels.get(ln.account.id)),
                        "name": L.identifier(ln.account.name),
                        "type": L.category(str(ln.account.type)),
                        "bucket": L.category(account_types.get(ln.account.type).bucket),
                        "share_of_assets": L.share(abs(ln.contribution), assets)
                        if ln.contribution is not None
                        else L.pct(None),
                        "as_of": L.date(ln.as_of),
                        "balance": L.amount(ln.contribution),
                    }
                    for ln in rows
                ],
            }
        )
    return {"currencies": out, "note": L.text("currencies are never summed or converted")}


def mark_review_done(
    ctx: ToolContext, notes: str | None = None, module: str = "investments"
) -> dict:
    if module not in profiles.enabled_modules(ctx.session, ctx.profile_id):
        raise ToolError(f"module {module} is not enabled for this profile")
    stats: dict[str, Any] = {"source": "mcp"}
    if module == "investments":
        from .investments import review_stats

        stats |= review_stats(ctx)
    try:
        row = reviews.mark_done(ctx.session, ctx.profile_id, module, notes, stats)
    except reviews.ReviewError as e:
        raise ToolError(str(e)) from None
    return {
        "review_id": L.ref(row.id),
        "module": L.category(module),
        "done_at": L.date(row.done_at),
        "stats": {k: L.count(v) for k, v in stats.items() if isinstance(v, int)},
    }


TOOLS = (
    ToolSpec(
        "profile_overview",
        "core",
        "Start here: enabled modules with setup states and their tools, base currency, privacy level "
        "(strict = shares only), data freshness, pending proposals, last reviews.",
        profile_overview,
    ),
    ToolSpec(
        "setup_status",
        "core",
        "Setup steps of a module (done / on / todo) and the next action.",
        setup_status,
        properties={"module": {"type": "string", "enum": list(modules.MODULE_IDS)}},
        required=("module",),
    ),
    ToolSpec(
        "networth_breakdown",
        "core",
        "Net worth per currency: bucket shares of assets, asset/liability ratio, 12-month change in %. "
        "Absolute amounts only in the 'amounts' privacy mode.",
        networth_breakdown,
    ),
    ToolSpec(
        "mark_review_done",
        "core",
        "Record that the weekly review of a module (default investments) is done, with notes.",
        mark_review_done,
        properties={
            "notes": {"type": "string", "maxLength": reviews.MAX_NOTES},
            "module": {
                "type": "string",
                "enum": list(modules.MODULE_IDS),
                "default": "investments",
            },
        },
        write=True,
    ),
)
