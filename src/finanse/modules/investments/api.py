"""Investments API (mounted under ``/api/p/{slug}`` and the legacy ``/api`` aliases):
``/investments/...`` for the F3 workspace. Every route takes the profile from the URL
(``CurrentProfile``) and only ever reads or writes that profile's rows; instrument routes accept
only instruments the profile references (404 otherwise).
"""

from __future__ import annotations

import datetime as dt
from decimal import Decimal, InvalidOperation
from email import policy
from email.parser import BytesParser
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from finanse.core.api import CurrentProfile
from finanse.core.db import get_session
from finanse.core.models import Profile

from .domain import InstrumentAlias
from .importing import ImportFile
from .importing.validation import MAX_FILE_BYTES
from .models import InvImportBatch, InvInstrument
from .service import accounts as account_service
from .service import daily, files, imports, views
from .service import strategy as strategy_files
from .service import transactions as manual_transactions
from .store import instruments, journal, transactions

router = APIRouter(prefix="/investments")


def _404(what: str) -> HTTPException:
    return HTTPException(status_code=404, detail=what)


def _422(message: str) -> HTTPException:
    return HTTPException(status_code=422, detail=message)


def _accounts(session, profile: Profile, raw: str | None) -> list[int] | None:
    try:
        return views.account_filter(session, profile, raw)
    except LookupError as e:
        raise _404(str(e)) from None


def _instrument(session, profile: Profile, instrument_id: int) -> InvInstrument:
    if instrument_id not in instruments.profile_instrument_ids(session, profile.id):
        raise _404(f"No instrument {instrument_id} in this profile")
    row = session.get(InvInstrument, instrument_id)
    if row is None:
        raise _404(f"No instrument {instrument_id}")
    return row


def _decimal(value: Any, name: str) -> Decimal | None:
    if value is None or value == "":
        return None
    try:
        number = Decimal(str(value))
    except (InvalidOperation, ValueError):
        raise _422(f"{name} must be a number") from None
    if not number.is_finite():
        raise _422(f"{name} must be a number")
    return number


# --------------------------------------------------------------------------- #
# Workspace reads
# --------------------------------------------------------------------------- #


@router.get("/overview")
def overview(profile: CurrentProfile, accounts: str | None = None) -> dict:
    """KPIs, allocation vs targets with bands, freshness, warnings, accounts, last run.
    ``accounts=1,2`` restricts values and weights to those brokerage accounts."""
    with get_session() as s:
        return views.overview(s, profile, account_ids=_accounts(s, profile, accounts))


@router.get("/positions")
def positions(profile: CurrentProfile, accounts: str | None = None) -> dict:
    """One row per instrument with per-account rows and FIFO lots, plus cash."""
    with get_session() as s:
        return views.positions(s, profile, account_ids=_accounts(s, profile, accounts))


@router.get("/positions/{instrument_id}")
def position_detail(profile: CurrentProfile, instrument_id: int) -> dict:
    """Lots, price series (24 months), transactions, theses, decisions of one instrument."""
    with get_session() as s:
        _instrument(s, profile, instrument_id)
        return views.position_detail(s, profile, instrument_id)


@router.get("/positions/{instrument_id}/chart")
def position_chart(profile: CurrentProfile, instrument_id: int, months: int = 24) -> dict:
    """Closes of the last ``months`` months (1..120), the 52-week high, the average cost and the
    price levels of the strategy's drawdown / cost rules for this instrument, buy / sell markers."""
    if not 1 <= months <= 120:
        raise _422("months must be between 1 and 120")
    with get_session() as s:
        _instrument(s, profile, instrument_id)
        return views.position_chart(s, profile, instrument_id, months=months)


@router.get("/transactions")
def transaction_list(
    profile: CurrentProfile, account_id: int | None = None, instrument_id: int | None = None
) -> list[dict]:
    with get_session() as s:
        if (
            account_id is not None
            and transactions.brokerage_account(s, profile.id, account_id) is None
        ):
            raise _404(f"No brokerage account {account_id} in this profile")
        rows = transactions.transactions(
            s, profile.id, None if account_id is None else [account_id]
        )
        if instrument_id is not None:
            rows = [t for t in rows if t.instrument_id == str(instrument_id)]
        names = {a.id: a for a in transactions.brokerage_accounts(s, profile.id)}
        out = []
        for t in reversed(rows):
            row = views.txn_dict(t)
            acc = names.get(int(t.account_id))
            row["account_name"] = acc.name if acc else None
            out.append(row)
        return out


