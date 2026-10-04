"""FastAPI app serving the dashboard + JSON API over the local finance DB."""

from __future__ import annotations

from contextlib import asynccontextmanager
from decimal import Decimal
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from sqlmodel import select

from .. import analytics
from ..core import security
from ..db import get_session, init_db
from ..models import Account

STATIC = Path(__file__).parent / "static"
WEBDIST = Path(__file__).parent / "webdist"  # built React SPA (frontend/ → npm run build)


@asynccontextmanager
async def _lifespan(_app: FastAPI):
    init_db()
    yield


app = FastAPI(title="finanse", docs_url="/api/docs", lifespan=_lifespan)
# Host allowlist (127.0.0.1/localhost on the serving port) + X-Finanse-Token on
# every /api/* request; no CORS middleware on purpose. See core/security.py.
app.add_middleware(security.LocalOnlyMiddleware)


def _f(value: Decimal | None) -> float | None:
    return float(value) if value is not None else None


def _account_row(acc: Account, contribution: Decimal | None, as_of) -> dict:
    return {
        "id": acc.id,
        "bank": acc.bank.value,
        "name": acc.name,
        "type": acc.type.value,
        "currency": acc.currency,
        "iban_tail": (acc.iban or "")[-4:],
        "balance": _f(contribution),
        "as_of": as_of.isoformat() if as_of else None,
        "is_liability": acc.type.value == "credit",
    }


def _breakdown_dict(bd) -> dict:
    return {
        "currency": bd.currency,
        "assets": _f(bd.assets),
        "liabilities": _f(bd.liabilities),
        "net": _f(bd.net),
        "property": _f(bd.property_value),
        "mortgage": _f(bd.mortgage),
        "home_equity": _f(bd.home_equity),
        "by_type": {k: _f(v) for k, v in bd.by_type.items()},
    }


@app.get("/api/summary")
def summary() -> dict:
    with get_session() as s:
        totals, _lines = analytics.net_worth(s)
        bd = analytics.net_worth_breakdown(s)
        cashflow = analytics.monthly_cashflow(s)
        active = analytics.active_recurring(s)
    month = cashflow[-1] if cashflow else None
    # Per currency, never summed across currencies. `monthly_total` stays for the
    # legacy dashboard and is the PLN total only.
    monthly_subs: dict[str, Decimal] = {}
    for c in active:
        monthly_subs[c.currency] = monthly_subs.get(c.currency, Decimal(0)) + c.typical_amount
    return {
        "networth": {cur: _f(v) for cur, v in sorted(totals.items())},
        "breakdown": _breakdown_dict(bd),
        "month": (
            {
                "label": month.label,
                "income": _f(month.income),
                "expense": _f(month.expense),
                "net": _f(month.net),
            }
            if month
            else None
        ),
        "subscriptions": {
            "count": len(active),
            "monthly_total": _f(monthly_subs.get("PLN", Decimal(0))),
            "monthly_totals": {cur: _f(v) for cur, v in sorted(monthly_subs.items())},
        },
    }


@app.get("/api/networth")
def networth() -> dict:
    with get_session() as s:
        totals, lines = analytics.net_worth(s)
        bd = analytics.net_worth_breakdown(s)
        accounts = [_account_row(ln.account, ln.contribution, ln.as_of) for ln in lines]
    return {
        "totals": {cur: _f(v) for cur, v in sorted(totals.items())},
        "breakdown": _breakdown_dict(bd),
        "accounts": accounts,
    }


@app.get("/api/networth/series")
def networth_series(
    currency: str = "PLN", granularity: str = "daily", scope: str = "total"
) -> dict:
    with get_session() as s:
        series = analytics.net_worth_component_series(
            s, currency=currency, granularity=granularity, scope=scope
        )
    present = [k for k in analytics.NW_COMPONENT_ORDER if any(k in comps for _, comps in series)]
    points = [
        {
            "date": d.isoformat(),
            "value": _f(sum(comps.values(), Decimal("0"))),
            "components": {k: _f(comps[k]) for k in present if k in comps},
        }
        for d, comps in series
    ]
    return {
        "points": points,
        "components": [
            {"key": k, "label": analytics.NW_COMPONENT_LABELS[k], "liability": k in ("mortgage", "loan")}
            for k in present
        ],
    }


