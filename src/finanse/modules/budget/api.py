"""Budget API routes: cashflow, spending, categories, recurring, cash pool, resync, month close,
budget settings.

Every currency parameter defaults to the profile's base currency (no PLN assumption); amounts of
different currencies are never summed. ``GET /budget/currencies`` lists the currencies the profile has
data in (the UI's currency picker).
"""

from __future__ import annotations

from decimal import Decimal

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field
from sqlmodel import select

from finanse.core import uploads
from finanse.core.api import CurrentProfile, f
from finanse.core.db import get_session

from . import analytics, imports, monthclose
from . import settings as budget_settings
from .models import Transaction
from .queries import transactions

router = APIRouter()


@router.get("/cashflow")
def cashflow(
    profile: CurrentProfile, currency: str | None = None, months: int = 24
) -> list[dict]:
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
    currency: str | None = None,
) -> list[dict]:
    with get_session() as s:
        rows = analytics.spending_by_category(
            s, currency=currency, year=year, month=month, quarter=quarter,
            profile_id=profile.id,
        )
    return [{"category": r.category, "label": r.label, "amount": f(r.amount)} for r in rows]


@router.get("/uncategorized")
def uncategorized(
    profile: CurrentProfile, limit: int = 30, currency: str | None = None
) -> list[dict]:
    """Top expense merchants we couldn't confidently categorize — for review.

    Filtered to a single currency (default: the profile's base currency) so
    amounts aren't mixed across HUF/EUR/NOK accounts and mislabeled.
    """
    from .ingestion.normalize import merchant_key

    agg: dict[str, dict] = {}
    with get_session() as s:
        currency = currency or analytics.base_currency(s, profile.id)
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
    currency: str | None = None,
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
def cash(profile: CurrentProfile, currency: str | None = None) -> dict:
    """The cash pool: balance + its transactions (withdrawals in, expenses out)."""
    from .cash import get_cash_account
    from .categorize import taxonomy

    with get_session() as s:
        currency = currency or analytics.base_currency(s, profile.id)
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
            currency=p.get("currency") or None, on_date=on_date, profile_id=profile.id,
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
def resync(profile: CurrentProfile, days: int = 90, connectors: bool = True) -> dict:
    """Re-sync every saved Enable Banking session of the profile, then re-match
    transfers and re-categorize - the dashboard equivalent of `finanse eb resync`.
    ``connectors``: also sync the profile's due budget fetch-connector bindings (F10; at most once per
    20 h each, never in a rate-limit backoff), reported under ``connectors``. The worker passes False
    (its ``connectors.fetch`` job does that)."""
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

    synced = _sync_connectors(profile) if connectors else None
    if not settings.eb_configured:
        if synced:
            return _connectors_only(profile, synced)
        return {"ok": False, "error": "Enable Banking nie jest skonfigurowany (.env)."}
    with get_session() as s:
        legacy_owner = profiles.legacy_owner_slug(s)
    sessions = load_sessions(profile.slug, legacy_profile=legacy_owner)
    if not sessions:
        if synced:
            return _connectors_only(profile, synced)
        return {"ok": False, "error": "Brak sesji Enable Banking: zaloguj się: finanse eb login"}

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
    out = {
        "ok": True,
        "inserted": total_inserted,
        "banks": banks_out,
        "pairs": pairs,
        "errors": errors,
    }
    if synced:  # only when a binding exists (the shape stays as before otherwise)
        out["connectors"] = synced
    return out


def _sync_connectors(profile) -> list[dict]:
    """The profile's due budget fetch bindings (owner view: run, preview, proposal / commit)."""
    from finanse.core.connectors import sync

    return sync.summary_dicts(sync.run_due(profile, "budget"))


def _connectors_only(profile, synced: list[dict]) -> dict:
    """No Enable Banking session: only the connectors ran; transfers and categories as usual."""
    from .ingestion.transfers import match_internal_transfers
    from .service import categorize_all

    with get_session() as s:
        pairs = match_internal_transfers(s, profile_id=profile.id)
        categorize_all(s, profile_id=profile.id)
    inserted = sum((c.get("committed") or {}).get("inserted", 0) for c in synced)
    return {
        "ok": True, "inserted": inserted, "banks": [], "pairs": pairs, "errors": [],
        "connectors": synced,
    }


# --------------------------------------------------------------------------- #
# Currencies, month close, budget settings
# --------------------------------------------------------------------------- #


