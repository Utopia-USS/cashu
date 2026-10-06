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


def _good_run(s, profile) -> int | None:
    from .store import signals as signal_store

    return signal_store.last_good_run_id(s, profile.id)


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
            "signal": views.signal_dict(row, [decision], good_run_id=_good_run(s, profile)),
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
            "signal": views.signal_dict(row, [decision], good_run_id=_good_run(s, profile)),
        }


class SnoozeBody(BaseModel):
    until: str | None = None  # YYYY-MM-DD (local midnight) or an ISO timestamp; null = back now


def _until(text: str | None) -> dt.datetime | None:
    if text is None or not text.strip():
        return None
    raw = text.strip()
    try:
        if len(raw) == 10:
            day = dt.date.fromisoformat(raw)
            return dt.datetime.combine(day, dt.time.min).astimezone().astimezone(dt.UTC)
        moment = dt.datetime.fromisoformat(raw)
    except ValueError:
        raise _422("until must be a date (YYYY-MM-DD) or an ISO timestamp") from None
    return moment.replace(tzinfo=dt.UTC) if moment.tzinfo is None else moment.astimezone(dt.UTC)


@router.post("/signals/{signal_id}/snooze")
def snooze_signal(profile: CurrentProfile, signal_id: int, body: SnoozeBody) -> dict:
    """ "Odłóż do": hide an open signal until ``until`` (a date = that day's local midnight): it leaves
    the attention list and is not notified meanwhile; the daily check brings it back (active, notified
    per the policy). ``until: null`` brings it back now. 409 for a closed signal."""
    from .store import signals as signal_store

    until = _until(body.until)
    if until is not None and until <= dt.datetime.now(dt.UTC):
        raise _422("until must be in the future")
    with get_session() as s:
        row = journal.signal(s, profile.id, signal_id)
        if row is None:
            raise _404(f"No signal {signal_id}")
        if row.status not in ("active", "acknowledged"):
            raise HTTPException(status_code=409, detail=f"Signal {signal_id} is {row.status}")
        signal_store.snooze(s, row, until)
        return views.signal_dict(row, good_run_id=_good_run(s, profile))


@router.get("/decisions")
def decision_list(profile: CurrentProfile, instrument_id: int | None = None) -> list[dict]:
    with get_session() as s:
        return [
            views.decision_dict(d)
            for d in journal.decisions(s, profile.id, instrument_id=instrument_id)
        ]


@router.delete("/decisions/{decision_id}")
def decision_undo(profile: CurrentProfile, decision_id: int) -> dict:
    """Undo a decision within 15 minutes of recording it: the entry is deleted and the
    acknowledgement it caused is reverted (409 ``undo_expired`` after that)."""
    with get_session() as s:
        row = journal.decision(s, profile.id, decision_id)
        if row is None:
            raise _404(f"No decision {decision_id}")
        try:
            linked = journal.undo_decision(s, profile.id, row)
        except journal.UndoExpired as e:
            raise HTTPException(
                status_code=409, detail=str(e), headers={"X-Finanse-Error-Code": "undo_expired"}
            ) from None
        return {
            "deleted": decision_id,
            "signal": None
            if linked is None
            else views.signal_dict(linked, good_run_id=_good_run(s, profile)),
        }


@router.get("/review-digest")
def review_digest(profile: CurrentProfile, since: dt.date | None = None) -> dict:
    """Changes since the last weekly review (``baseline: review``), the last 7 days
    (``default_7d``) or ``since=YYYY-MM-DD`` (``since``): value then / now (contributions vs the
    market part), new / escalated / resolved signals, imports, transactions, decisions, dividends,
    larger price moves, warnings, strategy changes, ``review_due`` and the typed ``events`` log."""
    if since is not None and since > dt.date.today():  # noqa: DTZ011 - local calendar date
        raise _422("since must not be in the future")
    with get_session() as s:
        return views.review_digest(s, profile, since)


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


