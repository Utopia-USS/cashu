"""Source-agnostic transaction representation + normalization helpers.

Every importer (Open Banking, CSV, ...) parses its input into `RawTransaction`
objects. Everything downstream (dedup, transfer matching, persistence) works
only against this normalized shape, so bank-specific quirks stay isolated in
the parsers.
"""

from __future__ import annotations

import hashlib
import re
import unicodedata
from datetime import date
from decimal import Decimal

from pydantic import BaseModel, ConfigDict, field_validator

from ..models import Source, Transaction

_WS = re.compile(r"\s+")


def normalize_text(value: str | None) -> str:
    """Uppercase, strip diacritics, collapse whitespace — for stable matching."""
    if not value:
        return ""
    # strip accents (ł -> l is not handled by NFKD, so special-case it)
    value = value.replace("ł", "l").replace("Ł", "L")
    value = unicodedata.normalize("NFKD", value)
    value = "".join(c for c in value if not unicodedata.combining(c))
    return _WS.sub(" ", value).strip().upper()


def normalize_iban(value: str | None) -> str:
    """Strip spaces, apostrophes and any punctuation (bank exports guard account
    numbers with a leading `'` for Excel), leaving only alphanumerics, uppercased."""
    if not value:
        return ""
    return re.sub(r"[^0-9A-Za-z]", "", value).upper()


def iban_key(value: str | None) -> str:
    """Canonical account key for matching across sources.

    Polish CSV exports give the bare 26-digit NRB (``02114...``) while Open
    Banking returns the full IBAN with a country prefix (``PL02114...``). Strip a
    leading 2-letter country code so both forms compare equal.
    """
    s = normalize_iban(value)
    if len(s) > 2 and s[:2].isalpha():
        s = s[2:]
    return s


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
