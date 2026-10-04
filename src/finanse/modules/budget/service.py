"""Budget persistence: ingestion of raw transactions, CSV import, categorization.

This is the single choke point through which every source (CSV, Open Banking)
writes transactions to the database, so dedup and audit batching are applied
uniformly.
"""

from __future__ import annotations

from datetime import date, datetime, timezone
from decimal import Decimal
from pathlib import Path

from sqlmodel import Session

from finanse.core import modules, profiles
from finanse.core.accounts import get_or_create_account, own_ibans, upsert_balance
from finanse.core.models import Account, AccountType, Source

from .cash import cash_account_ids, get_cash_account, sync_cash_leg
from .ingestion.csv_import import parse_file
from .ingestion.dedup import prepare_new_transactions
from .ingestion.normalize import RawTransaction
from .models import ImportBatch, Transaction
from .queries import transactions


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def ingest_transactions(
    session: Session,
    account: Account,
    raws: list[RawTransaction],
    *,
    source: Source,
    filename: str | None = None,
) -> ImportBatch:
    batch = ImportBatch(
        source=source,
        bank=account.bank,
        account_id=account.id,
        filename=filename,
        profile_id=account.profile_id,
    )
    session.add(batch)
    session.flush()

    result = prepare_new_transactions(session, account.id, raws, import_batch_id=batch.id)
    for txn in result.to_insert:
        session.add(txn)

    batch.num_seen = len(raws)
    batch.num_inserted = result.num_inserted
    batch.num_duplicates = result.num_duplicates
    batch.finished_at = _utcnow()
    session.add(batch)
    return batch


def _end_of_day_balances(
    transactions: list[RawTransaction], balances: list[tuple[date, Decimal]]
) -> dict[date, Decimal]:
    """Collapse per-row running balances to one end-of-day figure per date.

    `balances` is aligned to file order. If the statement runs newest-first we
    reverse it, so 'last row for a date' is the true end-of-day balance.
    """
    if not balances:
        return {}
    dates = [t.booking_date for t in transactions]
    descending = len(dates) >= 2 and dates[0] > dates[-1]
    ordered = list(reversed(balances)) if descending else balances
    eod: dict[date, Decimal] = {}
    for d, b in ordered:
        eod[d] = b  # ascending order -> last write per date wins
    return eod


def import_csv(
    session: Session,
    path: str | Path,
    *,
    bank: str | None = None,
    account_type: str = AccountType.CHECKING,
    account_name: str | None = None,
    profile_id: int | None = None,
) -> tuple[Account, ImportBatch]:
    path = Path(path)
    stmt = parse_file(path, bank)

    account = get_or_create_account(
        session,
        bank=stmt.bank,
        iban=stmt.account_number,
        name=account_name,
        type=account_type,
        currency=stmt.currency,
        profile_id=profile_id,
    )

    batch = ingest_transactions(
        session, account, stmt.transactions, source=Source.CSV, filename=path.name
    )

    for on_date, amount in _end_of_day_balances(stmt.transactions, stmt.balances).items():
        upsert_balance(session, account, on_date, amount, source=Source.CSV)

    return account, batch


# --------------------------------------------------------------------------- #
# Categorization
# --------------------------------------------------------------------------- #

