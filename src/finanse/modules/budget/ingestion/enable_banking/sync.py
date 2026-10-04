"""Turn Enable Banking session data into normalized transactions + balances."""

from __future__ import annotations

from collections import Counter
from dataclasses import dataclass
from datetime import date, timedelta
from decimal import Decimal, InvalidOperation
from typing import Any

from sqlalchemy import func
from sqlmodel import Session, select

from finanse.core import profiles
from finanse.core.accounts import get_or_create_account, upsert_balance
from finanse.core.models import Account, AccountType, Bank, Source

from ...models import ImportBatch, Transaction
from ...queries import transactions
from ...service import ingest_transactions
from ..normalize import RawTransaction
from .client import EnableBankingClient

# Preference order for which balance type represents "the" account balance.
_BALANCE_PRIORITY = {"CLBD": 0, "ITAV": 1, "XPCD": 2, "PRCD": 3, "OTHR": 4}


def bank_from_aspsp(name: str | None) -> Bank:
    low = (name or "").lower()
    if "mbank" in low:
        return Bank.MBANK
    if "erste" in low or "santander" in low:
        return Bank.ERSTE
    raise ValueError(f"Cannot map ASPSP '{name}' to a known bank; pass bank explicitly.")


def _parse_date(value: Any) -> date | None:
    if not value:
        return None
    if isinstance(value, date):
        return value
    try:
        return date.fromisoformat(str(value)[:10])
    except ValueError:
        return None


def eb_transaction_to_raw(t: dict[str, Any]) -> RawTransaction | None:
    """Map one Enable Banking transaction object to a RawTransaction."""
    amt_obj = t.get("transaction_amount") or {}
    try:
        amount = Decimal(str(amt_obj.get("amount", "0")))
    except InvalidOperation:
        return None
    currency = amt_obj.get("currency", "PLN")

    indicator = (t.get("credit_debit_indicator") or "").upper()
    if indicator == "DBIT":
        amount = -abs(amount)
        cp = t.get("creditor") or {}
        cp_acc = t.get("creditor_account") or {}
    else:  # CRDT or unknown -> treat as inflow with given sign
        amount = abs(amount) if indicator == "CRDT" else amount
        cp = t.get("debtor") or {}
        cp_acc = t.get("debtor_account") or {}

    booking = _parse_date(
        t.get("booking_date") or t.get("value_date") or t.get("transaction_date")
    )
    if booking is None:
        return None

    remittance = t.get("remittance_information") or []
    if isinstance(remittance, list):
        description = " ".join(str(x) for x in remittance).strip() or None
    else:
        description = str(remittance).strip() or None
    note = t.get("note")
    if not description and note:
        description = str(note).strip() or None

    # The human-facing title is the remittance/note (what the payment was for).
    # `entry_reference` is an opaque per-entry bank id — it belongs in
    # bank_transaction_id (and raw), NOT in `reference`, which the UI shows as the
    # transaction title. Putting the id there is what made Erste rows unreadable.
    entry_ref = t.get("entry_reference") or t.get("transaction_id")

    return RawTransaction(
        booking_date=booking,
        value_date=_parse_date(t.get("value_date")),
        amount=amount,
        currency=currency,
        counterparty_name=cp.get("name"),
        counterparty_iban=cp_acc.get("iban"),
        description=description,
        reference=description,
        bank_transaction_id=str(entry_ref) if entry_ref else None,
        source=Source.OPEN_BANKING,
        raw=t,
    )


