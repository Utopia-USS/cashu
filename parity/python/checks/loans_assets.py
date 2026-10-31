"""Loans valuation (``modules/loans/valuation.py``, ``amortization.py``) and assets depreciation
(``modules/assets/depreciation.py``) checks."""

from __future__ import annotations

import datetime as dt

from . import Check, Ctx


def _month_starts(first: dt.date, last: dt.date) -> list[dt.date]:
    out = []
    y, m = first.year, first.month
    while dt.date(y, m, 1) <= last:
        out.append(dt.date(y, m, 1))
        y, m = (y + 1, 1) if m == 12 else (y, m + 1)
    return out


def _probe_dates(start: dt.date, as_of: dt.date) -> list[dt.date]:
    """Month starts from a month before ``start`` to two years after ``as_of``, plus month ends,
    the start itself and ``as_of``."""
    begin = (start.replace(day=1) - dt.timedelta(days=1)).replace(day=1)
    firsts = _month_starts(begin, as_of + dt.timedelta(days=731))
    ends = [d - dt.timedelta(days=1) for d in firsts[1:]]
    return sorted({*firsts, *ends, start, as_of})


def loans(ctx: Ctx) -> dict:
    from cashu.modules.loans import amortization
    from cashu.modules.loans.service import list_loans, loan_summary
    from cashu.modules.loans.valuation import loan_valuation

    s = ctx.session
    out = {}
    for p in ctx.profiles:
        rows = []
        for loan, acc in list_loans(s, p.id):
            lv = loan_valuation(s, loan)
            probes = _probe_dates(loan.start_date, ctx.as_of)
            rows.append(
                {
                    "loan_id": loan.id,
                    "summary": loan_summary(s, loan, acc, ctx.as_of),
                    "summary_raw": amortization.summarize(
                        loan.principal,
                        loan.annual_rate,
                        loan.term_months,
                        loan.start_date,
                        ctx.as_of,
                        origination_date=loan.origination_date,
                    ),
                    "anchors": lv.anchors,
                    "latest": lv.latest(None),
                    "valuation": [
                        {
                            "date": d,
                            "at": lv.at(d),
                            "scheduled": lv.scheduled(d),
                            "source": lv.source(d),
                        }
                        for d in probes
                    ],
                }
            )
        out[ctx.pkey(p)] = rows
    return out


def assets(ctx: Ctx) -> dict:
    from sqlmodel import select

    from cashu.core.models import Account
    from cashu.modules.assets import api as assets_api
    from cashu.modules.assets import depreciation
    from cashu.modules.assets.models import Depreciation

    s = ctx.session
    out = {}
    for p in ctx.profiles:
        curves = s.exec(
            select(Depreciation)
            .join(Account, Account.id == Depreciation.account_id)
            .where(Account.profile_id == p.id)
            .order_by(Depreciation.id)
        ).all()
        out[ctx.pkey(p)] = {
            "manual_rows": assets_api._rows(s, p.id),
            "depreciation": [
                {
                    "account_id": dep.account_id,
                    "purchase_price": dep.purchase_price,
                    "purchase_date": dep.purchase_date,
                    "annual_rate": dep.annual_rate,
                    "floor": dep.floor,
                    "values": [
                        {"date": d, "value": depreciation.value_of(dep, d)}
                        for d in _probe_dates(dep.purchase_date, ctx.as_of)
                    ],
                }
                for dep in curves
            ],
        }
    return out


CHECKS = [
    Check("loans.valuation", loans, {"summary.id": "loans"}),
    Check("assets.depreciation", assets, {"manual_rows.id": "accounts"}),
]