def categorize_all(
    session: Session, *, use_llm: bool = False, profile_id: int | None = None
) -> dict:
    """Categorize every transaction of the profile: deterministic cascade, then
    (opt-in) an LLM pass over still-unknown expense merchants whose answers are
    cached as the profile's rules."""
    from . import analytics
    from .categorize import engine, taxonomy
    from .categorize.rules import load_rules, upsert_rule
    from .ingestion.normalize import merchant_key

    pid = profiles.scope(session, profile_id)
    own = own_ibans(session, pid)
    rules = load_rules(session, pid)
    patterns = modules.payment_patterns(session, pid)
    subs = {c.counterparty for c in analytics.detect_recurring(session, profile_id=pid)}
    txns = session.exec(transactions(pid)).all()
    cash_ids = cash_account_ids(session, pid)

    for t in txns:
        # Preserve manual overrides and full-LLM reclassification; cash-pool
        # entries are managed by hand. Deterministic re-runs must not clobber these.
        if t.category_source in ("manual_txn", "llm_full", "llm_fallback") or t.account_id in cash_ids:
            continue
        t.category, t.category_source = engine.categorize(
            t, own_ibans=own, rules=rules, subscription_keys=subs, patterns=patterns
        )
        session.add(t)

    result = {"total": len(txns), "llm_classified": 0, "unknown_merchants": 0}
    if not use_llm:
        return result

    from .categorize.classify import classify_unknown

    unknown = sorted(
        {
            merchant_key(t.counterparty_name, t.reference, t.description)
            for t in txns
            if t.amount < 0 and t.category_source == "default"
        }
        - {""}
    )
    result["unknown_merchants"] = len(unknown)
    if not unknown:
        return result

    classified, err = classify_unknown(unknown, taxonomy.CATEGORY_KEYS)
    if err:
        result["llm_error"] = err
        return result
    for mk, res in classified.items():
        cat = res.get("category")
        if cat in taxonomy.CATEGORY_KEYS and cat != "other":
            upsert_rule(session, mk, cat, source="llm", locked=False, profile_id=pid)
            result["llm_classified"] += 1

    rules = load_rules(session, pid)
    for t in txns:
        if t.category_source == "default":
            t.category, t.category_source = engine.categorize(
                t, own_ibans=own, rules=rules, subscription_keys=subs, patterns=patterns
            )
            session.add(t)
    return result


def _profile_txn(session: Session, txn_id: int, profile_id: int | None) -> Transaction | None:
    """The transaction if it belongs to the profile (default profile when None)."""
    pid = profiles.scope(session, profile_id)
    t = session.get(Transaction, txn_id)
    if t is None:
        return None
    account = session.get(Account, t.account_id)
    return t if account is not None and account.profile_id == pid else None


def set_transaction_category(
    session: Session, txn_id: int, category: str, *, profile_id: int | None = None
) -> bool:
    """Override the category of a single transaction (survives re-categorization).

    Marking a bank transaction as ``cash_withdrawal`` also mirrors it as a credit
    into the cash pool (so a withdrawal is net-worth-neutral); un-marking removes
    that mirror. A transaction of another profile is treated as missing."""
    t = _profile_txn(session, txn_id, profile_id)
    if t is None:
        return False
    pid = session.get(Account, t.account_id).profile_id
    cash = get_cash_account(session, t.currency, create=False, profile_id=pid)
    on_cash_account = cash is not None and t.account_id == cash.id
    t.category = category
    t.category_source = "manual_txn"
    session.add(t)
    if not on_cash_account:
        sync_cash_leg(session, t, category)
    return True


def recategorize_one(session: Session, t: Transaction) -> None:
    """Re-run the deterministic engine for one transaction (e.g. after un-marking)."""
    from . import analytics
    from .categorize import engine
    from .categorize.rules import load_rules

    pid = session.get(Account, t.account_id).profile_id
    subs = {c.counterparty for c in analytics.detect_recurring(session, profile_id=pid)}
    t.category, t.category_source = engine.categorize(
        t,
        own_ibans=own_ibans(session, pid),
        rules=load_rules(session, pid),
        subscription_keys=subs,
        patterns=modules.payment_patterns(session, pid),
    )
    session.add(t)


def recategorize_merchant(
    session: Session, merchant_key_value: str, category: str, *, profile_id: int | None = None
) -> int:
    """Pin a merchant to a category (manual, locked) for the profile and re-apply
    to its rows."""
    from .categorize.rules import upsert_rule
    from .ingestion.normalize import merchant_key

    pid = profiles.scope(session, profile_id, create=True)
    upsert_rule(session, merchant_key_value, category, source="manual", locked=True, profile_id=pid)
    n = 0
    for t in session.exec(transactions(pid)).all():
        if merchant_key(t.counterparty_name, t.reference, t.description) == merchant_key_value:
            t.category, t.category_source = category, "manual"
            session.add(t)
            n += 1
    return n
