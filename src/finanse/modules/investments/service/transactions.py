"""Manual transactions: one account event typed in by hand (the F3 workspace form), validated with the
per-type rules of the canonical import format (docs/import-format.md, section 4) and stored like an
imported row (``source = manual``).

Deduplication: a manual row gets the content dedup hash an import of the same row without an
``external_ref`` would get (``importing.dedup``, broker id ``manual``), with the smallest occurrence
index the account does not use yet. So two identical manual entries both store (occurrences 0 and 1),
and a later import of the same trade without an external ref is recognized as a duplicate of it
instead of being booked twice. Rows with an external ref hash by the ref and never match a manual row.
"""

from __future__ import annotations

import datetime as dt
import re
from dataclasses import dataclass, replace
from decimal import Decimal

from sqlmodel import Session

from finanse.core.models import Account, Profile, utcnow

from ..domain import (
    AliasNamespace,
    AssetClass,
    Currency,
    Instrument,
    InstrumentAlias,
    Transaction,
    TxnSource,
    TxnType,
)
from ..importing.cash import AmountError, derive_amounts
from ..importing.dedup import DedupInput, dedup_hash
from ..importing.exchanges import exchange_for_hint
from ..models import InvTransaction
from ..store import convert, instruments, transactions

MANUAL_BROKER_ID = "manual"
"""Broker id of manual rows in their dedup hash (content hashes do not depend on it)."""

INSTRUMENT_REQUIRED = frozenset(
    {
        TxnType.BUY,
        TxnType.SELL,
        TxnType.SPLIT,
        TxnType.TRANSFER_IN,
        TxnType.TRANSFER_OUT,
        TxnType.ADJUSTMENT,
    }
)
INSTRUMENT_FORBIDDEN = frozenset({TxnType.DEPOSIT, TxnType.WITHDRAWAL, TxnType.FX_CONVERSION})
QUANTITY_REQUIRED = frozenset(
    {TxnType.BUY, TxnType.SELL, TxnType.TRANSFER_IN, TxnType.TRANSFER_OUT, TxnType.ADJUSTMENT}
)
QUANTITY_FORBIDDEN = frozenset(
    {
        TxnType.INTEREST,
        TxnType.DEPOSIT,
        TxnType.WITHDRAWAL,
        TxnType.FEE,
        TxnType.TAX,
        TxnType.FX_CONVERSION,
    }
)
CASH_NEUTRAL = frozenset(
    {TxnType.SPLIT, TxnType.TRANSFER_IN, TxnType.TRANSFER_OUT, TxnType.ADJUSTMENT}
)

_ISIN = re.compile(r"^[A-Z]{2}[A-Z0-9]{9}[0-9]$")
_MIC = re.compile(r"^[A-Z]{4}$")
_HASH_BATCH = 32


class ManualTxnError(ValueError):
    """Invalid manual transaction input (message safe to show; the API answers 422)."""


class ManualTxnNotFound(LookupError):
    """The account or instrument is not one of the profile's (the API answers 404)."""


@dataclass(frozen=True)
class InstrumentInput:
    """An instrument described by hand (used when no ``instrument_id`` is given)."""

    symbol: str | None = None
    isin: str | None = None
    name: str | None = None
    currency: str | None = None
    exchange: str | None = None
    asset_class: str | None = None

    @property
    def identifies(self) -> bool:
        """True when it names an instrument (symbol, ISIN or name)."""
        return any(_clean(v) for v in (self.symbol, self.isin, self.name))


@dataclass(frozen=True)
class ManualTxnInput:
    account_id: int
    type: str
    trade_date: dt.date
    instrument_id: int | None = None
    """An instrument the profile references; wins over ``instrument``."""
    instrument: InstrumentInput | None = None
    quantity: Decimal | None = None
    price: Decimal | None = None
    gross_amount: Decimal | None = None
    fee: Decimal | None = None
    tax: Decimal | None = None
    cash_amount: Decimal | None = None
    """Signed net cash effect in ``cash_currency``; derived from the gross amount when empty."""
    fx_rate: Decimal | None = None
    split_ratio: Decimal | None = None
    currency: str | None = None
    """Trade currency; default: the instrument's currency, else the account currency."""
    cash_currency: str | None = None
    """Default: ``currency``."""
    note: str | None = None