@app.get("/api/cashflow")
def cashflow(currency: str = "PLN", months: int = 24) -> list[dict]:
    with get_session() as s:
        rows = analytics.monthly_cashflow(s, currency=currency)
    return [
        {
            "label": mc.label,
            "income": _f(mc.income),
            "expense": _f(mc.expense),
            "net": _f(mc.net),
        }
        for mc in rows[-months:]
    ]


@app.get("/api/recurring")
def recurring() -> dict:
    with get_session() as s:
        active = analytics.active_recurring(s)
        allrec = analytics.detect_recurring(s)
    active_keys = {(c.counterparty, c.currency, c.typical_amount) for c in active}
    return {
        "items": [
            {
                "payee": c.counterparty,
                "amount": _f(c.typical_amount),
                "currency": c.currency,
                "count": c.occurrences,
                "gap_days": c.median_gap_days,
                "last": c.last_date.isoformat(),
                "active": (c.counterparty, c.currency, c.typical_amount) in active_keys,
            }
            for c in allrec
        ]
    }


@app.get("/api/accounts")
def accounts() -> list[dict]:
    with get_session() as s:
        rows = s.exec(select(Account)).all()
        return [_account_row(a, None, None) | {"active": a.active} for a in rows]


@app.get("/api/categories")
def categories() -> list[dict]:
    from ..categorize import taxonomy

    return [{"key": c.key, "label": c.label, "kind": c.kind} for c in taxonomy.CATEGORIES]


@app.get("/api/spending")
def spending(
    year: int | None = None,
    month: int | None = None,
    quarter: int | None = None,
    currency: str = "PLN",
) -> list[dict]:
    with get_session() as s:
        rows = analytics.spending_by_category(
            s, currency=currency, year=year, month=month, quarter=quarter
        )
    return [{"category": r.category, "label": r.label, "amount": _f(r.amount)} for r in rows]


@app.get("/api/uncategorized")
def uncategorized(limit: int = 30, currency: str = "PLN") -> list[dict]:
    """Top expense merchants we couldn't confidently categorize — for review.

    Filtered to a single currency (default PLN) so amounts aren't mixed across
    HUF/EUR/NOK accounts and mislabeled.
    """
    from ..ingestion.normalize import merchant_key
    from ..models import Transaction

    agg: dict[str, dict] = {}
    with get_session() as s:
        for t in s.exec(select(Transaction).where(Transaction.currency == currency)).all():
            if t.amount >= 0 or t.is_internal_transfer or t.category_source != "default":
                continue
            mk = merchant_key(t.counterparty_name, t.reference, t.description)
            if not mk:
                continue
            a = agg.setdefault(
                mk,
                {"merchant_key": mk, "sample": (t.reference or t.description or mk),
                 "count": 0, "total": Decimal("0")},
            )
            a["count"] += 1
            a["total"] += -t.amount
    rows = sorted(agg.values(), key=lambda x: x["total"], reverse=True)[:limit]
    return [
        {"merchant_key": r["merchant_key"], "sample": r["sample"],
         "count": r["count"], "total": _f(r["total"]), "currency": currency}
        for r in rows
    ]


@app.post("/api/merchant-category")
def set_merchant_category(payload: dict) -> dict:
    from ..categorize import taxonomy
    from ..service import recategorize_merchant

    mk = (payload or {}).get("merchant_key")
    cat = (payload or {}).get("category")
    if not mk or cat not in taxonomy.CATEGORY_KEYS:
        return {"error": "invalid merchant_key or category"}
    with get_session() as s:
        n = recategorize_merchant(s, mk, cat)
    return {"updated": n}


