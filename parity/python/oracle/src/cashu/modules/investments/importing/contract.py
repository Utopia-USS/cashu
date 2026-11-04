"""Broker import contract: what every importer receives and returns (pure data, no IO).

Contract note (stable names; later changes are logged in ``stock/docs/fork/progress/F2-G.md``):

- Port of the Kompas (Dart) ``importer.dart`` in snake_case. Importers are pure: they get an
  :class:`ImportFile` (file name + raw bytes) and return an :class:`ImportParseResult`; no database,
  no file system, no network. Row problems become :class:`ImportWarning` values, never exceptions
  (``blocking=True`` prevents committing the import).
- :class:`BrokerImporter` is a ``Protocol``: ``broker_id`` (stable id, also the alias namespace of the
  broker's symbols), ``display_name``, ``version`` (bump when parsing logic changes), ``can_parse(file)``
  (cheap sniff) and ``parse(file)``. Register implementations in an ``ImporterRegistry``.
- Sign conventions are those of ``domain.Transaction``: ``quantity`` and ``gross_amount`` are >= 0, the
  direction comes from ``type``; ``cash_amount`` is the signed net cash effect in ``cash_currency``;
  ``fx_rate`` is units of ``cash_currency`` per 1 unit of ``currency`` when they differ.
- ``row_index`` (records) and ``ImportWarning.row`` are the 0-based index of the data row in the file
  (after the header); file-level warnings have ``row=None``.
- ``trade_time`` is only a same-day sort key (the stored trade date stays a calendar date); see
  ``ordering.chronological_ranks``.
- Renames and delistings are not transactions: they travel as :class:`ParsedCorporateAction`
  (:class:`ParsedRename`, :class:`ParsedDelisting`); splits stay ``TxnType.SPLIT`` transactions.
- Every type is a frozen dataclass with keyword-only fields (except :class:`ImportFile`); sequences are
  tuples (lists passed in are converted), ``raw_row`` is a plain dict (read-only by convention).
- Helpers importers may reuse: ``importing.text`` (UTF-8 with BOM / windows-1250 / auto decoding),
  ``importing.csv_values`` (locale decimals, date patterns), ``importing.exchanges`` (exchange hints).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import time
from decimal import Decimal
from enum import StrEnum
from pathlib import PurePath
from typing import Protocol, runtime_checkable

from ..domain import CalendarDate, Currency, TxnType


@dataclass(frozen=True, slots=True)
class ImportFile:
    """A broker export picked by the user: original file name plus raw bytes."""

    name: str
    """Original file name, e.g. ``xtb_2026.csv``."""
    content: bytes

    @property
    def extension(self) -> str:
        """Lower-case extension without the dot (``csv``, ``xlsx``), or an empty string."""
        suffix = PurePath(self.name).suffix
        return suffix[1:].lower() if suffix else ""


@runtime_checkable
class BrokerImporter(Protocol):
    """A parser for one broker's export format. Pure: no DB, no file system, no network."""

    @property
    def broker_id(self) -> str:
        """Stable broker id (``xtb``, ``generic_csv``), also the alias namespace of broker symbols."""
        ...

    @property
    def display_name(self) -> str:
        """Name shown in the UI."""
        ...

    @property
    def version(self) -> int:
        """Version of the parsing logic (stored on the import batch); bump when parsing changes."""
        ...

    def can_parse(self, file: ImportFile) -> bool:
        """Cheap sniff (extension, header row) whether this importer understands ``file``.

        Must not raise for foreign files (the registry treats an exception as "no").
        """
        ...

    def parse(self, file: ImportFile) -> ImportParseResult:
        """Normalized rows plus warnings. Problems with single rows become warnings, never exceptions."""
        ...


