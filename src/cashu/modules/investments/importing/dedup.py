"""Deduplication hashes of imported transactions (the persistence layer stores them in a UNIQUE column).

R8: with an external ref the hash covers (account, broker, ref, fill key = type, instrument, quantity,
price, currency) plus an occurrence index counted per identical fill, so rows sharing a ref (partial fills
of one order, an order and its fee row) map to their own hashes whatever their order in the file or
overlap between exports. Without a ref the hash covers the full content plus an occurrence index among
identical rows of the same file: two identical legitimate rows both import, a re-import of the same file
is recognized. Decimals compare by value (``10.50`` equals ``10.5``).
"""

from __future__ import annotations

import hashlib
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from decimal import Decimal

from ..domain import AccountId, CalendarDate, Transaction, TxnType
from .contract import CASHU_NAMESPACE, LEGACY_NAMESPACE, ParsedTxn

_SEPARATOR = "\x1f"
HASH_VERSION = "v1"


@dataclass(frozen=True, slots=True, kw_only=True)
class DedupInput:
    """The fields of one transaction that identify it for deduplication."""

    trade_date: CalendarDate
    type: TxnType
    gross_amount: Decimal
    cash_amount: Decimal
    external_ref: str | None = None
    """The broker's row or order id; when present the hash uses it plus :attr:`fill_key`."""
    instrument_key: str | None = None
    """The resolved instrument id (stable across re-imports: the resolver finds the same instrument
    through its aliases), None for cash rows."""
    quantity: Decimal | None = None
    price: Decimal | None = None
    currency: str | None = None

    @staticmethod
    def from_transaction(txn: Transaction) -> DedupInput:
        return DedupInput(
            trade_date=txn.trade_date,
            type=txn.type,
            gross_amount=txn.gross_amount,
            cash_amount=txn.cash_amount,
            external_ref=txn.external_ref,
            instrument_key=txn.instrument_id,
            quantity=txn.quantity,
            price=txn.price,
            currency=txn.currency,
        )

    @staticmethod
    def from_parsed(txn: ParsedTxn, instrument_key: str | None) -> DedupInput:
        return DedupInput(
            trade_date=txn.trade_date,
            type=txn.type,
            gross_amount=txn.gross_amount.copy_abs(),
            cash_amount=txn.cash_amount,
            external_ref=txn.external_ref,
            instrument_key=instrument_key,
            quantity=None if txn.quantity is None else txn.quantity.copy_abs(),
            price=txn.price,
            currency=txn.currency,
        )

    @property
    def ref(self) -> str | None:
        ref = None if self.external_ref is None else self.external_ref.strip()
        return ref or None

    @property
    def content_key(self) -> str:
        """Key of the content variant, shared by rows that are identical for dedup purposes."""
        return _SEPARATOR.join(
            [
                self.trade_date.isoformat(),
                self.type.value,
                self.instrument_key or "",
                decimal_key(self.quantity),
                decimal_key(self.price),
                decimal_key(self.gross_amount),
                decimal_key(self.cash_amount),
            ]
        )

    @property
    def fill_key(self) -> str:
        """What tells apart rows sharing one external ref: type, instrument, quantity, price and
        currency. Amounts and dates are left out, so a re-export that rounds cash differently still
        matches."""
        return _SEPARATOR.join(
            [
                self.type.value,
                self.instrument_key or "",
                decimal_key(self.quantity),
                decimal_key(self.price),
                self.currency or "",
            ]
        )

    @property
    def occurrence_key(self) -> str:
        ref = self.ref
        if ref is not None:
            return _SEPARATOR.join(["ref", ref, self.fill_key])
        return _SEPARATOR.join(["content", self.content_key])


def decimal_key(value: Decimal | None) -> str:
    """Canonical text of a decimal compared by value (``10.50`` -> ``10.5``, ``1E+1`` -> ``10``);
    empty for None. Exact (no context rounding)."""
    if value is None:
        return ""
    text = format(value, "f")
    if "." in text:
        text = text.rstrip("0").rstrip(".")
    if text in ("", "-0", "-"):
        return "0"
    return text


def dedup_hash(
    row: DedupInput, *, account_id: AccountId, broker_id: str, occurrence: int = 0
) -> str:
    """Lower-case hex SHA-256 identifying ``row`` in ``account_id`` (see the module docstring)."""
    ref = row.ref
    if broker_id == CASHU_NAMESPACE:  # legacy name: hashes keep the pre-rename id, so rows
        broker_id = LEGACY_NAMESPACE  # imported before the rename stay duplicates
    if ref is not None:
        parts = [HASH_VERSION, "ref", account_id, broker_id, ref, row.fill_key, str(occurrence)]
    else:
        parts = [HASH_VERSION, "content", account_id, row.content_key, str(occurrence)]
    return hashlib.sha256(_SEPARATOR.join(parts).encode("utf-8")).hexdigest()


def dedup_hashes(
    rows: Iterable[DedupInput], *, account_id: AccountId, broker_id: str
) -> tuple[str, ...]:
    """:func:`dedup_hash` of every row of one file in input order, with occurrence indexes counted per
    identical row (per ref and fill key, or per content key). Identical rows are interchangeable, so
    the set of hashes does not depend on the file order."""
    seen: dict[str, int] = {}
    hashes: list[str] = []
    for row in rows:
        key = row.occurrence_key
        occurrence = seen.get(key, 0)
        seen[key] = occurrence + 1
        hashes.append(
            dedup_hash(row, account_id=account_id, broker_id=broker_id, occurrence=occurrence)
        )
    return tuple(hashes)


def reconciliation_hash(
    account_id: AccountId,
    instrument_id: str,
    as_of: CalendarDate,
    txn_type: TxnType,
    quantity: Decimal,
) -> str:
    """Dedup hash of a reconciliation correction: applying the same proposal twice inserts it once."""
    parts = [
        HASH_VERSION,
        "reconciliation",
        account_id,
        instrument_id,
        as_of.isoformat(),
        txn_type.value,
        decimal_key(quantity),
    ]
    return hashlib.sha256(_SEPARATOR.join(parts).encode("utf-8")).hexdigest()


def parsed_dedup_inputs(
    txns: Sequence[ParsedTxn], instrument_keys: Sequence[str | None]
) -> tuple[DedupInput, ...]:
    """:class:`DedupInput` of parsed rows with their resolved instrument ids (same length)."""
    if len(txns) != len(instrument_keys):
        raise ValueError("txns and instrument_keys must have the same length")
    return tuple(
        DedupInput.from_parsed(txn, key) for txn, key in zip(txns, instrument_keys, strict=True)
    )


__all__ = [
    "HASH_VERSION",
    "DedupInput",
    "decimal_key",
    "dedup_hash",
    "dedup_hashes",
    "parsed_dedup_inputs",
    "reconciliation_hash",
]