class InstrumentBody(BaseModel):
    symbol: str | None = None
    isin: str | None = None
    name: str | None = None
    currency: str | None = None
    exchange: str | None = None
    asset_class: str | None = None


class ManualTransactionBody(BaseModel):
    account_id: int
    type: str  # domain.TxnType value
    trade_date: dt.date
    instrument_id: int | None = None
    instrument: InstrumentBody | None = None
    quantity: float | str | None = None
    price: float | str | None = None
    gross_amount: float | str | None = None
    fee: float | str | None = None
    tax: float | str | None = None
    cash_amount: float | str | None = None
    fx_rate: float | str | None = None
    split_ratio: float | str | None = None
    currency: str | None = None
    cash_currency: str | None = None
    note: str | None = None


_MANUAL_NUMBERS = (
    "quantity",
    "price",
    "gross_amount",
    "fee",
    "tax",
    "cash_amount",
    "fx_rate",
    "split_ratio",
)


@router.post("/transactions", status_code=201)
def transaction_add(profile: CurrentProfile, body: ManualTransactionBody) -> dict:
    """Book one transaction by hand (``source = manual``), checked with the per-type rules of the
    import format: instrument by ``instrument_id`` or described by ``instrument`` (found by ISIN or
    symbol, else created with ``needs_classification``), amounts derived like an import, cash sign
    errors as 422 and unusual signs as ``warnings``."""
    data = manual_transactions.ManualTxnInput(
        account_id=body.account_id,
        type=body.type,
        trade_date=body.trade_date,
        instrument_id=body.instrument_id,
        instrument=None
        if body.instrument is None
        else manual_transactions.InstrumentInput(**body.instrument.model_dump()),
        currency=body.currency,
        cash_currency=body.cash_currency,
        note=body.note,
        **{name: _decimal(getattr(body, name), name) for name in _MANUAL_NUMBERS},
    )
    with get_session() as s:
        try:
            result = manual_transactions.add_manual(s, profile, data)
        except manual_transactions.ManualTxnNotFound as e:
            raise _404(str(e)) from None
        except manual_transactions.ManualTxnError as e:
            raise _422(str(e)) from None
        return views.manual_txn_dict(result)


# --------------------------------------------------------------------------- #
# Signals and the decision journal
# --------------------------------------------------------------------------- #


@router.get("/signals")
def signal_list(profile: CurrentProfile, status: str = "open") -> list[dict]:
    """``status=open`` (active + acknowledged, action first), ``history`` (resolved, expired), ``all``."""
    if status not in ("open", "history", "all"):
        raise _422("status must be open, history or all")
    with get_session() as s:
        return views.signals_view(s, profile, status)


class DecisionBody(BaseModel):
    action: str  # bought | sold | held | ignored | other
    quantity: float | str | None = None
    price: float | str | None = None
    currency: str | None = None
    account_id: int | None = None
    reason: str | None = None


@router.post("/signals/{signal_id}/decision", status_code=201)
def decide(profile: CurrentProfile, signal_id: int, body: DecisionBody) -> dict:
    """Record a decision about a signal (acknowledges it; never books a trade)."""
    with get_session() as s:
        row = journal.signal(s, profile.id, signal_id)
        if row is None:
            raise _404(f"No signal {signal_id}")
        if (
            body.account_id is not None
            and transactions.brokerage_account(s, profile.id, body.account_id) is None
        ):
            raise _404(f"No brokerage account {body.account_id} in this profile")
        try:
            decision = journal.record_decision(
                s,
                profile.id,
                action=body.action,
                signal_row=row,
                account_id=body.account_id,
                quantity=_decimal(body.quantity, "quantity"),
                price=_decimal(body.price, "price"),
                currency=body.currency,
                reason=body.reason,
            )
        except journal.JournalError as e:
            raise _422(str(e)) from None
        return {
            "decision": views.decision_dict(decision),
            "signal": views.signal_dict(row, [decision]),
        }


