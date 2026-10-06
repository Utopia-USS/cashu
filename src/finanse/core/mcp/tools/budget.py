"""Budget MCP tools (thin adapters over ``modules.budget`` analytics): ``spending_breakdown``,
``cashflow_summary``, ``recurring_payments``, ``uncategorized_merchants``, ``set_merchant_category``.

Per currency, never summed across currencies. In strict mode amounts become shares of a stated base
(the period's spending, the month's average spending, the uncategorized spending). Merchants are sent
(upstream rule) except private-person transfer payees (``core.mcp.names``).
"""

from __future__ import annotations

import re
from collections import defaultdict
from decimal import Decimal

from sqlalchemy import inspect as sa_inspect
from sqlmodel import Session, func

from finanse.core.accounts import own_ibans
from finanse.core.text import iban_key

from .. import labels as L
from ..names import looks_like_person, normalize
from ..registry import ToolContext, ToolError, ToolSpec

_PERIOD = re.compile(r"^(\d{4})(?:-(?:(\d{2})|Q([1-4])))?$")
# Words of a person-to-person transfer title (normalized text: upper case, no diacritics).
_TRANSFER_WORDS = re.compile(
    r"\b(?:PRZELEW\w*|BLIK|TRANSFER|P2P|NA TELEFON|ZWROT DLA|DLA|OD|DO|PRZEKAZ\w*)\b"
)


def _tables_present(session: Session) -> bool:
    return "transactions" in sa_inspect(session.get_bind()).get_table_names()


def name_sources(session: Session, profile_id: int) -> tuple[set[str], set[str]]:
    """(person names, private payee merchant keys) from the profile's bank transactions: the
    counterparties of own-account transfers (the owner) and bank-transfer payees that look like a
    private person."""
    if not _tables_present(session):
        return set(), set()
    from finanse.modules.budget.ingestion.normalize import merchant_key
    from finanse.modules.budget.models import Transaction
    from finanse.modules.budget.queries import transactions

    own = own_ibans(session, profile_id)
    persons: set[str] = set()
    private: set[str] = set()
    query = transactions(profile_id, Transaction.counterparty_name.is_not(None)).with_only_columns(
        Transaction.counterparty_name,
        Transaction.counterparty_iban,
        Transaction.is_internal_transfer,
    )
    for name, iban, internal in session.execute(query.distinct()).all():
        if not name:
            continue
        if internal or (iban and iban_key(iban) in own):
            persons.add(name)
        elif iban and looks_like_person(name):
            private.add(merchant_key(name))
    # A transfer without a counterparty name (a bank transfer, a BLIK phone transfer) is known by
    # its title, free text written by a person and often naming one: always sent as a reference.
    titled = transactions(profile_id, Transaction.counterparty_name.is_(None)).with_only_columns(
        Transaction.reference, Transaction.description, Transaction.counterparty_iban
    )
    for reference, description, iban in session.execute(titled.distinct()).all():
        key = merchant_key(None, reference, description)
        text = normalize(f"{reference or ''} {description or ''}")
        if key and (iban or _TRANSFER_WORDS.search(text)):
            private.add(key)
    return persons, private


def freshness(ctx: ToolContext) -> dict:
    from finanse.modules.budget.analytics import reference_date
    from finanse.modules.budget.models import Transaction
    from finanse.modules.budget.queries import transactions

    count = ctx.session.exec(
        transactions(ctx.profile_id).with_only_columns(func.count(Transaction.id))
    ).one()
    return {
        "transactions_newest": L.date(reference_date(ctx.session, profile_id=ctx.profile_id)),
        "transactions": L.count(int(count)),
    }


def _currency(ctx: ToolContext, currency: str | None) -> str:
    cur = (currency or ctx.profile.base_currency or "PLN").strip().upper()
    if not re.fullmatch(r"[A-Z]{3}", cur):
        raise ToolError("currency must be a 3-letter code")
    return cur


