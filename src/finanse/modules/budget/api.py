"""Budget API routes: cashflow, spending, categories, recurring, cash pool, resync."""

from __future__ import annotations

from decimal import Decimal

from fastapi import APIRouter
from sqlmodel import select

from finanse.core.api import CurrentProfile, f
from finanse.core.db import get_session

from . import analytics
from .models import Transaction
from .queries import transactions

router = APIRouter()


@router.get("/cashflow")
def cashflow(profile: CurrentProfile, currency: str = "PLN", months: int = 24) -> list[dict]:
    with get_session() as s:
        rows = analytics.monthly_cashflow(s, currency=currency, profile_id=profile.id)
    return [
        {
            "label": mc.label,
            "income": f(mc.income),
            "expense": f(mc.expense),
            "net": f(mc.net),
        }
        for mc in rows[-months:]
    ]


@router.get("/recurring")
def recurring(profile: CurrentProfile) -> dict:
    with get_session() as s:
        active = analytics.active_recurring(s, profile_id=profile.id)
        allrec = analytics.detect_recurring(s, profile_id=profile.id)
    active_keys = {(c.counterparty, c.currency, c.typical_amount) for c in active}
    return {
        "items": [
            {
                "payee": c.counterparty,
                "amount": f(c.typical_amount),
                "currency": c.currency,
                "count": c.occurrences,
                "gap_days": c.median_gap_days,
                "last": c.last_date.isoformat(),
                "active": (c.counterparty, c.currency, c.typical_amount) in active_keys,
            }
            for c in allrec
        ]
    }


@router.get("/categories")
def categories() -> list[dict]:
    """The category taxonomy (global, the same for every profile)."""
    from .categorize import taxonomy

    return [{"key": c.key, "label": c.label, "kind": c.kind} for c in taxonomy.CATEGORIES]


@router.get("/spending")
def spending(
    profile: CurrentProfile,
    year: int | None = None,
    month: int | None = None,
    quarter: int | None = None,
    currency: str = "PLN",
) -> list[dict]:
    with get_session() as s:
        rows = analytics.spending_by_category(
            s, currency=currency, year=year, month=month, quarter=quarter,
            profile_id=profile.id,
        )
    return [{"category": r.category, "label": r.label, "amount": f(r.amount)} for r in rows]


@router.get("/uncategorized")
def uncategorized(profile: CurrentProfile, limit: int = 30, currency: str = "PLN") -> list[dict]:
    """Top expense merchants we couldn't confidently categorize — for review.

    Filtered to a single currency (default PLN) so amounts aren't mixed across
    HUF/EUR/NOK accounts and mislabeled.
    """
    from .ingestion.normalize import merchant_key

    agg: dict[str, dict] = {}
    with get_session() as s:
        for t in s.exec(transactions(profile.id, Transaction.currency == currency)).all():
            if t.amount >= 0 or t.is_internal_transfer or t.category_source != "default":
                continue
            mk = merchant_key(t.counterparty_name, t.reference, t.description)
            if not mk:
                continue
            a = agg.setdefault(
                mk,
                {"merchant_key": mk, "sample": (t.reference or t.description or mk),
                 "count": 0, "total": Decimal(0)},
            )
            a["count"] += 1
            a["total"] += -t.amount
    rows = sorted(agg.values(), key=lambda x: x["total"], reverse=True)[:limit]
    return [
        {"merchant_key": r["merchant_key"], "sample": r["sample"],
         "count": r["count"], "total": f(r["total"]), "currency": currency}
        for r in rows
    ]


@router.post("/merchant-category")
def set_merchant_category(profile: CurrentProfile, payload: dict) -> dict:
    from .categorize import taxonomy
    from .service import recategorize_merchant

    mk = (payload or {}).get("merchant_key")
    cat = (payload or {}).get("category")
    if not mk or cat not in taxonomy.CATEGORY_KEYS:
        return {"error": "invalid merchant_key or category"}
    with get_session() as s:
        n = recategorize_merchant(s, mk, cat, profile_id=profile.id)
    return {"updated": n}


@router.get("/category/{key}/transactions")
def category_transactions(
    profile: CurrentProfile,
    key: str,
    sort: str = "date",
    order: str = "desc",
    currency: str = "PLN",
    year: int | None = None,
    month: int | None = None,
    quarter: int | None = None,
) -> list[dict]:
    with get_session() as s:
        rows = analytics.category_transactions(
            s, key, currency=currency, sort=sort, order=order,
            year=year, month=month, quarter=quarter, profile_id=profile.id,
        )
    return [{**r, "amount": f(r["amount"])} for r in rows]


@router.post("/transactions/{txn_id}/category")
def set_transaction_category(profile: CurrentProfile, txn_id: int, payload: dict) -> dict:
    from .categorize import taxonomy
    from .service import set_transaction_category as _set

    cat = (payload or {}).get("category")
    if cat not in taxonomy.CATEGORY_KEYS:
        return {"error": "invalid category"}
    with get_session() as s:
        ok = _set(s, txn_id, cat, profile_id=profile.id)
    return {"ok": ok}