class AcknowledgeBody(BaseModel):
    reason: str | None = None


@router.post("/signals/{signal_id}/acknowledge")
def acknowledge(
    profile: CurrentProfile, signal_id: int, body: AcknowledgeBody | None = None
) -> dict:
    """Seen, no change: the signal is acknowledged and the journal logs it (action ``held``)."""
    with get_session() as s:
        row = journal.signal(s, profile.id, signal_id)
        if row is None:
            raise _404(f"No signal {signal_id}")
        if row.status not in ("active", "acknowledged"):
            raise HTTPException(status_code=409, detail=f"Signal {signal_id} is {row.status}")
        decision = journal.record_decision(
            s,
            profile.id,
            action="held",
            signal_row=row,
            reason=(body.reason if body else None) or "acknowledged",
        )
        return {
            "decision": views.decision_dict(decision),
            "signal": views.signal_dict(row, [decision]),
        }


@router.get("/decisions")
def decision_list(profile: CurrentProfile, instrument_id: int | None = None) -> list[dict]:
    with get_session() as s:
        return [
            views.decision_dict(d)
            for d in journal.decisions(s, profile.id, instrument_id=instrument_id)
        ]


@router.get("/review-digest")
def review_digest(profile: CurrentProfile) -> dict:
    """Changes since the last weekly review (``baseline: review``) or the last 7 days
    (``default_7d``): value then / now, new / escalated / resolved signals, imports, transactions,
    decisions, dividends, larger price moves, warnings, strategy changes; ``review_due``."""
    with get_session() as s:
        return views.review_digest(s, profile)


# --------------------------------------------------------------------------- #
# Instruments: classification, theses, manual valuations
# --------------------------------------------------------------------------- #


@router.get("/instruments")
def instrument_list(profile: CurrentProfile, unclassified: bool = False) -> list[dict]:
    """Instruments the profile references; ``unclassified=true``: only those needing review."""
    with get_session() as s:
        ids = instruments.profile_instrument_ids(s, profile.id)
        found = instruments.load(s, ids, profile_id=profile.id)
        rows = [views.instrument_dict(i) for i in found.values()]
        if unclassified:
            rows = [r for r in rows if r["needs_classification"]]
        return sorted(rows, key=lambda r: (r["label"] or "").upper())


class AliasBody(BaseModel):
    namespace: str
    value: str


class ClassifyBody(BaseModel):
    asset_class: str | None = None
    tags: list[str] | None = None
    valuation_mode: str | None = None
    region: str | None = None
    sector: str | None = None
    name: str | None = None
    status: str | None = None
    aliases: list[AliasBody] = []


@router.patch("/instruments/{instrument_id}")
def classify(profile: CurrentProfile, instrument_id: int, body: ClassifyBody) -> dict:
    """Asset class, tags, valuation mode, region / sector, name, status; marks the instrument
    reviewed. Applies to this profile only (other profiles keep their own view of the shared
    instrument); aliases are market identity and are added to the shared instrument."""
    with get_session() as s:
        _instrument(s, profile, instrument_id)
        try:
            instruments.classify(
                s,
                instrument_id,
                profile_id=profile.id,
                asset_class=body.asset_class,
                tags=body.tags,
                valuation_mode=body.valuation_mode,
                region=body.region,
                sector=body.sector,
                name=body.name,
                status=body.status,
                aliases=[
                    InstrumentAlias(a.namespace.strip().lower(), a.value) for a in body.aliases
                ],
            )
        except instruments.ClassificationError as e:
            raise _422(str(e)) from None
        return views.instrument_dict(instruments.load_one(s, instrument_id, profile_id=profile.id))


@router.get("/instruments/{instrument_id}/theses")
def thesis_list(profile: CurrentProfile, instrument_id: int) -> list[dict]:
    with get_session() as s:
        _instrument(s, profile, instrument_id)
        return [views.thesis_dict(t) for t in journal.theses(s, profile.id, instrument_id)]


class ThesisBody(BaseModel):
    entry_type: str | None = None  # sentiment_correction | trend | special_situation
    thesis: str | None = None
    invalidation: str | None = None
    exit_plan: str | None = None
    size_plan: str | None = None
    reviewed: bool = False


