"""Core checks: net worth per currency (``core/networth.py``)."""

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


CHECKS = [
    Check("core.networth", networth),
    Check("core.networth_series", networth_series),
]