@dataclass(frozen=True)
class ManualTxnResult:
    transaction: Transaction
    """The stored transaction (domain, with its row id)."""
    account: Account
    instrument: Instrument | None
    new_instrument: bool
    warnings: list[str]


def _clean(value: str | None) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _currency(value: str | None, name: str) -> Currency:
    try:
        return Currency(value or "")
    except ValueError:
        raise ManualTxnError(f"{name} must be a 3-letter currency code") from None


def _mic(exchange: str | None) -> str | None:
    """The MIC an exchange text names: a known market (``GPW`` -> ``XWAR``) or anything that looks
    like a 4-letter MIC; None otherwise."""
    text = _clean(exchange)
    if text is None:
        return None
    known = exchange_for_hint(text)
    if known is not None and known.mic:
        return known.mic
    upper = text.upper()
    return upper if _MIC.match(upper) else None


def _validate_shape(txn_type: TxnType, data: ManualTxnInput) -> None:
    """Instrument / quantity / split ratio presence and the signs of the plain amounts."""
    name = txn_type.value
    described = data.instrument is not None and (
        data.instrument.identifies or _clean(data.instrument.exchange)
    )
    has_instrument = data.instrument_id is not None or bool(described)
    if txn_type in INSTRUMENT_FORBIDDEN and has_instrument:
        raise ManualTxnError(f"{name} must not have an instrument")
    if txn_type in INSTRUMENT_REQUIRED and not (
        data.instrument_id is not None
        or (data.instrument is not None and data.instrument.identifies)
    ):
        raise ManualTxnError(
            f"{name} needs an instrument (instrument_id, or a symbol, ISIN or name)"
        )

    if txn_type in QUANTITY_REQUIRED and (data.quantity is None or data.quantity <= 0):
        raise ManualTxnError(f"{name} needs a quantity > 0")
    if txn_type in QUANTITY_FORBIDDEN and data.quantity is not None:
        raise ManualTxnError(f"{name} must not have a quantity")

    if txn_type == TxnType.SPLIT:
        if data.split_ratio is None or data.split_ratio <= 0:
            raise ManualTxnError("split needs a split_ratio > 0 (new units per old unit)")
    elif data.split_ratio is not None:
        raise ManualTxnError(f"split_ratio is only allowed on split rows, not on {name}")

    for field_name in ("quantity", "price", "gross_amount", "fee", "tax"):
        value = getattr(data, field_name)
        if value is not None and value < 0:
            raise ManualTxnError(f"{field_name} must be >= 0 (the direction comes from the type)")
    if data.fx_rate is not None and data.fx_rate <= 0:
        raise ManualTxnError("fx_rate must be > 0")


def _check_cash_sign(txn_type: TxnType, cash: Decimal) -> str | None:
    """Raise for a cash amount whose sign contradicts the type; return a warning for the types where
    the other sign is unusual but possible (a dividend correction, a fee refund)."""
    name = txn_type.value
    if txn_type == TxnType.BUY and cash > 0:
        raise ManualTxnError("buy needs a cash_amount <= 0 (money leaves the account)")
    if txn_type == TxnType.SELL and cash < 0:
        raise ManualTxnError("sell needs a cash_amount >= 0 (money comes into the account)")
    if txn_type == TxnType.DEPOSIT and cash < 0:
        raise ManualTxnError("deposit needs a cash_amount >= 0")
    if txn_type == TxnType.WITHDRAWAL and cash > 0:
        raise ManualTxnError("withdrawal needs a cash_amount <= 0")
    if txn_type in CASH_NEUTRAL and cash != 0:
        raise ManualTxnError(f"{name} has no cash effect: cash_amount must be empty or 0")
    if txn_type in (TxnType.DIVIDEND, TxnType.INTEREST) and cash < 0:
        return f"{name} with a negative cash_amount ({cash}): stored as entered, check the sign"
    if txn_type in (TxnType.FEE, TxnType.TAX) and cash > 0:
        return f"{name} with a positive cash_amount ({cash}): stored as a refund, check the sign"
    return None


