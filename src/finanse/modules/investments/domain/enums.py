"""Domain enums. Each value is its snake_case wire name (DB, YAML, import mappings, API).

Renaming a value is therefore a data migration. Parse with the constructor: ``AssetClass("treasury_bond")``.
"""

from __future__ import annotations

from enum import StrEnum


class AccountWrapper(StrEnum):
    """Tax wrapper of a broker account."""

    REGULAR = "regular"
    IKE = "ike"
    IKZE = "ikze"
    OIPE = "oipe"
    OTHER = "other"


class AssetClass(StrEnum):
    """Asset class of an instrument (also matched by strategy buckets: ``asset_class: treasury_bond``)."""

    EQUITY = "equity"
    ETF = "etf"
    FUND = "fund"
    BOND = "bond"
    TREASURY_BOND = "treasury_bond"
    CASH = "cash"
    CRYPTO = "crypto"
    COMMODITY = "commodity"
    CLAIM = "claim"
    """A claim in insolvency proceedings (e.g. against a bankrupt exchange)."""
    OTHER = "other"


class TxnType(StrEnum):
    """Kind of a transaction. Quantities are always >= 0; the direction comes from the type.

    ``ADJUSTMENT`` only ever adds units (it opens a lot at ``price``, no price meaning unknown cost). A
    reduction of units is a ``TRANSFER_OUT`` with ``source = reconciliation`` (consumes FIFO lots without
    realizing a trade).
    """

    BUY = "buy"
    SELL = "sell"
    DIVIDEND = "dividend"
    DEPOSIT = "deposit"
    WITHDRAWAL = "withdrawal"
    FEE = "fee"
    TAX = "tax"
    INTEREST = "interest"
    FX_CONVERSION = "fx_conversion"
    SPLIT = "split"
    TRANSFER_IN = "transfer_in"
    TRANSFER_OUT = "transfer_out"
    ADJUSTMENT = "adjustment"


class TxnSource(StrEnum):
    """Where a transaction came from."""

    IMPORT = "import"
    MANUAL = "manual"
    RECONCILIATION = "reconciliation"


class ValuationMode(StrEnum):
    """How holdings of an instrument are valued.

    - ``MARKET``: from daily price bars (stale when the newest bar is too old), falling back to the last
      trade price.
    - ``COST``: at the holding's cost basis (base currency at trade-date FX), never stale (e.g. Polish
      treasury bonds until a formula valuation exists).
    - ``MANUAL``: at the newest manual valuation on/before the valuation date (0 is valid), never stale.
    """

    MARKET = "market"
    COST = "cost"
    MANUAL = "manual"


class InstrumentStatus(StrEnum):
    """Lifecycle of an instrument. Delisted and frozen instruments are not fetched from market sources;
    a frozen holding is valued manually (0 until a manual valuation says otherwise)."""

    ACTIVE = "active"
    DELISTED = "delisted"
    FROZEN = "frozen"


class SignalSeverity(StrEnum):
    """Severity of a signal, declared in ascending order (compare with :func:`severity_rank`)."""

    INFO = "info"
    ACTION = "action"


class SignalStatus(StrEnum):
    """Lifecycle of a signal. ``ACTIVE`` and ``ACKNOWLEDGED`` are "open"."""

    ACTIVE = "active"
    ACKNOWLEDGED = "acknowledged"
    RESOLVED = "resolved"
    EXPIRED = "expired"


class DecisionAction(StrEnum):
    """What the owner did about a signal or on their own."""

    BOUGHT = "bought"
    SOLD = "sold"
    HELD = "held"
    IGNORED = "ignored"
    OTHER = "other"


def severity_rank(severity: SignalSeverity) -> int:
    """Position of ``severity`` in ascending order (escalation = a higher rank)."""
    return list(SignalSeverity).index(severity)


def default_valuation_mode(asset_class: AssetClass) -> ValuationMode:
    """Treasury bonds at cost, claims manually, everything else at market."""
    if asset_class == AssetClass.TREASURY_BOND:
        return ValuationMode.COST
    if asset_class == AssetClass.CLAIM:
        return ValuationMode.MANUAL
    return ValuationMode.MARKET