MAX_UPLOAD_BYTES = MAX_FILE_BYTES + 1024 * 1024
"""Largest request body of an upload (the file limit plus room for multipart framing and fields)."""


async def _read_limited(request: Request, limit: int) -> bytes:
    """The request body, refused (413) as soon as it is larger than ``limit``: a declared
    Content-Length is checked before reading, and the stream is counted while it arrives (a missing or
    false Content-Length never makes the server buffer more than ``limit`` bytes)."""
    declared = request.headers.get("content-length")
    if declared is not None:
        try:
            size = int(declared)
        except ValueError:
            raise HTTPException(status_code=400, detail="Invalid Content-Length") from None
        if size > limit:
            raise HTTPException(status_code=413, detail="File too large")
    chunks: list[bytes] = []
    total = 0
    async for chunk in request.stream():
        total += len(chunk)
        if total > limit:
            raise HTTPException(status_code=413, detail="File too large")
        chunks.append(chunk)
    return b"".join(chunks)


@router.post("/import/preview")
async def import_preview(profile: CurrentProfile, request: Request) -> dict:
    """Preview an import. Multipart fields: ``file`` (the export), ``account_id``, optional
    ``importer`` (auto | finanse | generic_csv) and ``mapping`` (generic CSV mapping YAML). A raw
    body works too (``?account_id=&filename=&importer=``). The file is staged until committed;
    commit with the returned ``file_id``."""
    body = await _read_limited(request, MAX_UPLOAD_BYTES)
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
        "planned_booked": result.planned_booked,
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


# --------------------------------------------------------------------------- #
# Planned deposits (F6)
# --------------------------------------------------------------------------- #


class PlannedBody(BaseModel):
    amount: float | str
    planned_date: dt.date
    currency: str | None = None
    account_id: int | None = None
    note: str | None = None


@router.get("/planned-deposits")
def planned_list(
    profile: CurrentProfile, status: str | None = None, month: str | None = None
) -> dict:
    """Planned deposits (``status`` = ``planned,booked`` by default, ``all`` or a comma list), newest
    planned date first, plus ``plan``: the month's contribution-plan progress in the base currency
    (``month`` = YYYY-MM, default this month). Planned deposits are never cash or value."""
    from .service import planned

    try:
        statuses = planned.parse_statuses(status)
        with get_session() as s:
            return {
                "items": [
                    planned.planned_dict(r)
                    for r in planned.planned_deposits(s, profile.id, statuses)
                ],
                "plan": planned.month_plan(s, profile, month),
            }
    except planned.PlannedError as e:
        raise _coded(422, str(e), "planned_invalid") from None


@router.post("/planned-deposits", status_code=201)
def planned_create(profile: CurrentProfile, body: PlannedBody) -> dict:
    """Plan a deposit ("Zaplanuj wpłatę"): counted against the contribution plan, never cash until a
    matching deposit is imported (it may already be: then the answer is ``booked``). Currency
    defaults to the account's, else the base currency."""
    from .service import planned

    with get_session() as s:
        try:
            row = planned.create(s, profile, planned.PlannedInput(**body.model_dump()))
        except planned.PlannedNotFound as e:
            raise _coded(404, str(e), "not_found") from None
        except planned.PlannedError as e:
            raise _coded(422, str(e), "planned_invalid") from None
        return planned.planned_dict(row)


@router.delete("/planned-deposits/{planned_id}")
def planned_cancel(profile: CurrentProfile, planned_id: int) -> dict:
    """Cancel a planned deposit (kept with status ``cancelled``); 409 ``planned_booked`` once a
    deposit booked it, 404 ``not_found`` for another profile's."""
    from .service import planned

    with get_session() as s:
        try:
            row = planned.cancel(s, profile, planned_id)
        except planned.PlannedNotFound as e:
            raise _coded(404, str(e), "not_found") from None
        except planned.PlannedBooked as e:
            raise _coded(409, str(e), "planned_booked") from None
        return {"deleted": planned_id, "status": row.status}