def reprocess_open_banking_fields(db: Session, *, profile_id: int | None = None) -> int:
    """Re-derive display fields (title/description/counterparty) for already-synced
    Open Banking transactions from their stored raw payload.

    Used after changing the field mapping (e.g. moving the opaque entry_reference
    out of the title). Identity fields (amount/date/dedup/category) are untouched."""
    n = 0
    pid = profiles.scope(db, profile_id)
    rows = db.exec(transactions(pid, Transaction.source == Source.OPEN_BANKING)).all()
    for t in rows:
        if not t.raw:
            continue
        rt = eb_transaction_to_raw(t.raw)
        if rt is None:
            continue
        changed = False
        for attr in (
            "reference", "description", "counterparty_name",
            "counterparty_iban", "bank_transaction_id",
        ):
            new = getattr(rt, attr)
            if getattr(t, attr) != new:
                setattr(t, attr, new)
                changed = True
        if changed:
            db.add(t)
            n += 1
    return n


def _pick_balance(balances: list[dict[str, Any]]) -> tuple[date, Decimal] | None:
    best: tuple[int, date, Decimal] | None = None
    for b in balances:
        amt_obj = b.get("balance_amount") or {}
        try:
            amount = Decimal(str(amt_obj.get("amount")))
        except (InvalidOperation, TypeError):
            continue
        btype = (b.get("balance_type") or "OTHR").upper()
        prio = _BALANCE_PRIORITY.get(btype, 9)
        ref_date = (
            _parse_date(b.get("reference_date") or b.get("reference_time"))
            or date.today()  # noqa: DTZ011 - naive local date, like the booking dates
        )
        cand = (prio, ref_date, amount)
        if best is None or prio < best[0]:
            best = cand
    if best is None:
        return None
    return best[1], best[2]


def detect_account_type(details: dict[str, Any], default: AccountType) -> AccountType:
    """Infer account type from Enable Banking metadata (cash_account_type/product)."""
    cat = (details.get("cash_account_type") or "").upper()
    text = f"{details.get('product') or ''} {details.get('name') or ''}".lower()
    if cat == "CARD" or any(k in text for k in ("credit", "kredyt", "karta")):
        return AccountType.CREDIT
    if cat == "SVGS" or any(k in text for k in ("saving", "oszczęd", "oszczed")):
        return AccountType.SAVINGS
    return default


def _account_uid(acc: Any) -> tuple[str, dict[str, Any]]:
    """Session `accounts` entries may be uid strings or full objects."""
    if isinstance(acc, str):
        return acc, {}
    return acc.get("uid") or acc.get("account_uid"), acc


@dataclass
class SyncResult:
    account: Account
    batch: ImportBatch


@dataclass
class FetchedAccount:
    """What Enable Banking returned for one account (network phase, no DB)."""

    uid: str
    details: dict[str, Any]
    transactions: list[dict[str, Any]]
    balances: list[dict[str, Any]]


@dataclass
class FetchedSession:
    bank: Bank
    accounts: list[FetchedAccount]
    errors: list[str]  # accounts skipped (429 / transient failures)


def fetch_session(
    client: EnableBankingClient,
    session_id: str,
    *,
    bank: Bank | None = None,
    days: int = 90,
) -> FetchedSession:
    """Network phase: pull accounts, transactions and balances for an authorized
    EB session. Touches no database, so callers can run it with no transaction
    open (bank calls can take minutes with 429 retries)."""
    eb_session = client.get_session(session_id)
    resolved_bank = bank or bank_from_aspsp((eb_session.get("aspsp") or {}).get("name"))

    date_to = date.today()  # noqa: DTZ011 - bank booking dates are local, naive dates
    date_from = date_to - timedelta(days=days)

    accounts: list[FetchedAccount] = []
    errors: list[str] = []
    for acc in eb_session.get("accounts", []):
        uid, details = _account_uid(acc)
        if not uid:
            continue
        try:
            if not details:
                details = client.get_account_details(uid)
            txns = list(client.iter_transactions(
                uid, date_from=date_from.isoformat(), date_to=date_to.isoformat()
            ))
            balances = client.get_account_balances(uid)
        except Exception as e:  # noqa: BLE001 - a 429 / transient failure on one
            errors.append(f"{uid}: {e}")  # account must not abort syncing the others
            continue
        accounts.append(FetchedAccount(uid, details, txns, balances))
    return FetchedSession(resolved_bank, accounts, errors)