@router.get("/budget/currencies")
def budget_currencies(profile: CurrentProfile) -> dict:
    """Currencies with budget data (base currency first, then by use) and the default one."""
    with get_session() as s:
        base = analytics.base_currency(s, profile.id)
        rows = analytics.budget_currencies(s, profile_id=profile.id)
    codes = [r.currency for r in rows]
    return {
        "base": base,
        "default": base if base in codes or not codes else codes[0],
        "currencies": [
            {
                "currency": r.currency,
                "transactions": r.transactions,
                "first": r.first.isoformat(),
                "last": r.last.isoformat(),
            }
            for r in rows
        ],
    }


@router.get("/budget/month-close")
def month_close(profile: CurrentProfile, month: str | None = None) -> dict:
    """Income, spending by category and surplus of one month per currency, the cushion top-up
    and the suggested transfer to investments, compared with the strategy's planned contribution
    (``month`` = YYYY-MM; default: the newest closed month with data). See ``monthclose``."""
    year = mon = None
    if month:
        try:
            year, mon = monthclose.parse_month(month)
        except ValueError:
            raise HTTPException(status_code=422, detail="month must be YYYY-MM") from None
    stored = budget_settings.load(profile.slug) if profile.id else budget_settings.BudgetSettings()
    with get_session() as s:
        close = monthclose.month_close(s, profile, stored, year=year, month=mon)
        return monthclose.as_dict(close)


@router.get("/budget/settings")
def get_budget_settings(profile: CurrentProfile) -> dict:
    """The profile's budget settings (cushion rule; defaults when never saved)."""
    stored = budget_settings.load(profile.slug) if profile.id else budget_settings.BudgetSettings()
    return budget_settings.to_dict(stored)


@router.put("/budget/settings")
def put_budget_settings(profile: CurrentProfile, payload: dict) -> dict:
    """Replace the budget settings (422 with the reason when invalid). Cushion account ids must
    be the profile's accounts in the cushion currency."""
    try:
        parsed = budget_settings.parse(payload)
    except budget_settings.SettingsError as e:
        raise HTTPException(status_code=422, detail=str(e)) from None
    cushion = parsed.cushion
    if cushion.account_ids:
        from finanse.core.models import Account

        with get_session() as s:
            currency = cushion.currency or analytics.base_currency(s, profile.id)
            rows = s.exec(
                select(Account).where(
                    Account.profile_id == profile.id, Account.id.in_(cushion.account_ids)
                )
            ).all()
        found = {a.id: a for a in rows}
        missing = [i for i in cushion.account_ids if i not in found]
        if missing:
            raise HTTPException(
                status_code=422, detail=f"unknown account id(s): {', '.join(map(str, missing))}"
            )
        wrong = [a.name for a in rows if a.currency != currency]
        if wrong:
            raise HTTPException(
                status_code=422,
                detail=f"cushion accounts must be in {currency}: {', '.join(wrong)}",
            )
    budget_settings.save(profile.slug, parsed)
    return budget_settings.to_dict(parsed)


# --------------------------------------------------------------------------- #
# Statement import (first steps / tabbar Import): preview -> commit; transfers
# --------------------------------------------------------------------------- #


def _problem(e: imports.ImportProblem) -> HTTPException:
    return HTTPException(
        status_code=e.status, detail=str(e), headers={"X-Finanse-Error-Code": e.code}
    )


def _optional_int(value: str | int | None, name: str) -> int | None:
    if value is None or value == "":
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        raise HTTPException(status_code=422, detail=f"{name} must be an integer") from None


@router.get("/budget/import/importers")
def import_importers(profile: CurrentProfile) -> dict:
    """The importer choices of the statement import (the drawer's ``Bank`` select): ``auto``, the
    banks with a CSV parser (``institutions.csv_ids()``), the finanse format, the budget file
    connectors (``connector:<id>``; ``available`` only when approved)."""
    del profile  # profile-scoped route (connectors themselves are global)
    return {"importers": imports.importer_choices(), "max_bytes": imports.MAX_FILE_BYTES}


