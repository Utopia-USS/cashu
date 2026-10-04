"""Core API routes (accounts, net worth) and JSON helpers shared by module routers."""

from __future__ import annotations

from decimal import Decimal

from fastapi import APIRouter
from sqlmodel import select

from . import networth
from .db import get_session
from .models import Account

router = APIRouter()


def f(value: Decimal | None) -> float | None:
    """Decimal -> JSON number (None stays None)."""
    return float(value) if value is not None else None


def account_row(acc: Account, contribution: Decimal | None, as_of) -> dict:
    return {
        "id": acc.id,
        "bank": acc.bank.value,
        "name": acc.name,
        "type": acc.type.value,
        "currency": acc.currency,
        "iban_tail": (acc.iban or "")[-4:],
        "balance": f(contribution),
        "as_of": as_of.isoformat() if as_of else None,
        "is_liability": acc.type.value == "credit",
    }


def breakdown_dict(bd) -> dict:
    return {
        "currency": bd.currency,
        "assets": f(bd.assets),
        "liabilities": f(bd.liabilities),
        "net": f(bd.net),
        "property": f(bd.property_value),
        "mortgage": f(bd.mortgage),
        "home_equity": f(bd.home_equity),
        "by_type": {k: f(v) for k, v in bd.by_type.items()},
    }


@router.get("/networth")
def networth_ep() -> dict:
    with get_session() as s:
        totals, lines = networth.net_worth(s)
        bd = networth.net_worth_breakdown(s)
        accounts = [account_row(ln.account, ln.contribution, ln.as_of) for ln in lines]
    return {
        "totals": {cur: f(v) for cur, v in sorted(totals.items())},
        "breakdown": breakdown_dict(bd),
        "accounts": accounts,
    }


@router.get("/networth/series")
def networth_series(
    currency: str = "PLN", granularity: str = "daily", scope: str = "total"
) -> dict:
    with get_session() as s:
        series = networth.net_worth_component_series(
            s, currency=currency, granularity=granularity, scope=scope
        )
    present = [k for k in networth.component_order() if any(k in comps for _, comps in series)]
    labels = networth.component_labels()
    liabilities = networth.liability_components()
    points = [
        {
            "date": d.isoformat(),
            "value": f(sum(comps.values(), Decimal(0))),
            "components": {k: f(comps[k]) for k in present if k in comps},
        }
        for d, comps in series
    ]
    return {
        "points": points,
        "components": [
            {"key": k, "label": labels[k], "liability": k in liabilities}
            for k in present
        ],
    }


@router.get("/accounts")
def accounts() -> list[dict]:
    with get_session() as s:
        rows = s.exec(select(Account)).all()
        return [account_row(a, None, None) | {"active": a.active} for a in rows]