@app.get("/api/category/{key}/transactions")
def category_transactions(
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
            year=year, month=month, quarter=quarter,
        )
    return [{**r, "amount": _f(r["amount"])} for r in rows]


@app.post("/api/transactions/{txn_id}/category")
def set_transaction_category(txn_id: int, payload: dict) -> dict:
    from ..categorize import taxonomy
    from ..service import set_transaction_category as _set

    cat = (payload or {}).get("category")
    if cat not in taxonomy.CATEGORY_KEYS:
        return {"error": "invalid category"}
    with get_session() as s:
        ok = _set(s, txn_id, cat)
    return {"ok": ok}


@app.get("/api/cash")
def cash(currency: str = "PLN") -> dict:
    """The cash pool: balance + its transactions (withdrawals in, expenses out)."""
    from ..categorize import taxonomy
    from ..models import Transaction
    from ..service import get_cash_account

    with get_session() as s:
        acc = get_cash_account(s, currency, create=False)
        if acc is None:
            return {"exists": False, "currency": currency, "balance": 0.0,
                    "withdrawals": 0.0, "expenses": 0.0, "transactions": []}
        txns = s.exec(select(Transaction).where(Transaction.account_id == acc.id)).all()
        balance = sum((t.amount for t in txns), Decimal("0"))
        withdrawals = sum((t.amount for t in txns if t.amount > 0), Decimal("0"))
        expenses = sum((-t.amount for t in txns if t.amount < 0), Decimal("0"))
        rows = sorted(txns, key=lambda t: (t.booking_date, t.id or 0), reverse=True)
        return {
            "exists": True,
            "account_id": acc.id,
            "currency": acc.currency,
            "balance": _f(balance),
            "withdrawals": _f(withdrawals),
            "expenses": _f(expenses),
            "transactions": [
                {
                    "id": t.id,
                    "date": t.booking_date.isoformat(),
                    "amount": _f(t.amount),
                    "title": t.reference or t.description or t.counterparty_name or "—",
                    "category": t.category,
                    "category_label": taxonomy.LABELS.get(t.category, t.category),
                    "kind": "withdrawal" if t.amount > 0 else "expense",
                }
                for t in rows
            ],
        }


@app.post("/api/cash/expense")
def add_cash_expense_ep(payload: dict) -> dict:
    from ..categorize import taxonomy
    from ..service import add_cash_expense

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
            currency=p.get("currency", "PLN"), on_date=on_date,
        )
        return {"ok": True, "id": t.id}


@app.delete("/api/cash/transaction/{txn_id}")
def delete_cash_txn_ep(txn_id: int) -> dict:
    from ..service import delete_cash_transaction

    with get_session() as s:
        ok = delete_cash_transaction(s, txn_id)
    return {"ok": ok}


def _eb_client():
    from ..config import settings
    from ..ingestion.enable_banking import EnableBankingClient

    return EnableBankingClient(
        settings.eb_app_id or "",
        settings.eb_key_file,
        base_url=settings.eb_base_url,
        redirect_url=settings.eb_redirect_url,
    )