@router.post("/instruments/{instrument_id}/theses", status_code=201)
def thesis_create(profile: CurrentProfile, instrument_id: int, body: ThesisBody) -> dict:
    with get_session() as s:
        _instrument(s, profile, instrument_id)
        try:
            row = journal.create_thesis(
                s, profile.id, instrument_id, body.model_dump(exclude={"reviewed"})
            )
        except journal.JournalError as e:
            raise _422(str(e)) from None
        return views.thesis_dict(row)


@router.patch("/theses/{thesis_id}")
def thesis_update(profile: CurrentProfile, thesis_id: int, body: ThesisBody) -> dict:
    with get_session() as s:
        row = journal.thesis(s, profile.id, thesis_id)
        if row is None:
            raise _404(f"No thesis {thesis_id}")
        try:
            journal.update_thesis(
                s,
                row,
                body.model_dump(exclude_unset=True, exclude={"reviewed"}),
                reviewed=body.reviewed,
            )
        except journal.JournalError as e:
            raise _422(str(e)) from None
        return views.thesis_dict(row)


@router.delete("/theses/{thesis_id}")
def thesis_delete(profile: CurrentProfile, thesis_id: int) -> dict:
    with get_session() as s:
        row = journal.thesis(s, profile.id, thesis_id)
        if row is None:
            raise _404(f"No thesis {thesis_id}")
        journal.delete_thesis(s, row)
        return {"deleted": thesis_id}


@router.get("/manual-valuations")
def manual_valuation_list(profile: CurrentProfile, instrument_id: int | None = None) -> list[dict]:
    with get_session() as s:
        rows = transactions.manual_valuation_rows(
            s, profile.id, None if instrument_id is None else [instrument_id]
        )
        return [views.manual_valuation_dict(m) for m in reversed(rows)]


class ManualValuationBody(BaseModel):
    instrument_id: int
    unit_value: float | str
    as_of: dt.date | None = None
    currency: str | None = None
    note: str | None = None


@router.post("/manual-valuations", status_code=201)
def manual_valuation_add(profile: CurrentProfile, body: ManualValuationBody) -> dict:
    """A unit value set by hand (manual valuation mode, frozen instruments); 0 is valid."""
    with get_session() as s:
        row = _instrument(s, profile, body.instrument_id)
        value = _decimal(body.unit_value, "unit_value")
        if value is None or value < 0:
            raise _422("unit_value must be a number >= 0")
        currency = (body.currency or row.currency).strip().upper()
        if len(currency) != 3 or not currency.isalpha():
            raise _422("currency must be a 3-letter code")
        saved = transactions.upsert_manual_valuation(
            s,
            profile.id,
            body.instrument_id,
            body.as_of or dt.date.today(),  # noqa: DTZ011
            value,
            currency,
            body.note,
        )
        return views.manual_valuation_dict(saved)


# --------------------------------------------------------------------------- #
# Strategy
# --------------------------------------------------------------------------- #


@router.get("/strategy")
def strategy_status(profile: CurrentProfile) -> dict:
    """Validation (issues with line / column), inactive rules, facts, stored versions."""
    with get_session() as s:
        return views.strategy_status(s, profile)


class StrategyInitBody(BaseModel):
    template: str = "passive_etf"
    force: bool = False


@router.post("/strategy/init", status_code=201)
def strategy_init(profile: CurrentProfile, body: StrategyInitBody) -> dict:
    """Write strategy.yaml / strategy.md from a shipped template (409 when they exist)."""
    try:
        written = strategy_files.init_files(profile.slug, body.template, force=body.force)
    except KeyError as e:
        raise _422(str(e.args[0])) from None
    except strategy_files.StrategyExists as e:
        raise HTTPException(status_code=409, detail=str(e)) from None
    with get_session() as s:
        return {"written": [str(p) for p in written], "status": views.strategy_status(s, profile)}


@router.post("/strategy/reload")
def strategy_reload(profile: CurrentProfile) -> dict:
    """Re-validate the files and store a new version when they changed."""
    with get_session() as s:
        strategy_files.load(s, profile, record=True)
        return views.strategy_status(s, profile)


# --------------------------------------------------------------------------- #
# Accounts
# --------------------------------------------------------------------------- #