def _existing_instrument(session: Session, profile: Profile, instrument_id: int) -> Instrument:
    if instrument_id not in instruments.profile_instrument_ids(session, profile.id):
        raise ManualTxnNotFound(f"No instrument {instrument_id} in this profile")
    found = instruments.load_one(session, instrument_id, profile_id=profile.id)
    if found is None:
        raise ManualTxnNotFound(f"No instrument {instrument_id}")
    return found


def _find_described(
    session: Session, profile: Profile, spec: InstrumentInput, isin: str | None, mic: str | None
) -> Instrument | None:
    """A stored instrument the description means: same ISIN (confirmed), else the same symbol among
    the instruments the profile already references (and the same MIC when an exchange is given)."""
    if isin is not None:
        found = instruments.DbInstrumentLookup(session, confirmed_only=True).by_isin(isin)
        if found is not None:
            return found
    symbol = _clean(spec.symbol)
    if symbol is None:
        return None
    upper = symbol.upper()
    referenced = instruments.load(
        session, instruments.profile_instrument_ids(session, profile.id), profile_id=profile.id
    )
    for key in sorted(referenced):
        inst = referenced[key]
        if (inst.symbol or "").strip().upper() != upper:
            continue
        if mic is not None and inst.mic != mic:
            continue
        if isin is not None and inst.isin and inst.isin.upper() != isin:
            continue  # another listing / security with the same ticker
        return inst
    return None


def _planned_instrument(
    spec: InstrumentInput, isin: str | None, mic: str | None, currency: Currency
) -> Instrument:
    symbol = _clean(spec.symbol)
    raw_class = _clean(spec.asset_class) or AssetClass.OTHER.value
    try:
        asset_class = AssetClass(raw_class.lower())
    except ValueError:
        known = ", ".join(a.value for a in AssetClass)
        raise ManualTxnError(f"Unknown asset_class {raw_class!r}; known: {known}") from None
    instrument_currency = (
        _currency(spec.currency, "instrument.currency") if _clean(spec.currency) else currency
    )
    return Instrument(
        id="new-manual",
        name=_clean(spec.name) or symbol or isin or "",
        currency=instrument_currency,
        asset_class=asset_class,
        symbol=symbol,
        isin=isin,
        mic=mic,
        needs_classification=True,
        aliases=(InstrumentAlias(AliasNamespace.ISIN, isin),) if isin else (),
    )


def _free_dedup_hash(session: Session, account_id: int, txn: Transaction) -> str:
    """The content dedup hash of ``txn`` with the smallest occurrence index the account does not
    have yet (see the module docstring)."""
    row = DedupInput.from_transaction(txn)
    start = 0
    while True:
        candidates = [
            dedup_hash(
                row,
                account_id=convert.sid(account_id),
                broker_id=MANUAL_BROKER_ID,
                occurrence=k,
            )
            for k in range(start, start + _HASH_BATCH)
        ]
        taken = transactions.existing_hashes(session, account_id, candidates)
        for digest in candidates:
            if digest not in taken:
                return digest
        start += _HASH_BATCH


