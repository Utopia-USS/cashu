"""Budget checks: analytics (``modules/budget/analytics.py``) and the month close
(``modules/budget/monthclose.py``)."""

from __future__ import annotations

from . import Check, Ctx


def _cashflow(rows) -> list[dict]:
    return [
        {
            "year": r.year,
            "month": r.month,
            "label": r.label,
            "income": r.income,
            "expense": r.expense,
            "net": r.net,
        }
        for r in rows
    ]


def _shift(year: int, month: int, delta: int) -> tuple[int, int]:
    n = year * 12 + (month - 1) + delta
    return n // 12, n % 12 + 1


def analytics(ctx: Ctx) -> dict:
    from cashu.modules.budget import analytics as an

    s = ctx.session
    out = {}
    for p in ctx.profiles:
        base = an.base_currency(s, p.id)
        currencies = an.budget_currencies(s, profile_id=p.id)
        ref = an.reference_date(s, profile_id=p.id)
        per_currency = {}
        for cu in currencies:
            c = cu.currency
            spend_all = an.spending_by_category(s, c, profile_id=p.id)
            periods = {}
            if ref is not None:
                for back in range(3):
                    y, m = _shift(ref.year, ref.month, -back)
                    periods[f"{y}-{m:02d}"] = an.spending_by_category(s, c, y, m, profile_id=p.id)
                q = (ref.month - 1) // 3 + 1
                periods[f"{ref.year}-Q{q}"] = an.spending_by_category(
                    s, c, ref.year, quarter=q, profile_id=p.id
                )
                periods[str(ref.year)] = an.spending_by_category(s, c, ref.year, profile_id=p.id)
            # lists of {"category", "rows"}, not dicts keyed by category: a category key such as
            # "loans" must never act as the parent that names the table of a row "id"
            drill = [
                {
                    "category": row.category,
                    "rows": an.category_transactions(s, row.category, c, profile_id=p.id),
                }
                for row in spend_all
            ]
            drill_by_amount = [
                {
                    "category": row.category,
                    "rows": an.category_transactions(
                        s, row.category, c, sort="amount", order="asc", profile_id=p.id
                    ),
                }
                for row in spend_all[:3]
            ]
            per_currency[c] = {
                "cashflow": _cashflow(an.monthly_cashflow(s, c, profile_id=p.id)),
                "cashflow_with_internal": _cashflow(
                    an.monthly_cashflow(s, c, include_internal=True, profile_id=p.id)
                ),
                "spending_all": spend_all,
                "spending_periods": periods,
                "category_transactions": drill,
                "category_transactions_by_amount": drill_by_amount,
            }
        out[ctx.pkey(p)] = {
            "base_currency": base,
            "currencies": currencies,
            "reference_date": ref,
            "per_currency": per_currency,
            "recurring": an.detect_recurring(s, profile_id=p.id),
            "active_recurring": an.active_recurring(s, profile_id=p.id),
            "not_subscription_categories": an.not_subscription_categories(),
        }
    return out


def month_close(ctx: Ctx) -> dict:
    from cashu.modules.budget import monthclose
    from cashu.modules.budget import settings as budget_settings

    s = ctx.session
    out = {}
    for p in ctx.profiles:
        stored = budget_settings.load(p.slug)
        closes = {}
        default = monthclose.month_close(s, p, stored, today=ctx.as_of)
        closes["default"] = {"api": monthclose.as_dict(default), "raw": default}
        for back in range(6):
            y, m = _shift(ctx.as_of.year, ctx.as_of.month, -back)
            close = monthclose.month_close(s, p, stored, year=y, month=m, today=ctx.as_of)
            closes[f"{y}-{m:02d}"] = {"api": monthclose.as_dict(close), "raw": close}
        out[ctx.pkey(p)] = {"settings": stored, "closes": closes}
    return out


CHECKS = [
    Check("budget.analytics", analytics, {"rows.id": "transactions"}),
    Check("budget.month_close", month_close),
]
