"""Persistence orchestration: accounts, ingestion of raw transactions, balances.

This is the single choke point through which every source (CSV, Open Banking)
writes to the database, so dedup and audit batching are applied uniformly.
"""

from __future__ import annotations

import uuid
from datetime import date, datetime, timezone
from decimal import Decimal
from pathlib import Path

from sqlmodel import Session, select

from .ingestion.csv_import import parse_file
from .ingestion.dedup import prepare_new_transactions
from .ingestion.normalize import RawTransaction, iban_key, normalize_iban
from .models import (
    Account,
    AccountType,
    Balance,
    Bank,
    Depreciation,
    ImportBatch,
    Loan,
    Source,
    Transaction,
)


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def get_or_create_account(
    session: Session,
    *,
    bank: Bank,
    name: str | None = None,
    iban: str | None = None,
    external_id: str | None = None,
    type: AccountType = AccountType.CHECKING,
    currency: str = "PLN",
) -> Account:
    iban = normalize_iban(iban) or None
    iban_canon = iban_key(iban)

    stmt = select(Account).where(Account.bank == bank)
    account: Account | None = None
    for acc in session.exec(stmt).all():
        if external_id and acc.external_id == external_id:
            account = acc
            break
        # Match across sources: CSV stores bare NRB, Open Banking full IBAN.
        if iban_canon and acc.iban and iban_key(acc.iban) == iban_canon:
            account = acc
            break

    if account is None:
        account = Account(
            bank=bank,
            name=name or f"{bank.value} {iban[-4:] if iban else ''}".strip(),
            iban=iban,
            external_id=external_id or (f"csv:{iban}" if iban else None),
            type=type,
            currency=currency,
        )
        session.add(account)
        session.flush()  # assign id
    else:
        # backfill only missing fields; never overwrite an existing name (the
        # Open Banking "name" is just the account holder — useless and identical
        # across accounts — and would clobber CSV/user-set names).
        if iban and not account.iban:
            account.iban = iban
        if external_id and not account.external_id:
            account.external_id = external_id
        session.add(account)

    return account


def add_manual_position(
    session: Session,
    *,
    name: str,
    type: AccountType,
    value: Decimal | float | str,
    currency: str = "PLN",
    on_date: date | None = None,
) -> Account:
    """Create/update a manually-tracked asset or liability (property, mortgage,
    loan, ...) and record its current value as a balance snapshot."""
    account = get_or_create_account(
        session,
        bank=Bank.MANUAL,
        name=name,
        external_id=f"manual:{name}",
        type=type,
        currency=currency,
    )
    session.flush()
    upsert_balance(
        session, account, on_date or date.today(), Decimal(str(value)), source=Source.MANUAL
    )
    return account


def set_balance(
    session: Session,
    account_id: int,
    value: Decimal | float | str,
    *,
    on_date: date | None = None,
    source: Source = Source.MANUAL,
) -> Account:
    """Record a balance snapshot for an existing account (e.g. update a mortgage
    or revalue a property over time)."""
    account = session.get(Account, account_id)
    if account is None:
        raise ValueError(f"No account with id {account_id}")
    upsert_balance(session, account, on_date or date.today(), Decimal(str(value)), source=source)
    return account


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


def upsert_balance(
    session: Session,
    account: Account,
    on_date: date,
    amount: Decimal,
    *,
    source: Source,
    currency: str | None = None,
) -> None:
    existing = session.exec(
        select(Balance).where(
            Balance.account_id == account.id,
            Balance.date == on_date,
            Balance.source == source,
        )
    ).first()
    if existing:
        existing.amount = amount
        session.add(existing)
        return
    session.add(
        Balance(
            account_id=account.id,
            date=on_date,
            amount=amount,
            currency=currency or account.currency,
            source=source,
        )
    )


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
    bank: Bank | None = None,
    account_type: AccountType = AccountType.CHECKING,
    account_name: str | None = None,
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

def _own_ibans(session: Session) -> set[str]:
    return {iban_key(a.iban) for a in session.exec(select(Account)).all() if a.iban}


