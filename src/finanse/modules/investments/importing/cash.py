"""Gross / cash amount derivation shared by importers, including the cross-currency rule (R5).

Sign conventions are those of ``domain.Transaction``: ``gross_amount`` >= 0, ``cash_amount`` signed in
``cash_currency``, ``fx_rate`` = units of ``cash_currency`` per 1 unit of the trade ``currency``.

R5: when the cash amount has to be derived from the gross amount (or the reverse) and the cash currency
differs from the trade currency, ``fx_rate`` converts; without a rate the row is rejected
(:class:`AmountError`) instead of booking the trade amount as if it were in the cash currency.
"""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal

from ..domain import Currency, TxnType, divided_by, exact_decimals

CASH_OUTFLOW_TYPES: frozenset[TxnType] = frozenset(
    {TxnType.BUY, TxnType.WITHDRAWAL, TxnType.FEE, TxnType.TAX}
)
"""Types that take money out of the account (negative cash amount)."""

CASH_INFLOW_TYPES: frozenset[TxnType] = frozenset(
    {TxnType.SELL, TxnType.DIVIDEND, TxnType.DEPOSIT, TxnType.INTEREST}
)
"""Types that bring money into the account (positive cash amount)."""

CASH_NEUTRAL_TYPES: frozenset[TxnType] = frozenset(
    {TxnType.SPLIT, TxnType.TRANSFER_IN, TxnType.TRANSFER_OUT, TxnType.ADJUSTMENT}
)
"""Types without a cash effect unless the file says otherwise."""

_ZERO = Decimal(0)


class AmountError(ValueError):
    """Amounts of a row are missing or inconsistent (a row error for the importer).

    ``kind`` is the matching ``ImportWarningKind`` value (``fx_missing`` for R5, else ``amount``).
    """

    def __init__(self, message: str, kind: str = "amount") -> None:
        super().__init__(message)
        self.kind = kind


def signed_cash(txn_type: TxnType, value: Decimal, *, absolute: bool) -> Decimal:
    """``value`` with its direction: as written when not ``absolute``, else from ``txn_type``.

    Raises :class:`AmountError` for an absolute ``fx_conversion`` amount (its direction is unknown).
    """
    if not absolute:
        return value
    if txn_type in CASH_OUTFLOW_TYPES:
        return value.copy_abs().copy_negate()
    if txn_type in CASH_INFLOW_TYPES:
        return value.copy_abs()
    if txn_type == TxnType.FX_CONVERSION:
        raise AmountError(
            "fx_conversion rows need signed amounts (the direction cannot be derived)"
        )
    return value


def gross_from_cash(txn_type: TxnType, cash: Decimal, fee: Decimal, tax: Decimal) -> Decimal:
    """Gross amount implied by a net cash amount in the trade currency: inflows add fee and tax back,
    outflows remove them."""
    magnitude = abs(cash)
    if txn_type in CASH_INFLOW_TYPES:
        gross = magnitude + fee + tax
    elif txn_type in CASH_OUTFLOW_TYPES:
        gross = magnitude - fee - tax
    else:
        gross = magnitude
    if gross < 0:
        raise AmountError("fee and tax exceed the cash amount")
    return gross


def cash_from_gross(txn_type: TxnType, gross: Decimal, fee: Decimal, tax: Decimal) -> Decimal:
    """Net cash effect (trade currency) implied by a gross amount when the row has no cash amount."""
    if txn_type in CASH_INFLOW_TYPES:
        return gross - fee - tax
    if txn_type in CASH_OUTFLOW_TYPES:
        return -(gross + fee + tax)
    if txn_type in CASH_NEUTRAL_TYPES:
        return _ZERO
    raise AmountError(f"{txn_type.value} rows need a cash_amount value")


def to_cash_currency(
    amount: Decimal, currency: Currency, cash_currency: Currency, fx_rate: Decimal | None
) -> Decimal:
    """``amount`` (trade ``currency``) in ``cash_currency`` via ``fx_rate`` (R5)."""
    if cash_currency == currency or amount == 0:
        return amount
    if fx_rate is None or fx_rate == 0:
        raise AmountError(
            f"cash_amount is empty and cash_currency {cash_currency} differs from currency "
            f"{currency}: fx_rate (or cash_amount) is needed to derive the cash effect",
            kind="fx_missing",
        )
    return amount * fx_rate


def to_trade_currency(
    amount: Decimal, currency: Currency, cash_currency: Currency, fx_rate: Decimal | None
) -> Decimal:
    """``amount`` (``cash_currency``) in the trade ``currency`` via ``fx_rate`` (R5, reverse)."""
    if cash_currency == currency or amount == 0:
        return amount
    if fx_rate is None or fx_rate == 0:
        raise AmountError(
            f"gross_amount is empty and cash_currency {cash_currency} differs from currency "
            f"{currency}: fx_rate (or gross_amount, or quantity and price) is needed to derive "
            "the gross amount",
            kind="fx_missing",
        )
    return divided_by(amount, fx_rate)


@dataclass(frozen=True, slots=True)
class DerivedAmounts:
    gross_amount: Decimal
    """>= 0, trade currency."""
    cash_amount: Decimal
    """Signed, cash currency."""


def derive_amounts(
    *,
    txn_type: TxnType,
    currency: Currency,
    cash_currency: Currency,
    gross: Decimal | None = None,
    cash: Decimal | None = None,
    quantity: Decimal | None = None,
    price: Decimal | None = None,
    fee: Decimal = _ZERO,
    tax: Decimal = _ZERO,
    fx_rate: Decimal | None = None,
) -> DerivedAmounts:
    """Fill in the gross and cash amounts of a row from whatever it has.

    Gross: the given gross (absolute), else ``quantity * price``, else derived from the cash amount
    (converted to the trade currency, fee and tax added back / removed), else 0 for rows with only a fee
    or tax or a cash-neutral type. Cash: the given (already signed) cash, else derived from the gross
    amount and converted to the cash currency. Raises :class:`AmountError` when neither is possible.
    """
    with exact_decimals():
        fee = abs(fee)
        tax = abs(tax)
        derived_gross: Decimal | None
        if gross is not None:
            derived_gross = abs(gross)
        elif quantity is not None and price is not None:
            derived_gross = abs(quantity) * abs(price)
        elif cash is not None:
            derived_gross = gross_from_cash(
                txn_type, to_trade_currency(cash, currency, cash_currency, fx_rate), fee, tax
            )
        elif fee + tax > 0 or txn_type in CASH_NEUTRAL_TYPES:
            derived_gross = _ZERO
        else:
            raise AmountError("no amount (gross_amount, cash_amount, or quantity and price)")
        if cash is None:
            cash = to_cash_currency(
                cash_from_gross(txn_type, derived_gross, fee, tax), currency, cash_currency, fx_rate
            )
        return DerivedAmounts(derived_gross, cash)


__all__ = [
    "CASH_INFLOW_TYPES",
    "CASH_NEUTRAL_TYPES",
    "CASH_OUTFLOW_TYPES",
    "AmountError",
    "DerivedAmounts",
    "cash_from_gross",
    "derive_amounts",
    "gross_from_cash",
    "signed_cash",
    "to_cash_currency",
    "to_trade_currency",
]
