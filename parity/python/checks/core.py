"""Core checks: net worth per currency (``core/networth.py``) and the overview read models (the shell
summary, the net-worth series view and every module's blank-page status, as the API serves them)."""

from __future__ import annotations

import datetime as dt

from . import Check, Ctx


def _line(line) -> dict:
    acc = line.account
    return {
        "account_id": acc.id,
        "type": acc.type,
        "currency": acc.currency,
        "as_of": line.as_of,
        "amount": line.amount,
        "contribution": line.contribution,
        "is_liability": line.is_liability,
    }


def networth(ctx: Ctx) -> dict:
    from cashu.core import networth as nw

    out = {}
    for p in ctx.profiles:
        totals, lines = nw.net_worth(ctx.session, profile_id=p.id)
        year_ago, _ = nw.net_worth(ctx.session, ctx.as_of - dt.timedelta(days=365), profile_id=p.id)
        breakdown = {}
        for currency in sorted(totals):
            b = nw.net_worth_breakdown(ctx.session, currency, profile_id=p.id)
            breakdown[currency] = {
                "assets": b.assets,
                "liabilities": b.liabilities,
                "net": b.net,
                "property_value": b.property_value,
                "mortgage": b.mortgage,
                "home_equity": b.home_equity,
                "by_type": b.by_type,
            }
        out[ctx.pkey(p)] = {
            "totals": totals,
            "totals_365d_ago": year_ago,
            "lines": [_line(ln) for ln in lines],
            "breakdown": breakdown,
            "component_order": nw.component_order(),
            "liability_components": nw.liability_components(),
        }
    return out


def networth_series(ctx: Ctx) -> dict:
    from sqlmodel import select

    from cashu.core import networth as nw
    from cashu.core.models import Account

    out = {}
    for p in ctx.profiles:
        currencies = sorted(
            set(ctx.session.exec(select(Account.currency).where(Account.profile_id == p.id)).all())
        )
        per = {}
        for c in currencies:
            per[c] = {
                "daily_total": nw.net_worth_series(
                    ctx.session, c, "daily", "total", profile_id=p.id
                ),
                "weekly_liquid": nw.net_worth_series(
                    ctx.session, c, "weekly", "liquid", profile_id=p.id
                ),
                "monthly_components": nw.net_worth_component_series(
                    ctx.session, c, "monthly", "total", profile_id=p.id
                ),
            }
        out[ctx.pkey(p)] = per
    return out


SERIES_VIEWS = [(g, sc) for g in ("daily", "weekly", "monthly") for sc in ("total", "liquid")]


def overview(ctx: Ctx) -> dict:
    """``GET /summary``, ``GET /networth/series`` (every granularity and scope per currency of the
    profile's accounts, plus the default currency) and ``GET /modules/{id}/setup`` / the profile's
    module states, through the route functions themselves (JSON floats from ``f()``). Setup and labels
    in both languages; the setup's ``skill`` keeps only the command (``mcp_add`` / ``translocated``
    are the runtime's, not the read model's)."""
    from sqlmodel import select

    from cashu.api.app import summary
    from cashu.core import i18n, profiles
    from cashu.core.api import module_setup, networth_series
    from cashu.core.models import Account

    out = {}
    for p in ctx.profiles:
        currencies = sorted(
            set(ctx.session.exec(select(Account.currency).where(Account.profile_id == p.id)).all())
        )
        series = {
            c: {f"{g}_{sc}": networth_series(p, c, g, sc) for g, sc in SERIES_VIEWS}
            for c in currencies
        }
        with i18n.use_language("en"):
            labels_en = networth_series(p, None, "monthly", "total")["components"]
        setup = {}
        for lang in ("pl", "en"):
            with i18n.use_language(lang):
                for spec_id in ("budget", "assets", "loans", "investments"):
                    body = module_setup(p, spec_id)
                    skill = body["skill"]
                    setup[f"{spec_id}_{lang}"] = {
                        "state": body["state"],
                        "steps": body["steps"],
                        "cli_prefix": body["cli_prefix"],
                        "skill": skill["command"] if skill else None,
                    }
        out[ctx.pkey(p)] = {
            "summary": summary(p),
            "series_default": networth_series(p, None, "daily", "total"),
            "series": series,
            "series_labels_en": labels_en,
            "setup": setup,
            "modules": profiles.as_dict(ctx.session, p)["modules"],
        }
    return out


CHECKS = [
    Check("core.networth", networth),
    Check("core.networth_series", networth_series),
    Check("core.overview", overview),
]