@app.post("/api/resync")
def resync(days: int = 90) -> dict:
    """Re-sync every saved Enable Banking session, then re-match transfers and
    re-categorize — the dashboard equivalent of `finanse eb resync`."""
    from ..config import settings
    from ..ingestion.enable_banking.client import EnableBankingError
    from ..ingestion.enable_banking.state import load_sessions
    from ..ingestion.enable_banking.sync import (
        fetch_session,
        reprocess_open_banking_fields,
        store_account,
    )
    from ..ingestion.transfers import match_internal_transfers
    from ..models import Bank
    from ..service import categorize_all

    if not settings.eb_configured:
        return {"ok": False, "error": "Enable Banking nie jest skonfigurowany (.env)."}
    sessions = load_sessions()
    if not sessions:
        return {"ok": False, "error": "Brak zapisanych sesji — zaloguj się: finanse eb login."}

    client = _eb_client()
    errors: list[str] = []
    # 1. Network: fetch every saved session with no DB transaction open (bank
    #    calls can take minutes with 429 retries; a held write lock would make
    #    every concurrent CLI/UI write fail with "database is locked").
    fetched = []
    for bank_val, sid in sessions.items():
        try:
            fs = fetch_session(client, sid, bank=Bank(bank_val), days=days)
        except EnableBankingError as e:  # expired/rate-limited session — try the rest
            errors.append(f"{bank_val}: {e}")
            continue
        errors.extend(fs.errors)
        fetched.append((bank_val, fs))

    # 2. DB: one short write transaction per account.
    banks_out: list[dict] = []
    total_inserted = 0
    for bank_val, fs in fetched:
        inserted = stored = 0
        for fa in fs.accounts:
            try:
                with get_session() as s:  # commits on exit
                    n = store_account(s, fa, fs.bank).batch.num_inserted
            except Exception as e:  # noqa: BLE001 - one bad account must not abort the rest
                errors.append(f"{fa.uid}: {e}")
                continue
            inserted += n
            stored += 1
        total_inserted += inserted
        banks_out.append({"bank": bank_val, "inserted": inserted, "accounts": stored})

    with get_session() as s:
        reprocess_open_banking_fields(s)  # keep titles/notes readable (not the bank id)
        pairs = match_internal_transfers(s)
        categorize_all(s)
    return {
        "ok": True,
        "inserted": total_inserted,
        "banks": banks_out,
        "pairs": pairs,
        "errors": errors,
    }


@app.get("/api/loan")
def loan_info() -> dict:
    from datetime import date as _date

    from .. import loan as loanmod
    from ..models import Account, Loan

    with get_session() as s:
        loan = s.exec(select(Loan)).first()
        if loan is None:
            return {"has_loan": False}
        acc = s.get(Account, loan.account_id)
        summ = loanmod.summarize(
            loan.principal, loan.annual_rate, loan.term_months, loan.start_date, _date.today(),
            origination_date=loan.origination_date,
        )
    return {
        "has_loan": True,
        "currency": acc.currency if acc else "PLN",
        "principal": _f(summ.principal),
        "annual_rate": _f(summ.annual_rate),
        "term_months": summ.term_months,
        "monthly_payment": _f(summ.monthly_payment),
        "start_date": summ.start_date.isoformat(),
        "outstanding": _f(summ.outstanding),
        "months_elapsed": summ.months_elapsed,
        "paid_principal": _f(summ.paid_principal),
        "paid_interest": _f(summ.paid_interest),
        "remaining_interest": _f(summ.remaining_interest),
        "total_interest": _f(summ.total_interest),
        "payoff_date": summ.payoff_date.isoformat(),
        "series": [{"date": r.date.isoformat(), "balance": _f(r.balance)} for r in summ.schedule],
        "schedule": [
            {
                "n": r.n,
                "date": r.date.isoformat(),
                "payment": _f(r.payment),
                "interest": _f(r.interest),
                "principal": _f(r.principal),
                "balance": _f(r.balance),
            }
            for r in summ.schedule
        ],
    }


@app.get("/")
def index() -> HTMLResponse:
    # Prefer the built React SPA; fall back to the legacy single-file dashboard.
    # The per-launch API token rides along as a <meta> tag (the Host check makes
    # this response readable only by the dashboard's own origin).
    spa = WEBDIST / "index.html"
    page = (spa if spa.exists() else STATIC / "index.html").read_text(encoding="utf-8")
    html = security.inject_token_meta(page, security.get_config().token)
    return HTMLResponse(html, headers={"Cache-Control": "no-store"})


if (WEBDIST / "assets").is_dir():
    app.mount("/assets", StaticFiles(directory=WEBDIST / "assets"), name="assets")
app.mount("/static", StaticFiles(directory=STATIC), name="static")