def _period(ctx: ToolContext, period: str | None, currency: str):
    from finanse.modules.budget.analytics import reference_date

    if not period:
        ref = reference_date(ctx.session, profile_id=ctx.profile_id)
        if ref is None:
            return None, None, None, None
        return ref.year, ref.month, None, f"{ref.year}-{ref.month:02d}"
    m = _PERIOD.match(period.strip())
    if not m:
        raise ToolError("period must look like 2026, 2026-09 or 2026-Q3")
    year = int(m.group(1))
    month = int(m.group(2)) if m.group(2) else None
    quarter = int(m.group(3)) if m.group(3) else None
    if month is not None and not 1 <= month <= 12:
        raise ToolError("month must be 01-12")
    return year, month, quarter, period.strip()


def _spending_rows(ctx: ToolContext, currency: str, year, month, quarter):
    """Outflows counted as spending (the same filter as ``spending_by_category``)."""
    from finanse.modules.budget.analytics import NON_SPENDING_CATEGORIES, _in_period
    from finanse.modules.budget.ingestion.normalize import merchant_key
    from finanse.modules.budget.models import Transaction
    from finanse.modules.budget.queries import transactions

    own = own_ibans(ctx.session, ctx.profile_id)
    for t in ctx.session.exec(transactions(ctx.profile_id, Transaction.currency == currency)).all():
        if t.amount >= 0 or t.is_internal_transfer or t.category in NON_SPENDING_CATEGORIES:
            continue
        cp = iban_key(t.counterparty_iban) if t.counterparty_iban else ""
        if cp and cp in own:
            continue
        if year is not None and not _in_period(t.booking_date, year, month, quarter):
            continue
        yield t, merchant_key(t.counterparty_name, t.reference, t.description)


def spending_breakdown(
    ctx: ToolContext, period: str | None = None, currency: str | None = None, top: int = 10
) -> dict:
    from finanse.modules.budget.categorize import taxonomy

    cur = _currency(ctx, currency)
    year, month, quarter, label = _period(ctx, period, cur)
    by_cat: dict[str, Decimal] = defaultdict(Decimal)
    by_merchant: dict[str, list] = defaultdict(lambda: [Decimal(0), 0])
    total = Decimal(0)
    if label is not None:
        for t, mk in _spending_rows(ctx, cur, year, month, quarter):
            amount = -t.amount
            total += amount
            by_cat[t.category or "other"] += amount
            if mk:
                by_merchant[mk][0] += amount
                by_merchant[mk][1] += 1
    merchants = sorted(by_merchant.items(), key=lambda kv: -kv[1][0])[:top]
    return {
        "currency": L.category(cur),
        "period": L.text(label),
        "base_note": L.text("shares are of the period's total spending in this currency"),
        "total": L.amount(total),
        "categories": [
            {
                "category": L.category(k),
                "label": L.text(taxonomy.LABELS.get(k, k)),
                "share": L.share(v, total),
                "amount": L.amount(v),
            }
            for k, v in sorted(by_cat.items(), key=lambda kv: -kv[1])
        ],
        "top_merchants": [
            {
                "merchant": L.merchant(mk),
                "share": L.share(v[0], total),
                "count": L.count(v[1]),
                "amount": L.amount(v[0]),
            }
            for mk, v in merchants
        ],
    }


def cashflow_summary(ctx: ToolContext, months: int = 12, currency: str | None = None) -> dict:
    from finanse.modules.budget.analytics import monthly_cashflow

    cur = _currency(ctx, currency)
    rows = monthly_cashflow(ctx.session, currency=cur, profile_id=ctx.profile_id)[-months:]
    income = sum((r.income for r in rows), Decimal(0))
    expense = sum((r.expense for r in rows), Decimal(0))
    return {
        "currency": L.category(cur),
        "months": L.count(len(rows)),
        "savings_rate": L.share(income - expense, income),
        "income_expense_ratio": L.pct(income / expense if expense else None),
        "deficit_months": [L.text(r.label) for r in rows if r.net < 0],
        "income": L.amount(income),
        "expense": L.amount(expense),
        "monthly": [
            {
                "month": L.text(r.label),
                "savings_rate": L.share(r.net, r.income),
                "expense_vs_average": L.share(r.expense, expense / len(rows))
                if rows
                else L.pct(None),
                "deficit": L.flag(r.net < 0),
                "income": L.amount(r.income),
                "expense": L.amount(r.expense),
                "net": L.amount(r.net),
            }
            for r in rows
        ],
    }


