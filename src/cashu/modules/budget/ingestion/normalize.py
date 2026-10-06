"""Source-agnostic transaction representation + normalization helpers.

Every importer (Open Banking, CSV, ...) parses its input into `RawTransaction`
objects. Everything downstream (dedup, transfer matching, persistence) works
only against this normalized shape, so bank-specific quirks stay isolated in
the parsers.
"""

from __future__ import annotations

import hashlib
import re
from datetime import date
from decimal import Decimal

from pydantic import BaseModel, ConfigDict, field_validator

from cashu.core.models import Source
from cashu.core.text import iban_key, normalize_iban, normalize_text

from ..models import Transaction

__all__ = [
    "RawTransaction",
    "base_hash",
    "iban_key",
    "merchant_key",
    "normalize_iban",
    "normalize_text",
    "to_transaction",
]

_TX_DATE_SUFFIX = re.compile(r"DATA TRANSAKCJI:.*$", re.IGNORECASE)


def merchant_key(*fields: str | None) -> str:
    """Stable merchant identifier from title/counterparty fields.

    Strips mBank's 'DATA TRANSAKCJI: <date>' suffix (it changes every occurrence
    and would otherwise make each payment unique) and trailing location padding,
    then normalizes. Returns the first non-empty result.
    """
    for f in fields:
        if not f:
            continue
        s = _TX_DATE_SUFFIX.sub("", f)
        s = re.sub(r"\s{2,}.*$", "", s)  # merchant is before the location padding
        s = normalize_text(s)
        if s:
            return s
    return ""


class RawTransaction(BaseModel):
    """A parsed, not-yet-persisted transaction from any source."""

    model_config = ConfigDict(arbitrary_types_allowed=True)

    booking_date: date
    value_date: date | None = None
    amount: Decimal  # signed: negative = outflow, positive = inflow
    currency: str = "PLN"
    counterparty_name: str | None = None
    counterparty_iban: str | None = None
    description: str | None = None
    reference: str | None = None
    bank_transaction_id: str | None = None
    source: Source
    raw: dict = {}

    @field_validator("amount", mode="before")
    @classmethod
    def _coerce_amount(cls, v):
        return Decimal(str(v))

    @property
    def memo(self) -> str:
        parts = [self.description, self.reference]
        return " ".join(p for p in parts if p)


def base_hash(account_id: int, rt: RawTransaction) -> str:
    """Content hash used for cross-source deduplication.

    Deliberately excludes `source` and `bank_transaction_id` so the same real
    transaction seen via both CSV and Open Banking hashes identically.
    """
    counterparty = iban_key(rt.counterparty_iban) or normalize_text(rt.counterparty_name)
    key = "|".join(
        [
            str(account_id),
            rt.booking_date.isoformat(),
            f"{rt.amount:.2f}",
            rt.currency.upper(),
            counterparty,
            normalize_text(rt.memo),
        ]
    )
    return hashlib.sha1(key.encode("utf-8")).hexdigest()


def to_transaction(
    rt: RawTransaction,
    *,
    account_id: int,
    dedup_hash: str,
    occurrence: int,
    import_batch_id: int | None = None,
) -> Transaction:
    return Transaction(
        account_id=account_id,
        booking_date=rt.booking_date,
        value_date=rt.value_date,
        amount=rt.amount,
        currency=rt.currency.upper(),
        counterparty_name=rt.counterparty_name,
        counterparty_iban=normalize_iban(rt.counterparty_iban) or None,
        description=rt.description,
        reference=rt.reference,
        bank_transaction_id=rt.bank_transaction_id,
        source=rt.source,
        dedup_hash=dedup_hash,
        occurrence=occurrence,
        raw=rt.raw or {},
        import_batch_id=import_batch_id,
    )