def sync_session(
    db: Session,
    client: EnableBankingClient,
    session_id: str,
    *,
    bank: Bank | None = None,
    days: int = 90,
    account_type: AccountType = AccountType.CHECKING,
    profile_id: int | None = None,
) -> list[SyncResult]:
    """Pull accounts, transactions and balances for an authorized EB session and
    store them in `db` (for the profile). All bank calls happen before the first
    write."""
    fetched = fetch_session(client, session_id, bank=bank, days=days)
    results: list[SyncResult] = []
    errors = list(fetched.errors)
    for fa in fetched.accounts:
        try:
            results.append(store_account(db, fa, fetched.bank, account_type, profile_id=profile_id))
        except Exception as e:  # noqa: BLE001 - one bad account must not abort the others
            errors.append(f"{fa.uid}: {e}")
    sync_session.last_errors = errors  # type: ignore[attr-defined]
    return results


sync_session.last_errors = []  # type: ignore[attr-defined]


def store_account(
    db: Session,
    fetched: FetchedAccount,
    bank: Bank,
    account_type: AccountType = AccountType.CHECKING,
    *,
    profile_id: int | None = None,
) -> SyncResult:
    """DB phase for one fetched account: the account row (of the profile), new
    transactions (above the high-water mark) and the balance. No network calls."""
    details = fetched.details
    iban = (details.get("account_id") or {}).get("iban") or details.get("iban")
    name = details.get("name") or details.get("product")
    currency = details.get("currency", "PLN")

    account = get_or_create_account(
        db,
        bank=bank,
        iban=iban,
        external_id=fetched.uid,
        name=name,
        type=detect_account_type(details, account_type),
        currency=currency,
        profile_id=profile_id,
    )

    # High-water mark: CSV backfill is authoritative up to its export date, so
    # only ingest Open Banking transactions from the newest stored day onwards.
    # Avoids the OB↔CSV overlap (which can't be perfectly deduped for card
    # payments - different memos per source).
    latest = db.exec(
        select(func.max(Transaction.booking_date)).where(Transaction.account_id == account.id)
    ).one()
    # The newest stored day may be incomplete (a CSV exported, or a sync run,
    # before the day ended): its later transactions must not be dropped, so that
    # day is re-ingested. Open Banking rows already stored are caught by dedup
    # (bank transaction id / content hash). Rows stored from a CSV cannot be
    # matched that way (different memo per source), so on that day an incoming row
    # first consumes a CSV row with the same amount (a multiset: two identical
    # payments stay two); only the surplus is new.
    csv_on_latest: Counter[str] = Counter()
    if latest is not None:
        csv_on_latest.update(
            f"{amount:.2f}"
            for amount in db.exec(
                select(Transaction.amount).where(
                    Transaction.account_id == account.id,
                    Transaction.booking_date == latest,
                    Transaction.source != Source.OPEN_BANKING,
                )
            ).all()
        )

    raws: list[RawTransaction] = []
    for t in fetched.transactions:
        rt = eb_transaction_to_raw(t)
        if rt is None:
            continue
        if latest is None or rt.booking_date > latest:
            raws.append(rt)
        elif rt.booking_date == latest:
            key = f"{rt.amount:.2f}"
            if csv_on_latest[key] > 0:
                csv_on_latest[key] -= 1  # the CSV twin of this row is already stored
            else:
                raws.append(rt)  # stored from OB (dedup skips it) or booked later that day

    batch = ingest_transactions(db, account, raws, source=Source.OPEN_BANKING)

    picked = _pick_balance(fetched.balances)
    if picked is not None:
        on_date, amount = picked
        upsert_balance(db, account, on_date, amount, source=Source.OPEN_BANKING)

    return SyncResult(account=account, batch=batch)