@router.get("/cash")
def cash(profile: CurrentProfile, currency: str = "PLN") -> dict:
    """The cash pool: balance + its transactions (withdrawals in, expenses out)."""
    from .cash import get_cash_account
    from .categorize import taxonomy

    with get_session() as s:
        acc = get_cash_account(s, currency, create=False, profile_id=profile.id)
        if acc is None:
            return {"exists": False, "currency": currency, "balance": 0.0,
                    "withdrawals": 0.0, "expenses": 0.0, "transactions": []}
        txns = s.exec(select(Transaction).where(Transaction.account_id == acc.id)).all()
        balance = sum((t.amount for t in txns), Decimal(0))
        withdrawals = sum((t.amount for t in txns if t.amount > 0), Decimal(0))
        expenses = sum((-t.amount for t in txns if t.amount < 0), Decimal(0))
        rows = sorted(txns, key=lambda t: (t.booking_date, t.id or 0), reverse=True)
        return {
            "exists": True,
            "account_id": acc.id,
            "currency": acc.currency,
            "balance": f(balance),
            "withdrawals": f(withdrawals),
            "expenses": f(expenses),
            "transactions": [
                {
                    "id": t.id,
                    "date": t.booking_date.isoformat(),
                    "amount": f(t.amount),
                    "title": t.reference or t.description or t.counterparty_name or "—",
                    "category": t.category,
                    "category_label": taxonomy.LABELS.get(t.category, t.category),
                    "kind": "withdrawal" if t.amount > 0 else "expense",
                }
                for t in rows
            ],
        }


@router.post("/cash/expense")
def add_cash_expense_ep(profile: CurrentProfile, payload: dict) -> dict:
    from .cash import add_cash_expense
    from .categorize import taxonomy

    p = payload or {}
    try:
        amount = float(p.get("amount"))
    except (TypeError, ValueError):
        return {"error": "invalid amount"}
    title = (p.get("title") or "").strip()
    category = p.get("category")
    if amount <= 0:
        return {"error": "amount must be positive"}
    if not title:
        return {"error": "title required"}
    if category not in taxonomy.CATEGORY_KEYS:
        return {"error": "invalid category"}
    on_date = None
    if p.get("date"):
        from datetime import date as _date

        try:
            on_date = _date.fromisoformat(p["date"])
        except ValueError:
            return {"error": "invalid date"}
    with get_session() as s:
        t = add_cash_expense(
            s, amount=amount, title=title, category=category,
            currency=p.get("currency", "PLN"), on_date=on_date, profile_id=profile.id,
        )
        return {"ok": True, "id": t.id}


@router.delete("/cash/transaction/{txn_id}")
def delete_cash_txn_ep(profile: CurrentProfile, txn_id: int) -> dict:
    from .cash import delete_cash_transaction

    with get_session() as s:
        ok = delete_cash_transaction(s, txn_id, profile_id=profile.id)
    return {"ok": ok}


def _eb_client():
    from finanse.config import settings

    from .ingestion.enable_banking import EnableBankingClient

    return EnableBankingClient(
        settings.eb_app_id or "",
        settings.eb_key_file,
        base_url=settings.eb_base_url,
        redirect_url=settings.eb_redirect_url,
    )


@router.post("/resync")
def resync(profile: CurrentProfile, days: int = 90) -> dict:
    """Re-sync every saved Enable Banking session of the profile, then re-match
    transfers and re-categorize — the dashboard equivalent of `finanse eb resync`."""
    from finanse.config import settings
    from finanse.core import profiles

    from .ingestion.enable_banking.client import EnableBankingError
    from .ingestion.enable_banking.state import load_sessions
    from .ingestion.enable_banking.sync import (
        fetch_session,
        reprocess_open_banking_fields,
        store_account,
    )
    from .ingestion.transfers import match_internal_transfers
    from .service import categorize_all

    if not settings.eb_configured:
        return {"ok": False, "error": "Enable Banking nie jest skonfigurowany (.env)."}
    with get_session() as s:
        legacy_owner = profiles.legacy_owner_slug(s)
    sessions = load_sessions(profile.slug, legacy_profile=legacy_owner)
    if not sessions:
        return {"ok": False, "error": "Brak zapisanych sesji — zaloguj się: finanse eb login."}

    client = _eb_client()
    errors: list[str] = []
    # 1. Network: fetch every saved session of the profile with no DB transaction
    #    open (bank calls can take minutes with 429 retries; a held write lock would
    #    make every concurrent CLI/UI write fail with "database is locked").
    fetched = []
    for saved in sessions:
        try:
            fs = fetch_session(client, saved.session_id, bank=saved.institution, days=days)
        except EnableBankingError as e:  # expired/rate-limited session — try the rest
            errors.append(f"{saved.institution}: {e}")
            continue
        errors.extend(fs.errors)
        fetched.append((saved.institution, fs))

    # 2. DB: one short write transaction per account.
    banks_out: list[dict] = []
    total_inserted = 0
    for bank_val, fs in fetched:
        inserted = stored = 0
        for fa in fs.accounts:
            try:
                with get_session() as s:  # commits on exit
                    n = store_account(s, fa, fs.bank, profile_id=profile.id).batch.num_inserted
            except Exception as e:  # noqa: BLE001 - one bad account must not abort the rest
                errors.append(f"{fa.uid}: {e}")
                continue
            inserted += n
            stored += 1
        total_inserted += inserted
        banks_out.append({"bank": bank_val, "inserted": inserted, "accounts": stored})

    with get_session() as s:
        # keep titles/notes readable (not the bank id)
        reprocess_open_banking_fields(s, profile_id=profile.id)
        pairs = match_internal_transfers(s, profile_id=profile.id)
        categorize_all(s, profile_id=profile.id)
    return {
        "ok": True,
        "inserted": total_inserted,
        "banks": banks_out,
        "pairs": pairs,
        "errors": errors,
    }