# --------------------------------------------------------------------------- #
# Alerts and the watchlist
# --------------------------------------------------------------------------- #


def _coded(status: int, message: str, code: str) -> HTTPException:
    return HTTPException(status_code=status, detail=message, headers={"X-Finanse-Error-Code": code})


class AlertBody(BaseModel):
    kind: str
    title: str
    params: dict[str, Any] = {}
    instrument_id: int | None = None
    scope: str | None = None
    polarity: str | None = None
    severity: str | None = None
    note: str | None = None
    cooldown_days: int | None = None
    expires_at: dt.datetime | None = None
    expires_in_days: int | None = None


class AlertPatchBody(BaseModel):
    model_config = {"extra": "forbid"}

    title: str | None = None
    note: str | None = None
    params: dict[str, Any] | None = None
    polarity: str | None = None
    severity: str | None = None
    cooldown_days: int | None = None
    expires_at: dt.datetime | None = None
    expires_in_days: int | None = None
    status: str | None = None
    snooze_days: int | None = None
    snoozed_until: dt.datetime | None = None


@router.get("/alert-kinds")
def alert_kinds(profile: CurrentProfile) -> dict:
    """The alert catalog for forms: kinds, scopes, params (types, defaults, limits)."""
    return views.alert_kinds()


@router.get("/alerts")
def alert_list(profile: CurrentProfile, status: str = "all") -> list[dict]:
    """``status=all`` (default), ``live`` or a comma list (``active,triggered``); triggered first."""
    from .service import alerts as alert_service

    try:
        statuses = alert_service.parse_status_filter(status)
    except alert_service.AlertError as e:
        raise _422(str(e)) from None
    with get_session() as s:
        return views.alerts_view(s, profile, statuses)


@router.post("/alerts", status_code=201)
def alert_create(profile: CurrentProfile, body: AlertBody) -> dict:
    """Create an ACTIVE alert (``source = user``), validated against the catalog; ``instrument_id``
    must be an instrument of the profile (held, watched or otherwise referenced)."""
    from .service import alerts as alert_service

    data = alert_service.AlertInput(**body.model_dump())
    with get_session() as s:
        try:
            row = alert_service.create(s, profile, data, created_by="app")
        except alert_service.AlertNotFound as e:
            raise _coded(404, str(e), "not_found") from None
        except alert_service.AlertError as e:
            raise _coded(422, str(e), "alert_invalid") from None
        return views.one_alert(s, profile, row)


@router.patch("/alerts/{alert_id}")
def alert_update(profile: CurrentProfile, alert_id: int, body: AlertPatchBody) -> dict:
    """Update texts / params / polarity / severity / cooldown / expiry, or snooze (``status:
    snoozed`` with ``snooze_days`` or ``snoozed_until``), mute (``status: muted``) or re-arm
    (``status: active``). Snoozing and muting close the alert's open signal at once."""
    from .service import alerts as alert_service

    with get_session() as s:
        try:
            row = alert_service.update(s, profile, alert_id, body.model_dump(exclude_unset=True))
        except alert_service.AlertNotFound as e:
            raise _coded(404, str(e), "not_found") from None
        except alert_service.AlertError as e:
            raise _coded(422, str(e), "alert_invalid") from None
        return views.one_alert(s, profile, row)


@router.delete("/alerts/{alert_id}")
def alert_delete(profile: CurrentProfile, alert_id: int) -> dict:
    """Delete an alert; its open signal expires, closed signals stay in the history. It can be
    restored (same id) until ``restore_until`` (15 minutes): ``POST /alerts/{id}/restore``."""
    from .service import alerts as alert_service

    with get_session() as s:
        try:
            row = alert_service.delete(s, profile, alert_id)
        except alert_service.AlertNotFound as e:
            raise _coded(404, str(e), "not_found") from None
        return {"deleted": alert_id, "restore_until": alert_service.restore_until(row)}