def _average_monthly_expense(ctx: ToolContext, currency: str, months: int = 3) -> Decimal | None:
    from finanse.modules.budget.analytics import monthly_cashflow

    rows = monthly_cashflow(ctx.session, currency=currency, profile_id=ctx.profile_id)[-months:]
    if not rows:
        return None
    return sum((r.expense for r in rows), Decimal(0)) / len(rows)


def recurring_payments(ctx: ToolContext) -> dict:
    from finanse.modules.budget.analytics import active_recurring, detect_recurring

    rows = detect_recurring(ctx.session, profile_id=ctx.profile_id)
    active = {
        (c.counterparty, c.currency, c.typical_amount)
        for c in active_recurring(ctx.session, profile_id=ctx.profile_id)
    }
    averages: dict[str, Decimal | None] = {}
    items = []
    for c in rows:
        if c.currency not in averages:
            averages[c.currency] = _average_monthly_expense(ctx, c.currency)
        items.append(
            {
                "merchant": L.merchant(c.counterparty),
                "currency": L.category(c.currency),
                "cadence_days": L.count(c.median_gap_days),
                "occurrences": L.count(c.occurrences),
                "months_covered": L.count(c.months_covered),
                "last": L.date(c.last_date),
                "active": L.flag((c.counterparty, c.currency, c.typical_amount) in active),
                "share_of_monthly_spending": L.share(c.typical_amount, averages[c.currency]),
                "typical_amount": L.amount(c.typical_amount),
            }
        )
    return {
        "base_note": L.text(
            "share_of_monthly_spending: one payment vs the average monthly spending of the last "
            "3 months in that currency"
        ),
        "items": items,
    }


def uncategorized_merchants(ctx: ToolContext, limit: int = 30) -> dict:
    from finanse.modules.budget.ingestion.normalize import merchant_key
    from finanse.modules.budget.queries import transactions

    agg: dict[tuple[str, str], list] = {}
    totals: dict[str, Decimal] = defaultdict(Decimal)
    for t in ctx.session.exec(transactions(ctx.profile_id)).all():
        if t.amount >= 0 or t.is_internal_transfer or t.category_source != "default":
            continue
        mk = merchant_key(t.counterparty_name, t.reference, t.description)
        if not mk:
            continue
        row = agg.setdefault((mk, t.currency), [0, Decimal(0)])
        row[0] += 1
        row[1] += -t.amount
        totals[t.currency] += -t.amount
    rows = sorted(agg.items(), key=lambda kv: (-kv[1][0], -kv[1][1]))[:limit]
    return {
        "base_note": L.text("share: of all uncategorized spending in that currency"),
        "merchants": [
            {
                "merchant": L.merchant(mk),
                "currency": L.category(cur),
                "count": L.count(n),
                "share": L.share(total, totals[cur]),
                "total": L.amount(total),
            }
            for (mk, cur), (n, total) in rows
        ],
        "categories": [L.category(k) for k in _category_keys()],
    }


def _category_keys() -> list[str]:
    from finanse.modules.budget.categorize import taxonomy

    return list(taxonomy.CATEGORY_KEYS)


# Categories the owner (or the app's own structure) decided: an agent rule never overwrites them.
OWNER_SOURCES = frozenset({"manual", "manual_txn", "cash_leg", "transfer"})


def set_merchant_category(ctx: ToolContext, merchant: str, category: str) -> dict:
    """A learned rule from the agent: stored like an LLM rule (not locked), so the owner's manual
    rule for the merchant wins, and only transactions the owner did not categorize by hand change."""
    from finanse.modules.budget.categorize.rules import upsert_rule
    from finanse.modules.budget.ingestion.normalize import merchant_key

    if category not in _category_keys():
        raise ToolError("unknown category; uncategorized_merchants lists the categories")
    rows = _all_transactions(ctx)
    keys = {merchant_key(t.counterparty_name, t.reference, t.description) for t in rows}
    keys.discard("")
    key = ctx.guard.resolve(merchant, keys)
    if key is None:
        raise ToolError("no such merchant in this profile's transactions", "not_found")
    rule = upsert_rule(
        ctx.session, key, category, source="llm", locked=False, profile_id=ctx.profile_id
    )
    if rule.locked and rule.category != category:
        return {
            "merchant": L.merchant(key),
            "category": L.category(rule.category),
            "updated_transactions": L.count(0),
            "rule": L.text("kept: the owner set this merchant's category by hand"),
        }
    updated = 0
    for t in rows:
        if merchant_key(t.counterparty_name, t.reference, t.description) != key:
            continue
        if t.category_source in OWNER_SOURCES or t.is_internal_transfer:
            continue
        t.category, t.category_source = category, "llm"
        ctx.session.add(t)
        updated += 1
    return {
        "merchant": L.merchant(key),
        "category": L.category(category),
        "updated_transactions": L.count(updated),
        "rule": L.text(
            "learned rule saved for this profile (like an LLM rule: the owner's manual choices win)"
        ),
    }