def categorize_all(session: Session, *, use_llm: bool = False) -> dict:
    """Categorize every transaction: deterministic cascade, then (opt-in) an LLM
    pass over still-unknown expense merchants whose answers are cached as rules."""
    from . import analytics
    from .categorize import engine, taxonomy
    from .categorize.rules import load_rules, upsert_rule
    from .ingestion.normalize import merchant_key

    own = _own_ibans(session)
    rules = load_rules(session)
    subs = {c.counterparty for c in analytics.detect_recurring(session)}
    txns = session.exec(select(Transaction)).all()
    cash_ids = _cash_account_ids(session)

    for t in txns:
        # Preserve manual overrides and full-LLM reclassification; cash-pool
        # entries are managed by hand. Deterministic re-runs must not clobber these.
        if t.category_source in ("manual_txn", "llm_full", "llm_fallback") or t.account_id in cash_ids:
            continue
        t.category, t.category_source = engine.categorize(
            t, own_ibans=own, rules=rules, subscription_keys=subs
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
            upsert_rule(session, mk, cat, source="llm", locked=False)
            result["llm_classified"] += 1

    rules = load_rules(session)
    for t in txns:
        if t.category_source == "default":
            t.category, t.category_source = engine.categorize(
                t, own_ibans=own, rules=rules, subscription_keys=subs
            )
            session.add(t)
    return result


def set_transaction_category(session: Session, txn_id: int, category: str) -> bool:
    """Override the category of a single transaction (survives re-categorization).

    Marking a bank transaction as ``cash_withdrawal`` also mirrors it as a credit
    into the cash pool (so a withdrawal is net-worth-neutral); un-marking removes
    that mirror."""
    t = session.get(Transaction, txn_id)
    if t is None:
        return False
    cash = get_cash_account(session, t.currency, create=False)
    on_cash_account = cash is not None and t.account_id == cash.id
    t.category = category
    t.category_source = "manual_txn"
    session.add(t)
    if not on_cash_account:
        _sync_cash_leg(session, t, category)
    return True


# --------------------------------------------------------------------------- #
# Cash pool (physical cash tracking)
# --------------------------------------------------------------------------- #

def _cash_account_ids(session: Session) -> set[int]:
    return {
        a.id
        for a in session.exec(select(Account).where(Account.type == AccountType.CASH)).all()
    }


def get_cash_account(
    session: Session, currency: str = "PLN", *, create: bool = False
) -> Account | None:
    """The single virtual 'Gotówka' account per currency, created on first use."""
    ext = f"cash:{currency}"
    acc = session.exec(
        select(Account).where(Account.bank == Bank.MANUAL, Account.external_id == ext)
    ).first()
    if acc is not None or not create:
        return acc
    acc = Account(
        bank=Bank.MANUAL,
        name="Gotówka" if currency == "PLN" else f"Gotówka ({currency})",
        external_id=ext,
        type=AccountType.CASH,
        currency=currency,
    )
    session.add(acc)
    session.flush()
    return acc


def _sync_cash_leg(session: Session, bank_txn: Transaction, category: str) -> None:
    """Keep a cash-pool credit in sync with a bank withdrawal marked cash_withdrawal.

    The mirror is a positive entry on the cash account keyed by the bank txn id
    (dedup_hash = ``cashleg:<id>``), so it's idempotent and removable."""
    tag = f"cashleg:{bank_txn.id}"
    existing = session.exec(
        select(Transaction).where(Transaction.dedup_hash == tag)
    ).first()

    if category == "cash_withdrawal":
        cash = get_cash_account(session, bank_txn.currency, create=True)
        amount = abs(bank_txn.amount)
        if existing is None:
            session.add(
                Transaction(
                    account_id=cash.id,
                    booking_date=bank_txn.booking_date,
                    value_date=bank_txn.value_date,
                    amount=amount,
                    currency=bank_txn.currency,
                    counterparty_name="Wypłata gotówki",
                    description=bank_txn.reference or bank_txn.description or "Wypłata gotówki",
                    reference="Wypłata gotówki",
                    source=Source.MANUAL,
                    dedup_hash=tag,
                    occurrence=0,
                    category="cash_withdrawal",
                    category_source="cash_leg",
                    raw={"cash_leg_of": bank_txn.id},
                )
            )
        else:
            existing.amount = amount
            existing.booking_date = bank_txn.booking_date
            existing.currency = bank_txn.currency
            session.add(existing)
    elif existing is not None:
        session.delete(existing)


def add_cash_expense(
    session: Session,
    *,
    amount: Decimal | float | str,
    title: str,
    category: str,
    currency: str = "PLN",
    on_date: date | None = None,
) -> Transaction:
    """Log a manual cash expense that draws down the cash pool (a real expense)."""
    from .categorize import taxonomy

    if category not in taxonomy.CATEGORY_KEYS:
        raise ValueError(f"Unknown category: {category}")
    amt = -abs(Decimal(str(amount)))
    if amt == 0:
        raise ValueError("Amount must be non-zero")
    cash = get_cash_account(session, currency, create=True)
    txn = Transaction(
        account_id=cash.id,
        booking_date=on_date or date.today(),
        amount=amt,
        currency=currency,
        counterparty_name=title,
        description=title,
        reference=title,
        source=Source.MANUAL,
        dedup_hash=f"cashexp:{uuid.uuid4().hex}",
        occurrence=0,
        category=category,
        category_source="manual_txn",
        raw={"cash_expense": True},
    )
    session.add(txn)
    session.flush()
    return txn


def delete_cash_transaction(session: Session, txn_id: int) -> bool:
    """Delete a cash-pool entry. Only transactions on a cash account are removable;
    deleting a withdrawal mirror reverts its source bank transaction's category."""
    t = session.get(Transaction, txn_id)
    if t is None or t.account_id not in _cash_account_ids(session):
        return False
    src_id = (t.raw or {}).get("cash_leg_of")
    session.delete(t)
    if src_id is not None:
        bank_txn = session.get(Transaction, src_id)
        if bank_txn is not None:
            _recategorize_one(session, bank_txn)
    return True


def _recategorize_one(session: Session, t: Transaction) -> None:
    """Re-run the deterministic engine for one transaction (e.g. after un-marking)."""
    from . import analytics
    from .categorize import engine
    from .categorize.rules import load_rules

    subs = {c.counterparty for c in analytics.detect_recurring(session)}
    t.category, t.category_source = engine.categorize(
        t, own_ibans=_own_ibans(session), rules=load_rules(session), subscription_keys=subs
    )
    session.add(t)


def set_loan(
    session: Session,
    account_id: int,
    principal,
    annual_rate,
    term_months: int,
    start_date: date,
    origination_date: date | None = None,
) -> Loan:
    """Create/update amortization terms for a loan account.

    start_date = first installment date; origination_date = disbursement (debt
    exists from then). Between them the full principal is owed (no payment yet).
    """
    existing = session.exec(select(Loan).where(Loan.account_id == account_id)).first()
    if existing is not None:
        existing.principal = Decimal(str(principal))
        existing.annual_rate = Decimal(str(annual_rate))
        existing.term_months = term_months
        existing.start_date = start_date
        existing.origination_date = origination_date
        session.add(existing)
        return existing
    loan = Loan(
        account_id=account_id,
        principal=Decimal(str(principal)),
        annual_rate=Decimal(str(annual_rate)),
        term_months=term_months,
        start_date=start_date,
        origination_date=origination_date,
    )
    session.add(loan)
    return loan


def set_vehicle(
    session: Session,
    *,
    name: str,
    purchase_price: Decimal | float | str,
    purchase_date: date,
    annual_rate: Decimal | float | str,
    floor: Decimal | float | str | None = None,
    currency: str = "PLN",
) -> Account:
    """Create/update a depreciating VEHICLE asset (declining-balance from the
    purchase price). Counts as illiquid net worth, like property."""
    account = get_or_create_account(
        session,
        bank=Bank.MANUAL,
        name=name,
        external_id=f"vehicle:{name}",
        type=AccountType.VEHICLE,
        currency=currency,
    )
    session.flush()
    existing = session.exec(
        select(Depreciation).where(Depreciation.account_id == account.id)
    ).first()
    floor_val = Decimal(str(floor)) if floor is not None else None
    if existing is not None:
        existing.purchase_price = Decimal(str(purchase_price))
        existing.purchase_date = purchase_date
        existing.annual_rate = Decimal(str(annual_rate))
        existing.floor = floor_val
        session.add(existing)
    else:
        session.add(
            Depreciation(
                account_id=account.id,
                purchase_price=Decimal(str(purchase_price)),
                purchase_date=purchase_date,
                annual_rate=Decimal(str(annual_rate)),
                floor=floor_val,
            )
        )
    return account


def recategorize_merchant(session: Session, merchant_key_value: str, category: str) -> int:
    """Pin a merchant to a category (manual, locked) and re-apply to its rows."""
    from .categorize.rules import upsert_rule
    from .ingestion.normalize import merchant_key

    upsert_rule(session, merchant_key_value, category, source="manual", locked=True)
    n = 0
    for t in session.exec(select(Transaction)).all():
        if merchant_key(t.counterparty_name, t.reference, t.description) == merchant_key_value:
            t.category, t.category_source = category, "manual"
            session.add(t)
            n += 1
    return n