@router.get("/accounts")
def account_list(profile: CurrentProfile) -> list[dict]:
    with get_session() as s:
        return views.accounts_view(s, profile)


class AccountBody(BaseModel):
    name: str
    broker: str
    wrapper: str = "regular"
    currency: str = "PLN"


@router.post("/accounts", status_code=201)
def account_add(profile: CurrentProfile, body: AccountBody) -> dict:
    with get_session() as s:
        try:
            acc = account_service.add_account(
                s,
                profile.id,
                name=body.name,
                broker=body.broker,
                wrapper=body.wrapper,
                currency=body.currency,
            )
        except account_service.AccountConflict as e:
            raise HTTPException(status_code=409, detail=str(e)) from None
        except account_service.AccountError as e:
            raise _422(str(e)) from None
        return account_service.account_dict(s, acc)


# --------------------------------------------------------------------------- #
# Import: preview (multipart) -> commit; reconciliation
# --------------------------------------------------------------------------- #


def _parse_multipart(content_type: str, body: bytes) -> dict[str, tuple[str | None, bytes]]:
    """``multipart/form-data`` fields -> {name: (filename, bytes)} with the stdlib parser
    (python-multipart is not a dependency)."""
    head = f"Content-Type: {content_type}\r\nMIME-Version: 1.0\r\n\r\n".encode("latin-1")
    message = BytesParser(policy=policy.HTTP).parsebytes(head + body)
    if not message.is_multipart():
        raise _422("Malformed multipart body")
    out: dict[str, tuple[str | None, bytes]] = {}
    for part in message.iter_parts():
        name = part.get_param("name", header="content-disposition")
        if not name:
            continue
        out[str(name)] = (part.get_filename(), part.get_payload(decode=True) or b"")
    return out


def _text(fields: dict, name: str) -> str | None:
    value = fields.get(name)
    if value is None:
        return None
    text = value[1].decode("utf-8", errors="replace").strip()
    return text or None


def _int(value: str | None, name: str) -> int:
    try:
        return int(value or "")
    except ValueError:
        raise _422(f"{name} is required (an integer)") from None


def _preview_or_error(
    session, profile: Profile, request: imports.ImportRequest
) -> imports.ImportPreview:
    try:
        return imports.preview(session, profile, request)
    except imports.AccountNotFound as e:
        raise _404(str(e)) from None
    except imports.ImportFailure as e:
        raise _422(str(e)) from None


@router.post("/import/preview")
async def import_preview(profile: CurrentProfile, request: Request) -> dict:
    """Preview an import. Multipart fields: ``file`` (the export), ``account_id``, optional
    ``importer`` (auto | finanse | generic_csv) and ``mapping`` (generic CSV mapping YAML). A raw
    body works too (``?account_id=&filename=&importer=``). The file is staged until committed;
    commit with the returned ``file_id``."""
    body = await request.body()
    if len(body) > MAX_FILE_BYTES + 1024 * 1024:
        raise HTTPException(status_code=413, detail="File too large")
    content_type = request.headers.get("content-type", "")
    query = request.query_params
    if content_type.startswith("multipart/form-data"):
        fields = _parse_multipart(content_type, body)
        if "file" not in fields:
            raise _422("multipart field 'file' is required")
        name, content = fields["file"]
        name = name or _text(fields, "filename") or "upload.csv"
        account_id = _int(_text(fields, "account_id") or query.get("account_id"), "account_id")
        importer = _text(fields, "importer") or query.get("importer") or imports.AUTO
        mapping = _text(fields, "mapping")
    else:
        name = query.get("filename") or "upload.csv"
        content = body
        account_id = _int(query.get("account_id"), "account_id")
        importer = query.get("importer") or imports.AUTO
        mapping = None
    if not content:
        raise _422("The file is empty")
    file = ImportFile(name, content)
    with get_session() as s:
        result = _preview_or_error(
            s, profile, imports.ImportRequest(file, account_id, importer, mapping)
        )
        out = views.preview_dict(result)
    files.write_private(files.staged_path(profile.slug, result.sha256, name), content)
    return out


class CommitBody(BaseModel):
    file_id: str
    file_name: str
    account_id: int
    importer: str = imports.AUTO
    mapping: str | None = None
    corrections: list[int | str] = []