def add_manual(
    session: Session, profile: Profile, data: ManualTxnInput, *, now: dt.datetime | None = None
) -> ManualTxnResult:
    """Validate and store one manual transaction in the caller's transaction (see the module doc).

    Raises :class:`ManualTxnNotFound` for an account or instrument outside the profile and
    :class:`ManualTxnError` for invalid input. A described instrument that is not stored yet is
    inserted (``needs_classification``) only after every check passed.
    """
    account = transactions.brokerage_account(session, profile.id, data.account_id)
    if account is None:
        raise ManualTxnNotFound(f"No brokerage account {data.account_id} in this profile")
    try:
        txn_type = TxnType((data.type or "").strip().lower())
    except ValueError:
        known = ", ".join(t.value for t in TxnType)
        raise ManualTxnError(f"Unknown type {data.type!r}; known: {known}") from None
    _validate_shape(txn_type, data)

    # Instrument (looked up now, inserted at the end).
    existing: Instrument | None = None
    planned: Instrument | None = None
    spec = data.instrument if data.instrument_id is None else None
    isin = mic = None
    if data.instrument_id is not None:
        existing = _existing_instrument(session, profile, data.instrument_id)
    elif spec is not None and spec.identifies:
        isin = (_clean(spec.isin) or "").upper() or None
        if isin is not None and not _ISIN.match(isin):
            raise ManualTxnError("instrument.isin must be a 12-character ISIN")
        mic = _mic(spec.exchange)
        existing = _find_described(session, profile, spec, isin, mic)

    # Currencies.
    if _clean(data.currency):
        currency = _currency(data.currency, "currency")
    elif existing is not None:
        currency = existing.currency
    elif spec is not None and _clean(spec.currency):
        currency = _currency(spec.currency, "instrument.currency")
    else:
        currency = _currency(account.currency, "account currency")
    cash_currency = (
        _currency(data.cash_currency, "cash_currency") if _clean(data.cash_currency) else currency
    )
    if txn_type == TxnType.FX_CONVERSION:
        if data.cash_amount is None or data.cash_amount == 0:
            raise ManualTxnError("fx_conversion needs a signed, non-zero cash_amount")
        if cash_currency != currency:
            raise ManualTxnError(
                "fx_conversion is one leg per currency: currency and cash_currency must be equal"
            )
    if existing is None and spec is not None and spec.identifies:
        planned = _planned_instrument(spec, isin, mic, currency)

    # Amounts and the cash sign.
    fee = data.fee if data.fee is not None else Decimal(0)
    tax = data.tax if data.tax is not None else Decimal(0)
    try:
        amounts = derive_amounts(
            txn_type=txn_type,
            currency=currency,
            cash_currency=cash_currency,
            gross=data.gross_amount,
            cash=data.cash_amount,
            quantity=data.quantity,
            price=data.price,
            fee=fee,
            tax=tax,
            fx_rate=data.fx_rate,
        )
    except AmountError as e:
        raise ManualTxnError(str(e)) from None
    warnings: list[str] = []
    warning = _check_cash_sign(txn_type, amounts.cash_amount)
    if warning is not None:
        warnings.append(warning)

    # Store: the new instrument (if any), then the row with a free dedup hash.
    new_instrument = False
    instrument = existing
    if planned is not None:
        row = instruments.insert(session, planned)
        instrument = instruments.load_one(session, row.id)
        new_instrument = True
    created_at = convert.aware(now or utcnow())
    txn = Transaction(
        id="manual",
        account_id=convert.sid(account.id),
        type=txn_type,
        trade_date=data.trade_date,
        currency=currency,
        gross_amount=amounts.gross_amount,
        cash_amount=amounts.cash_amount,
        cash_currency=cash_currency,
        instrument_id=None if instrument is None else instrument.id,
        quantity=data.quantity,
        price=data.price,
        fee=fee,
        tax=tax,
        fx_rate=data.fx_rate,
        split_ratio=data.split_ratio,
        note=_clean(data.note),
        source=TxnSource.MANUAL,
        created_at=created_at,
    )
    txn = replace(txn, dedup_hash=_free_dedup_hash(session, account.id, txn))
    stored: InvTransaction = convert.transaction_row(
        txn,
        account_id=account.id,
        instrument_id=None if instrument is None else convert.pk(instrument.id),
        created_at=created_at,
    )
    session.add(stored)
    session.flush()
    if txn_type == TxnType.DEPOSIT:  # a deposit booked by hand books a matching plan too (F6)
        from . import planned

        planned.book_matching(session, profile.id, now=created_at)
    return ManualTxnResult(
        transaction=convert.transaction(stored),
        account=account,
        instrument=instrument,
        new_instrument=new_instrument,
        warnings=warnings,
    )