def _all_transactions(ctx: ToolContext):
    from finanse.modules.budget.queries import transactions

    return ctx.session.exec(transactions(ctx.profile_id)).all()


_CURRENCY = {
    "type": "string",
    "maxLength": 3,
    "description": "3-letter code (default: base currency)",
}

def validate_budget_import(ctx: ToolContext, path: str) -> dict:
    from finanse.modules.budget.ingestion.canonical import validate_budget_document

    from .exports import checked_local_file

    p = checked_local_file(path, ctx.profile.slug, ("json", "csv"))
    if p.stat().st_size > 20 * 1024 * 1024:
        raise ToolError("file is too large (max 20 MB)")
    report = validate_budget_document(p.read_bytes(), p.name)
    by_kind: dict[str, int] = defaultdict(int)
    for issue in report.issues:
        by_kind[issue.kind] += 1
    return {
        "ok": L.flag(report.ok),
        "variant": L.category(report.variant),
        "transactions": L.count(report.transactions),
        "balances": L.count(report.balances),
        "date_from": L.date(report.date_range[0] if report.date_range else None),
        "date_to": L.date(report.date_range[1] if report.date_range else None),
        "currencies": [L.category(c) for c in report.currencies],
        "issues_by_kind": {k: L.count(v) for k, v in sorted(by_kind.items())},
        "issues": [
            {
                "kind": L.category(i.kind),
                "blocking": L.flag(i.blocking),
                "row": L.count(i.row),
                "field": L.text(i.field),
                "message": L.text(i.message),
            }
            for i in report.issues[:50]
        ],
    }


TOOLS = (
    ToolSpec(
        "spending_breakdown",
        "budget",
        "Spending in a period (2026, 2026-09 or 2026-Q3; default: the latest month with data): "
        "category shares and top merchants with shares, in one currency.",
        spending_breakdown,
        properties={
            "period": {"type": "string", "maxLength": 7},
            "currency": _CURRENCY,
            "top": {"type": "integer", "minimum": 1, "maximum": 50, "default": 10},
        },
    ),
    ToolSpec(
        "cashflow_summary",
        "budget",
        "Savings rate %, income/expense ratio, months with a deficit over the last N months.",
        cashflow_summary,
        properties={
            "months": {"type": "integer", "minimum": 1, "maximum": 120, "default": 12},
            "currency": _CURRENCY,
        },
    ),
    ToolSpec(
        "recurring_payments",
        "budget",
        "Recurring payments (likely subscriptions): merchant, cadence, share of monthly spending.",
        recurring_payments,
    ),
    ToolSpec(
        "uncategorized_merchants",
        "budget",
        "Merchants without a category (by count) and the list of category keys for "
        "set_merchant_category.",
        uncategorized_merchants,
        properties={"limit": {"type": "integer", "minimum": 1, "maximum": 200, "default": 30}},
    ),
    ToolSpec(
        "set_merchant_category",
        "budget",
        "Teach the profile a category for a merchant (a learned rule; also re-categorizes its "
        "transactions). merchant: the name as listed, or a payee:... reference.",
        set_merchant_category,
        properties={
            "merchant": {"type": "string", "maxLength": 200},
            "category": {"type": "string", "maxLength": 40},
        },
        required=("merchant", "category"),
        write=True,
    ),
    ToolSpec(
        "validate_budget_import",
        "budget",
        "Validate a finanse-budget-import document (JSON or CSV; e.g. your connector's or converter's "
        "output): ok, transaction and balance counts, date range, currencies, and issues by kind with "
        "row numbers and field names, no values. Nothing is imported.",
        validate_budget_import,
        properties={"path": {"type": "string", "maxLength": 1024}},
        required=("path",),
    ),
)