@router.post("/import/commit", status_code=201)
def import_commit(profile: CurrentProfile, body: CommitBody) -> dict:
    """Commit a previewed file (archived, then written in one transaction). ``corrections``:
    instrument ids from the preview's reconciliation whose correction to apply."""
    try:
        staged = files.staged_path(profile.slug, body.file_id, body.file_name)
    except ValueError as e:
        raise _422(str(e)) from None
    if not staged.is_file():
        raise _404("No staged file with this id; preview it again")
    content = staged.read_bytes()
    request = imports.ImportRequest(
        ImportFile(body.file_name, content), body.account_id, body.importer, body.mapping
    )
    with get_session() as s:
        preview = _preview_or_error(s, profile, request)
    if not preview.can_commit:
        raise _422("; ".join(str(e) for e in preview.errors) or "Nothing to import")
    try:
        result = imports.commit(preview, corrections=[str(c) for c in body.corrections])
    except imports.ImportFailure as e:
        raise _422(str(e)) from None
    staged.unlink(missing_ok=True)
    return {
        "batch_id": result.batch_id,
        "inserted": result.inserted,
        "duplicates": result.duplicates,
        "new_instrument_ids": result.new_instrument_ids,
        "positions": result.positions,
        "renames": result.renames,
        "status_changes": result.status_changes,
        "corrections": result.corrections,
        "archive_path": result.archive_path,
    }


@router.get("/imports")
def import_list(profile: CurrentProfile) -> list[dict]:
    from sqlmodel import select

    with get_session() as s:
        rows = s.exec(
            select(InvImportBatch)
            .where(InvImportBatch.profile_id == profile.id)
            .order_by(InvImportBatch.created_at.desc())
        ).all()
        return [views.batch_dict(b) for b in rows]


@router.get("/reconciliation")
def reconciliation_view(profile: CurrentProfile, account_id: int | None = None) -> list[dict]:
    """History vs the newest broker snapshot, per brokerage account (or one with ``account_id``)."""
    with get_session() as s:
        accs = transactions.brokerage_accounts(s, profile.id)
        if account_id is not None:
            accs = [a for a in accs if a.id == account_id]
            if not accs:
                raise _404(f"No brokerage account {account_id} in this profile")
        out = []
        for acc in accs:
            report = imports.reconciliation(s, profile, acc.id)
            if report is None:
                out.append(
                    {
                        "account_id": acc.id,
                        "as_of": None,
                        "diffs": [],
                        "mismatches": 0,
                        "warnings": [],
                    }
                )
                continue
            ids = {int(d.instrument_id) for d in report.diffs}
            labels = {str(k): v for k, v in instruments.load(s, ids, profile_id=profile.id).items()}
            out.append(views.reconciliation_dict(report, labels))
        return out


class ReconcileBody(BaseModel):
    account_id: int
    instrument_ids: list[int]


@router.post("/reconciliation/apply")
def reconciliation_apply(profile: CurrentProfile, body: ReconcileBody) -> dict:
    """Insert the proposed corrections (``source = reconciliation``) of the chosen instruments."""
    with get_session() as s:
        try:
            applied = imports.apply_reconciliation(s, profile, body.account_id, body.instrument_ids)
        except imports.AccountNotFound as e:
            raise _404(str(e)) from None
        return {"applied": applied}


# --------------------------------------------------------------------------- #
# Rules: run now, history
# --------------------------------------------------------------------------- #


class RunBody(BaseModel):
    offline: bool = False


@router.post("/run")
def run_now(profile: CurrentProfile, body: RunBody | None = None) -> dict:
    """Run the daily check for this profile now (shares the worker's lock: 409 when busy)."""
    try:
        report = daily.run_daily_check(
            "api", profile_ids=[profile.id], offline=bool(body and body.offline)
        )
    except daily.RunBusy as e:
        raise HTTPException(status_code=409, detail=f"Rules are already running ({e})") from None
    return report.to_dict()


@router.get("/runs")
def run_list(profile: CurrentProfile, limit: int = 20) -> list[dict]:
    from .store import signals

    with get_session() as s:
        return [views.run_dict(r) for r in signals.runs(s, profile.id, max(1, min(limit, 100)))]