@dataclass(frozen=True, slots=True, kw_only=True)
class ParsedTxn:
    """One normalized transaction row of an export, before instrument resolution and dedup."""

    row_index: int
    """0-based index of the data row in the file (after the header): messages and dedup order."""
    trade_date: CalendarDate
    type: TxnType
    currency: Currency
    """Currency of ``price``, ``gross_amount``, ``fee`` and ``tax``."""
    gross_amount: Decimal
    """Absolute value before fees and taxes (quantity * price for trades), >= 0."""
    cash_amount: Decimal
    """Signed net effect on cash in ``cash_currency`` (a buy is negative)."""
    cash_currency: Currency
    external_ref: str | None = None
    """The broker's own id of the row or order, if the export has one."""
    trade_time: time | None = None
    """Time of day when the export has one; only a sort key for rows of the same ``trade_date``."""
    settle_date: CalendarDate | None = None
    symbol: str | None = None
    """Instrument hints for the resolver (any may be None; cash rows have none)."""
    isin: str | None = None
    name: str | None = None
    exchange_hint: str | None = None
    """Exchange as written in the export (``GPW``, ``XWAR``, ``.PL`` suffix), read by ``exchanges``."""
    quantity: Decimal | None = None
    price: Decimal | None = None
    fee: Decimal = Decimal(0)
    tax: Decimal = Decimal(0)
    fx_rate: Decimal | None = None
    """Units of ``cash_currency`` per 1 unit of ``currency`` when they differ."""
    split_ratio: Decimal | None = None
    """For ``SPLIT``: new units per old unit (a 1:4 split is 4)."""
    note: str | None = None
    raw_row: dict[str, str] = field(default_factory=dict, compare=True, hash=False)
    """The source row as column header -> raw cell text (previews, debugging)."""

    def instrument_named(self) -> bool:
        """True when the row names an instrument (a non-blank symbol, ISIN or name)."""
        return any(
            value is not None and value.strip() for value in (self.symbol, self.isin, self.name)
        )


@dataclass(frozen=True, slots=True, kw_only=True)
class ParsedPosition:
    """One line of a broker position export (reconciliation input)."""

    quantity: Decimal
    currency: Currency
    as_of: CalendarDate
    symbol: str | None = None
    isin: str | None = None
    name: str | None = None
    exchange_hint: str | None = None
    avg_price: Decimal | None = None
    market_value: Decimal | None = None


@dataclass(frozen=True, slots=True, kw_only=True)
class ParsedCorporateAction:
    """Base of corporate actions that are not cash or quantity movements by themselves.

    Instruments are named the same way as in :class:`ParsedTxn` (symbol / ISIN / exchange hint). The
    import service applies them (rename: alias the old symbol to the successor and carry its lots;
    delisting: mark the instrument delisted or frozen). Match on the subclasses.
    """

    date: CalendarDate
    """Effective date of the action."""
    row_index: int | None = None
    note: str | None = None


@dataclass(frozen=True, slots=True, kw_only=True)
class ParsedRename(ParsedCorporateAction):
    """The instrument known as ``old_symbol`` continues as ``new_symbol`` (ticker change, merger into a
    successor). Lots carry over; this is not a sell plus a buy."""

    old_symbol: str
    new_symbol: str
    old_isin: str | None = None
    new_isin: str | None = None
    exchange_hint: str | None = None
    """Exchange of the old listing (MIC or broker hint)."""
    new_exchange_hint: str | None = None
    """Exchange of the new listing when it differs."""
    new_name: str | None = None


@dataclass(frozen=True, slots=True, kw_only=True)
class ParsedDelisting(ParsedCorporateAction):
    """The instrument stopped trading. ``frozen`` marks a holding that cannot be sold or priced (e.g. a
    sanctioned ADR), as opposed to an ordinary delisting with a final cash-out."""

    symbol: str
    isin: str | None = None
    exchange_hint: str | None = None
    frozen: bool = False


class ImportWarningKind(StrEnum):
    """Stable kinds of :class:`ImportWarning` (values are the wire names)."""

    FILE_FORMAT = "file_format"
    """Undecodable text, broken CSV / JSON, missing header, wrong format or version."""
    MISSING_COLUMN = "missing_column"
    """A mapped or required column is missing from the header."""
    UNKNOWN_FIELD = "unknown_field"
    """An unknown column, key or field (canonical format), or a field not allowed for the record."""
    MISSING_VALUE = "missing_value"
    """A required value is empty."""
    INVALID_VALUE = "invalid_value"
    """A value that cannot be read: number, date, time, currency, ISIN, boolean, text length."""
    UNMAPPED_TYPE = "unmapped_type"
    """A broker type string with no transaction type (add it to the mapping)."""
    IGNORED_ROW = "ignored_row"
    """A row skipped on purpose (type mapped to ignore, row without date and type, skip policy)."""
    FX_MISSING = "fx_missing"
    """A cross-currency amount cannot be derived without ``fx_rate`` (R5)."""
    AMOUNT = "amount"
    """Amounts missing or inconsistent (no amount at all, fee and tax exceed the cash amount)."""
    AMOUNT_MISMATCH = "amount_mismatch"
    """A given cash amount disagrees with gross, fee and tax."""
    CASH_SIGN = "cash_sign"
    """The sign of ``cash_amount`` contradicts the transaction type."""
    MISSING_INSTRUMENT = "missing_instrument"
    """A row that needs an instrument names none (or names one it must not)."""
    MISSING_QUANTITY = "missing_quantity"
    """A row that needs a quantity has none (or has one it must not)."""
    UNKNOWN_SPLIT_RATIO = "unknown_split_ratio"
    """A split without a positive split ratio."""
    NEGATIVE_AMOUNT = "negative_amount"
    """A negative quantity or gross amount."""
    INCONSISTENT_FILE = "inconsistent_file"
    """File-level values (source, account hint) differ between rows."""
    POSITION_SNAPSHOT = "position_snapshot"
    """Position records with several dates or repeated instruments."""
    INSTRUMENT_NOTE = "instrument_note"
    """Resolver notes: conflicting ISIN / broker symbol, ambiguous symbol, currency disagreement."""
    UNKNOWN_INSTRUMENT = "unknown_instrument"
    """A corporate action names an instrument that is not known."""
    HISTORY_GAP_HINT = "history_gap_hint"
    """The file suggests missing history (e.g. a sale before any purchase); for importers."""
    IMPORTER_ERROR = "importer_error"
    """The importer failed or did not recognize the file."""
    OTHER = "other"