@router.post("/budget/import/preview")
async def import_preview(profile: CurrentProfile, request: Request) -> dict:
    """Preview a bank statement (read-only). Multipart fields: ``file``; optional ``bank`` (alias
    ``importer``: ``auto`` | a bank id | ``finanse-budget`` | ``connector:<id>``), ``account_type``
    (checking | savings | credit, for a new account), ``account_name`` (a new account's name),
    ``account_id`` (import into this bank account). A raw body works too (the same names as query
    parameters, ``filename`` for the name). The file is staged until committed (``file_id``)."""
    body = await uploads.read_limited(request, imports.MAX_FILE_BYTES + 1024 * 1024)
    content_type = request.headers.get("content-type", "")
    query = request.query_params
    if content_type.startswith("multipart/form-data"):
        try:
            fields = uploads.parse_multipart(content_type, body)
        except ValueError:
            raise HTTPException(status_code=422, detail="Malformed multipart body") from None
        if "file" not in fields:
            raise HTTPException(status_code=422, detail="multipart field 'file' is required")
        name, content = fields["file"]

        def field(key: str) -> str | None:
            return uploads.text_field(fields, key) or query.get(key) or None

        name = name or field("filename") or "wyciag.csv"
    else:
        content = body

        def field(key: str) -> str | None:
            return query.get(key) or None

        name = field("filename") or "wyciag.csv"
    if not content:
        raise HTTPException(
            status_code=422,
            detail="The file is empty",
            headers={"X-Finanse-Error-Code": "import_empty"},
        )
    if len(content) > imports.MAX_FILE_BYTES:
        raise uploads.too_large()
    name = name.replace("\\", "/").rsplit("/", 1)[-1][:200] or "wyciag.csv"
    account_id = _optional_int(field("account_id"), "account_id")
    upload = imports.stage(profile.slug, name, content)
    importer = field("bank") or field("importer")
    detected = False
    try:
        # A file connector runs here, before any database session is open (F10).
        from finanse.core.connectors import imports as connector_imports

        try:
            facts = _account_facts(profile, account_id)
            ran = imports.run_connector(
                profile.slug, upload, importer,
                profile_id=profile.id, account=facts[0] if facts else None,
                prefer=facts[1] if facts else None,
            )
        except connector_imports.ConnectorRunFailed as e:
            upload.path.unlink(missing_ok=True)
            raise connector_imports.http_error(e) from None
        if ran is not None:
            upload, importer, detected = ran.upload, ran.importer, ran.detected
        with get_session() as s:
            return imports.preview(
                s,
                profile,
                upload,
                importer=importer,
                account_type=field("account_type"),
                account_name=field("account_name"),
                account_id=account_id,
                detected=detected,
            )
    except imports.ImportProblem as e:
        upload.path.unlink(missing_ok=True)  # nothing to commit: do not keep the statement
        raise _problem(e) from None


def _account_facts(profile, account_id: int | None) -> tuple[dict[str, str], str | None] | None:
    """What a connector is told about the chosen account (currency, name) and the account's
    remembered importer (``auto`` asks that connector first); None without an account."""
    from finanse.core.models import Account

    if account_id is None:
        return None
    with get_session() as s:
        acc = s.get(Account, account_id)
        if acc is None or acc.profile_id != profile.id or acc.removed_at is not None:
            return None
        facts = {"currency": acc.currency, "label": acc.name}
        return facts, imports.remembered_importer(s, acc.id)


class StatementCommitBody(BaseModel):
    file_id: str
    file_name: str
    bank: str | None = None
    importer: str | None = None
    account_type: str | None = None
    account_name: str | None = None
    account_id: int | None = None


@router.post("/budget/import/commit", status_code=201)
def import_commit(profile: CurrentProfile, body: StatementCommitBody) -> dict:
    """Commit a previewed statement: the same importer and account choices as the preview; writes in
    one transaction (statement, transfer matching, categorization), then drops the staged file."""
    try:
        path = imports.staged_path(profile.slug, body.file_id, body.file_name)
        if not path.is_file():
            raise imports.ImportProblem(
                "not_found", "No staged file with this id; preview it again", 404
            )
        upload = imports.Upload(body.file_id, body.file_name, path)
        return imports.commit(
            get_session,
            profile,
            upload,
            importer=body.bank or body.importer,
            account_type=body.account_type,
            account_name=body.account_name,
            account_id=body.account_id,
        )
    except imports.ImportProblem as e:
        raise _problem(e) from None


class MatchTransfersBody(BaseModel):
    max_days: int = Field(default=3, ge=0, le=31)


@router.post("/budget/match-transfers")
def match_transfers(profile: CurrentProfile, body: MatchTransfersBody | None = None) -> dict:
    """Pair internal transfers between the profile's own accounts (by IBAN; ``match-transfers``),
    then re-categorize so the paired rows leave income and spending."""
    from .ingestion.transfers import match_internal_transfers
    from .service import categorize_all

    max_days = (body or MatchTransfersBody()).max_days
    with get_session() as s:
        pairs = match_internal_transfers(s, max_days=max_days, profile_id=profile.id)
        if pairs:
            categorize_all(s, profile_id=profile.id)
    return {"pairs": pairs}