@router.post("/alerts/{alert_id}/restore")
def alert_restore(profile: CurrentProfile, alert_id: int) -> dict:
    """Undo a deletion within 15 minutes: the same alert (same id, status, params) is back and the
    signal the deletion closed is open again. 409 ``undo_expired`` later, 404 ``not_found`` for an
    unknown or another profile's alert, 422 ``alert_invalid`` when the agent alert cap is full."""
    from .service import alerts as alert_service

    with get_session() as s:
        try:
            row = alert_service.restore(s, profile, alert_id)
        except alert_service.AlertNotFound as e:
            raise _coded(404, str(e), "not_found") from None
        except alert_service.AlertRestoreExpired as e:
            raise _coded(409, str(e), "undo_expired") from None
        except alert_service.AlertError as e:
            raise _coded(422, str(e), "alert_invalid") from None
        return views.one_alert(s, profile, row)


class WatchBody(BaseModel):
    symbol_or_isin: str | None = None
    instrument_id: int | None = None
    name: str | None = None
    currency: str | None = None
    exchange: str | None = None
    note: str | None = None
    tags: list[str] | None = None


class WatchPatchBody(BaseModel):
    model_config = {"extra": "forbid"}

    note: str | None = None
    tags: list[str] | None = None


def _watch_row(s, profile: Profile, item_id: int) -> dict:
    return next(r for r in views.watchlist_view(s, profile) if r["id"] == item_id)


@router.get("/watchlist")
def watchlist(profile: CurrentProfile) -> list[dict]:
    """Watched instruments with the last close, past changes, the 52-week high and their alerts."""
    with get_session() as s:
        return views.watchlist_view(s, profile)


@router.post("/watchlist", status_code=201)
def watchlist_add(profile: CurrentProfile, body: WatchBody) -> dict:
    """Watch an instrument: ``symbol_or_isin`` (``VWCE.DE``, ``PKN.WA``, ``AAPL.US``, an ISIN; a new
    instrument gets guessed price aliases) or ``instrument_id``. It joins the daily price refresh."""
    from .service import watchlist as watch_service

    with get_session() as s:
        try:
            result = watch_service.add(
                s,
                profile,
                body.symbol_or_isin,
                instrument_id=body.instrument_id,
                name=body.name,
                currency=body.currency,
                exchange=body.exchange,
                note=body.note,
                tags=body.tags,
            )
        except watch_service.WatchlistNotFound as e:
            raise _coded(404, str(e), "not_found") from None
        except watch_service.WatchlistConflict as e:
            raise _coded(409, str(e), "watchlist_conflict") from None
        except watch_service.WatchlistError as e:
            raise _coded(422, str(e), "watchlist_invalid") from None
        return {
            **_watch_row(s, profile, result.item.id),
            "created_instrument": result.created_instrument,
            "warnings": [str(w) for w in result.warnings],
            # the same warnings as stable code + params (+ the English message) for Polish labels
            "warning_codes": [w.to_dict() for w in result.warnings],
        }


@router.patch("/watchlist/{item_id}")
def watchlist_update(profile: CurrentProfile, item_id: int, body: WatchPatchBody) -> dict:
    from .service import watchlist as watch_service

    with get_session() as s:
        try:
            watch_service.update(s, profile, item_id, note=body.note, tags=body.tags)
        except watch_service.WatchlistNotFound as e:
            raise _coded(404, str(e), "not_found") from None
        except watch_service.WatchlistError as e:
            raise _coded(422, str(e), "watchlist_invalid") from None
        return _watch_row(s, profile, item_id)


@router.delete("/watchlist/{item_id}")
def watchlist_remove(profile: CurrentProfile, item_id: int) -> dict:
    """Stop watching (the instrument's alerts stay)."""
    from .service import watchlist as watch_service

    with get_session() as s:
        try:
            watch_service.remove(s, profile, item_id)
        except watch_service.WatchlistNotFound as e:
            raise _coded(404, str(e), "not_found") from None
        return {"deleted": item_id}