@dataclass(frozen=True, slots=True, kw_only=True)
class ImportWarning:
    """A parse problem. ``blocking`` warnings prevent committing the import."""

    message: str
    row: int | None = None
    """0-based data row the warning refers to (``ParsedTxn.row_index``), None for file-level problems."""
    blocking: bool = False
    kind: str = "other"
    """Stable machine-readable category for grouping in UIs and reports (an
    :class:`ImportWarningKind` value; importers may use their own snake_case kinds)."""

    @property
    def code(self) -> str:
        """Stable machine-readable code for a translated label: ``import.<kind>``."""
        return f"import.{self.kind or 'other'}"

    def __str__(self) -> str:
        prefix = "" if self.row is None else f"row {self.row}: "
        return f"{prefix}{self.message}{' (blocking)' if self.blocking else ''}"


@dataclass(frozen=True, slots=True, kw_only=True)
class ImportParseResult:
    """Everything an importer extracted from one file."""

    txns: tuple[ParsedTxn, ...] = ()
    positions: tuple[ParsedPosition, ...] = ()
    warnings: tuple[ImportWarning, ...] = ()
    corporate_actions: tuple[ParsedCorporateAction, ...] = ()
    """Renames and delistings detected in the file (applied by the import service)."""
    account_hint: str | None = None
    """Account number / name found in the file, to suggest the target account."""
    source: str | None = None
    """Broker the data came from when the file says so (canonical format ``source``). When set, the
    import uses it instead of the importer's ``broker_id`` as the alias namespace of the file's symbols
    and as the batch's broker label (see :func:`effective_broker_id`)."""

    def __post_init__(self) -> None:
        for name in ("txns", "positions", "warnings", "corporate_actions"):
            value = getattr(self, name)
            if not isinstance(value, tuple):
                object.__setattr__(self, name, tuple(value))

    @property
    def has_blocking_warnings(self) -> bool:
        return any(warning.blocking for warning in self.warnings)


CASHU_NAMESPACE = "cashu"
"""Alias namespace of the canonical format (``canonical.CANONICAL_BROKER_ID``)."""
LEGACY_NAMESPACE = "finanse"  # legacy name
"""The same namespace before the rename; aliases stored under it still resolve."""


def namespace_of(broker_id: str) -> str:
    """``broker_id`` with the pre-rename canonical namespace read as the current one."""
    return CASHU_NAMESPACE if broker_id == LEGACY_NAMESPACE else broker_id


def equivalent_namespaces(namespace: str) -> tuple[str, ...]:
    """Namespaces that name the same aliases: ``cashu`` and its legacy name ``finanse``."""
    if namespace in (CASHU_NAMESPACE, LEGACY_NAMESPACE):
        return (CASHU_NAMESPACE, LEGACY_NAMESPACE)
    return (namespace,)


def effective_broker_id(importer: BrokerImporter, result: ImportParseResult) -> str:
    """Alias namespace / broker label of an import: the file's ``source`` when set, else the importer's
    ``broker_id`` (legacy name: ``source: finanse`` reads as ``cashu``)."""
    return namespace_of(result.source or importer.broker_id)


__all__ = [
    "BrokerImporter",
    "ImportFile",
    "ImportParseResult",
    "ImportWarning",
    "ImportWarningKind",
    "ParsedCorporateAction",
    "ParsedDelisting",
    "ParsedPosition",
    "ParsedRename",
    "ParsedTxn",
    "effective_broker_id",
    "equivalent_namespaces",
    "namespace_of",
]
