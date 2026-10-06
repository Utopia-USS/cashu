"""Native importer of the canonical ``cashu-import`` format (format_version 1), CSV and JSON variants.

The specification for converter authors is ``docs/import-format.md`` in the repository root. Both variants
produce the same records (``txn``, ``position``, ``rename``, ``delisting``) and share one strict record
validator: every problem is a blocking warning with its row and field, a row with any error is not
emitted, suspicious but importable rows get non-blocking warnings.
"""

from __future__ import annotations

import csv
import io
import json
import re
from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import date, time
from decimal import Decimal, InvalidOperation
from enum import StrEnum

from ..domain import Currency, TxnType, exact_decimals
from .cash import (
    CASH_INFLOW_TYPES,
    CASH_NEUTRAL_TYPES,
    CASH_OUTFLOW_TYPES,
    AmountError,
    cash_from_gross,
    derive_amounts,
)
from .contract import (
    ImportFile,
    ImportParseResult,
    ImportWarning,
    ImportWarningKind,
    ParsedCorporateAction,
    ParsedDelisting,
    ParsedPosition,
    ParsedRename,
    ParsedTxn,
)
from .csv_mapping import did_you_mean
from .text import ImportTextEncoding, decode_import_text

CANONICAL_BROKER_ID = "cashu"
"""Broker id of the canonical importer (alias namespace when a file sets no ``source``)."""
CANONICAL_FORMAT = "cashu-import"
CANONICAL_FORMAT_VERSION = 1
# legacy name: the ids before the rename, still accepted (deprecated) and read as the new ones
LEGACY_BROKER_ID = "finanse"
LEGACY_FORMAT = "finanse-import"


def canonical_importer_id(value: str | None) -> str | None:
    """An importer id as stored or sent, with the pre-rename ``finanse`` (legacy name) read as
    ``cashu``."""
    return CANONICAL_BROKER_ID if value == LEGACY_BROKER_ID else value

CSV_EXTENSIONS: tuple[str, ...] = ("csv", "txt")
JSON_EXTENSIONS: tuple[str, ...] = ("json",)
SNIFF_BYTES = 64 * 1024

CONSISTENCY_TOLERANCE = Decimal("0.01")
"""Allowed difference between a given cash amount and the one implied by gross, fee and tax."""

MAX_SYMBOL = 64
MAX_NAME = 200
MAX_REF = 200
MAX_NOTE = 1000
MAX_ACCOUNT_HINT = 200
MAX_SOURCE = 32


class RecordKind(StrEnum):
    """Kind of a canonical record (the ``record`` field)."""

    TXN = "txn"
    POSITION = "position"
    RENAME = "rename"
    DELISTING = "delisting"


_TXN = frozenset({RecordKind.TXN})
_POS = frozenset({RecordKind.POSITION})
_ANY = frozenset(RecordKind)
_INSTRUMENT_KINDS = frozenset({RecordKind.TXN, RecordKind.POSITION})

RECORD_FIELDS: dict[str, frozenset[RecordKind]] = {
    "record": _ANY,
    "date": _ANY,
    "time": _TXN,
    "settle_date": _TXN,
    "type": _TXN,
    "external_ref": _TXN,
    "symbol": _ANY,
    "isin": _ANY,
    "name": _INSTRUMENT_KINDS,
    "exchange": _ANY,
    "quantity": _INSTRUMENT_KINDS,
    "price": _TXN,
    "currency": _INSTRUMENT_KINDS,
    "gross_amount": _TXN,
    "fee": _TXN,
    "tax": _TXN,
    "cash_amount": _TXN,
    "cash_currency": _TXN,
    "fx_rate": _TXN,
    "split_ratio": _TXN,
    "avg_price": _POS,
    "market_value": _POS,
    "new_symbol": frozenset({RecordKind.RENAME}),
    "new_isin": frozenset({RecordKind.RENAME}),
    "new_exchange": frozenset({RecordKind.RENAME}),
    "new_name": frozenset({RecordKind.RENAME}),
    "frozen": frozenset({RecordKind.DELISTING}),
    "note": _ANY,
}
"""Record field -> record kinds that accept it."""

FILE_FIELDS: tuple[str, ...] = ("format_version", "source", "account_hint")
CSV_COLUMNS: tuple[str, ...] = ("format_version", *RECORD_FIELDS, "source", "account_hint")
"""Every CSV column, in the recommended order."""
REQUIRED_CSV_COLUMNS: tuple[str, ...] = ("format_version", "record", "date")
JSON_TOP_LEVEL_KEYS: tuple[str, ...] = (
    "format",
    "format_version",
    "source",
    "account_hint",
    "records",
)

INSTRUMENT_REQUIRED: frozenset[TxnType] = frozenset(
    {
        TxnType.BUY,
        TxnType.SELL,
        TxnType.SPLIT,
        TxnType.TRANSFER_IN,
        TxnType.TRANSFER_OUT,
        TxnType.ADJUSTMENT,
    }
)
INSTRUMENT_FORBIDDEN: frozenset[TxnType] = frozenset(
    {TxnType.DEPOSIT, TxnType.WITHDRAWAL, TxnType.FX_CONVERSION}
)
QUANTITY_REQUIRED: frozenset[TxnType] = frozenset(
    {TxnType.BUY, TxnType.SELL, TxnType.TRANSFER_IN, TxnType.TRANSFER_OUT, TxnType.ADJUSTMENT}
)
QUANTITY_FORBIDDEN: frozenset[TxnType] = frozenset(
    {
        TxnType.INTEREST,
        TxnType.DEPOSIT,
        TxnType.WITHDRAWAL,
        TxnType.FEE,
        TxnType.TAX,
        TxnType.FX_CONVERSION,
    }
)
_CASH_NOT_POSITIVE_ERROR = frozenset({TxnType.BUY, TxnType.WITHDRAWAL})
_CASH_NOT_NEGATIVE_ERROR = frozenset({TxnType.SELL, TxnType.DEPOSIT})
_CASH_NOT_POSITIVE_WARNING = frozenset({TxnType.FEE, TxnType.TAX})
_CASH_NOT_NEGATIVE_WARNING = frozenset({TxnType.DIVIDEND, TxnType.INTEREST})

_DATE = re.compile(r"^([0-9]{4})-([0-9]{2})-([0-9]{2})$")
_TIME = re.compile(r"^([0-9]{2}):([0-9]{2})(?::([0-9]{2}))?$")
_NUMBER = re.compile(r"^-?[0-9]+(\.[0-9]+)?$")
_CURRENCY = re.compile(r"^[A-Z]{3}$")
_ISIN = re.compile(r"^[A-Z]{2}[A-Z0-9]{9}[0-9]$")
_SOURCE = re.compile(r"^[a-z][a-z0-9_]*$")

type Value = str | Decimal | bool | None
"""A raw field value: CSV cells are text, JSON values keep their JSON type (numbers as Decimal)."""


# --- importer ------------------------------------------------------------------------------------


class CanonicalImporter:
    """:class:`~.contract.BrokerImporter` of the ``cashu-import`` format (CSV and JSON)."""

    PARSER_VERSION = 1

    @property
    def broker_id(self) -> str:
        return CANONICAL_BROKER_ID

    @property
    def display_name(self) -> str:
        return "cashU import format"

    @property
    def version(self) -> int:
        return self.PARSER_VERSION

    def can_parse(self, file: ImportFile) -> bool:
        """CSV: the header has ``format_version`` and ``record`` columns. JSON: an object naming the
        ``cashu-import`` format near its start."""
        head = file.content[:SNIFF_BYTES]
        try:
            text = decode_import_text(head, ImportTextEncoding.UTF8, lenient=True)
        except ValueError:
            return False
        if file.extension in JSON_EXTENSIONS:
            stripped = text.lstrip()
            return stripped.startswith("{") and any(
                f'"{f}"' in stripped[:4096] for f in (CANONICAL_FORMAT, LEGACY_FORMAT)
            )
        if file.extension in CSV_EXTENSIONS:
            first_line = text.splitlines()[0] if text else ""
            try:
                header = next(csv.reader([first_line]), [])
            except csv.Error:
                return False
            names = {_header_name(cell) for cell in header}
            return "format_version" in names and "record" in names
        return False

    def parse(self, file: ImportFile) -> ImportParseResult:
        if file.extension in JSON_EXTENSIONS:
            return parse_canonical_json(file.content)
        return parse_canonical_csv(file.content)


# --- CSV -----------------------------------------------------------------------------------------


def parse_canonical_csv(content: bytes) -> ImportParseResult:
    """Parse a canonical CSV file (see ``docs/import-format.md``)."""
    try:
        text = decode_import_text(content, ImportTextEncoding.UTF8)
    except UnicodeDecodeError as error:
        return _file_error(f"File is not valid UTF-8 ({error.reason} at byte {error.start})")
    reader = csv.reader(io.StringIO(text, newline=""), delimiter=",", quotechar='"', strict=True)
    try:
        records = [list(record) for record in reader]
    except csv.Error as error:
        return _file_error(f"File is not valid CSV (line {reader.line_num}: {error})")
    if not records or all(not cell.strip() for cell in records[0]):
        return _file_error("File is empty (expected a header line)")

    header = [_header_name(cell) for cell in records[0]]
    problems: list[ImportWarning] = []
    seen: set[str] = set()
    for name in header:
        if name not in CSV_COLUMNS:
            problems.append(
                _blocking(
                    None,
                    f'Unknown column "{name}"{did_you_mean(name, CSV_COLUMNS)}',
                    ImportWarningKind.UNKNOWN_FIELD,
                )
            )
        elif name in seen:
            problems.append(
                _blocking(None, f'Duplicate column "{name}"', ImportWarningKind.FILE_FORMAT)
            )
        seen.add(name)
    for required in REQUIRED_CSV_COLUMNS:
        if required not in seen:
            problems.append(
                _blocking(
                    None, f'Missing required column "{required}"', ImportWarningKind.MISSING_COLUMN
                )
            )
    if problems:
        return ImportParseResult(warnings=problems)

    builder = _ResultBuilder()
    for r, cells in enumerate(records[1:]):
        if all(not cell.strip() for cell in cells):
            continue
        if len(cells) != len(header):
            builder.error(
                r,
                f"Row has {len(cells)} cells but the header has {len(header)}",
                ImportWarningKind.FILE_FORMAT,
            )
            continue
        values: dict[str, Value] = {}
        version: str | None = None
        for name, cell in zip(header, cells, strict=True):
            value = cell.strip() or None
            if name == "format_version":
                version = value
            elif name == "source":
                builder.file_value(r, "source", value)
            elif name == "account_hint":
                builder.file_value(r, "account_hint", value)
            else:
                values[name] = value
        if version != str(CANONICAL_FORMAT_VERSION):
            got = "empty" if version is None else f'"{version}"'
            builder.error(
                r,
                f"format_version: must be {CANONICAL_FORMAT_VERSION} (got {got})",
                ImportWarningKind.FILE_FORMAT,
            )
            continue
        builder.record(r, values, raw={h: c for h, c in zip(header, cells, strict=True)})
    return builder.result()


# --- JSON ----------------------------------------------------------------------------------------


class _DuplicateKey(ValueError):
    pass


def _object_hook(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise _DuplicateKey(f'duplicate key "{key}"')
        result[key] = value
    return result


def _reject_constant(name: str) -> object:
    raise ValueError(f"{name} is not a valid number")


def parse_canonical_json(content: bytes) -> ImportParseResult:
    """Parse a canonical JSON file (see ``docs/import-format.md``)."""
    try:
        text = decode_import_text(content, ImportTextEncoding.UTF8)
    except UnicodeDecodeError as error:
        return _file_error(f"File is not valid UTF-8 ({error.reason} at byte {error.start})")
    try:
        document = json.loads(
            text,
            parse_float=Decimal,
            parse_int=Decimal,
            parse_constant=_reject_constant,
            object_pairs_hook=_object_hook,
        )
    except json.JSONDecodeError as error:
        return _file_error(
            f"File is not valid JSON (line {error.lineno}, column {error.colno}: {error.msg})"
        )
    except (_DuplicateKey, ValueError, RecursionError) as error:
        return _file_error(f"File is not valid JSON ({error})")
    if not isinstance(document, dict):
        return _file_error("The JSON document must be an object")

    problems: list[ImportWarning] = []
    for key in document:
        if key not in JSON_TOP_LEVEL_KEYS:
            problems.append(
                _blocking(
                    None,
                    f'Unknown key "{key}"{did_you_mean(key, JSON_TOP_LEVEL_KEYS)}',
                    ImportWarningKind.UNKNOWN_FIELD,
                )
            )
    if document.get("format") not in (CANONICAL_FORMAT, LEGACY_FORMAT):  # legacy name accepted
        problems.append(
            _blocking(None, f'format: must be "{CANONICAL_FORMAT}"', ImportWarningKind.FILE_FORMAT)
        )
    version = document.get("format_version")
    if isinstance(version, bool) or version != CANONICAL_FORMAT_VERSION:
        problems.append(
            _blocking(
                None,
                f"format_version: must be the number {CANONICAL_FORMAT_VERSION}",
                ImportWarningKind.FILE_FORMAT,
            )
        )
    records = document.get("records")
    if not isinstance(records, list):
        problems.append(
            _blocking(
                None, "records: must be an array of record objects", ImportWarningKind.FILE_FORMAT
            )
        )
    builder = _ResultBuilder()
    for key in ("source", "account_hint"):
        value = document.get(key)
        if value is not None and not isinstance(value, str):
            problems.append(_blocking(None, f"{key}: must be a string"))
        elif value is not None:
            builder.file_value(None, key, value.strip() or None)
    if problems:
        return ImportParseResult(warnings=problems)

    assert isinstance(records, list)
    for r, record in enumerate(records):
        if not isinstance(record, dict):
            builder.error(r, "Record must be a JSON object", ImportWarningKind.FILE_FORMAT)
            continue
        values: dict[str, Value] = {}
        bad = False
        for key, value in record.items():
            if key in FILE_FIELDS:
                builder.error(
                    r,
                    f"{key}: belongs at the top level of the document",
                    ImportWarningKind.UNKNOWN_FIELD,
                )
                bad = True
                continue
            if isinstance(value, (dict, list)):
                builder.error(r, f"{key}: must be a single value")
                bad = True
                continue
            if isinstance(value, str):
                values[key] = value.strip() or None
            else:
                values[key] = value  # type: ignore[assignment]  # Decimal, bool or None
        if bad:
            continue
        builder.record(r, values, raw={k: _raw_text(v) for k, v in values.items()})
    return builder.result()


# --- shared record validation ---------------------------------------------------------------------


@dataclass
class _ResultBuilder:
    txns: list[ParsedTxn] = field(default_factory=list)
    positions: list[ParsedPosition] = field(default_factory=list)
    actions: list[ParsedCorporateAction] = field(default_factory=list)
    warnings: list[ImportWarning] = field(default_factory=list)
    file_values: dict[str, str] = field(default_factory=dict)

    def error(
        self, row: int | None, message: str, kind: str = ImportWarningKind.INVALID_VALUE
    ) -> None:
        self.warnings.append(_blocking(row, message, kind))

    def file_value(self, row: int | None, key: str, value: str | None) -> None:
        if value is None:
            return
        if key == "source" and (len(value) > MAX_SOURCE or not _SOURCE.match(value)):
            self.error(
                row, f'source: "{value}" must be lower-case letters, digits and "_" (max 32)'
            )
            return
        if key == "account_hint" and len(value) > MAX_ACCOUNT_HINT:
            self.error(row, f"account_hint: longer than {MAX_ACCOUNT_HINT} characters")
            return
        known = self.file_values.get(key)
        if known is None:
            self.file_values[key] = value
        elif known != value:
            self.error(
                row,
                f'{key}: "{value}" differs from "{known}" (one file = one account)',
                ImportWarningKind.INCONSISTENT_FILE,
            )

    def record(self, row: int, values: Mapping[str, Value], raw: dict[str, str]) -> None:
        reader = _RecordReader(row, values)
        parsed = reader.read(raw)
        self.warnings.extend(reader.issues)
        match parsed:
            case ParsedTxn():
                self.txns.append(parsed)
            case ParsedPosition():
                self.positions.append(parsed)
            case ParsedCorporateAction():
                self.actions.append(parsed)
            case None:
                pass

    def result(self) -> ImportParseResult:
        dates = {position.as_of for position in self.positions}
        if len(dates) > 1:
            self.warnings.append(
                ImportWarning(
                    kind=ImportWarningKind.POSITION_SNAPSHOT,
                    message=f"Position records have {len(dates)} different dates "
                    f"({', '.join(str(d) for d in sorted(dates))}); a snapshot should share one date",
                )
            )
        keys: dict[tuple[date, str], int] = {}
        for position in self.positions:
            key = (position.as_of, (position.isin or position.symbol or position.name or ""))
            keys[key] = keys.get(key, 0) + 1
        for (as_of, label), count in keys.items():
            if count > 1:
                self.warnings.append(
                    ImportWarning(
                        kind=ImportWarningKind.POSITION_SNAPSHOT,
                        message=f"{count} position records for {label} on {as_of}; "
                        "they are added up",
                    )
                )
        return ImportParseResult(
            txns=self.txns,
            positions=self.positions,
            corporate_actions=self.actions,
            warnings=self.warnings,
            account_hint=self.file_values.get("account_hint"),
            source=self.file_values.get("source"),
        )


class _RecordReader:
    """Reads one record's fields with strict checks, collecting every problem (never raises)."""

    def __init__(self, row: int, values: Mapping[str, Value]) -> None:
        self.row = row
        self.values = values
        self.issues: list[ImportWarning] = []
        self._errors = 0

    # --- issue helpers ---

    def _error(self, name: str, message: str, kind: str | None = None) -> None:
        self._errors += 1
        if kind is None:
            missing = message.startswith("is required")
            kind = ImportWarningKind.MISSING_VALUE if missing else ImportWarningKind.INVALID_VALUE
        self.issues.append(_blocking(self.row, f"{name}: {message}", kind))

    def _warn(self, name: str, message: str, kind: str) -> None:
        self.issues.append(ImportWarning(message=f"{name}: {message}", row=self.row, kind=kind))

    # --- typed field access (None when empty or invalid; invalid values record an error) ---

    def _raw(self, name: str) -> Value:
        return self.values.get(name)

    def text(self, name: str, max_length: int = MAX_NAME) -> str | None:
        value = self._raw(name)
        if value is None:
            return None
        if not isinstance(value, str):
            self._error(name, "must be text (in JSON a quoted string)")
            return None
        if len(value) > max_length:
            self._error(name, f"longer than {max_length} characters")
            return None
        return value

    def required_text(self, name: str, max_length: int = MAX_NAME) -> str | None:
        if self._raw(name) is None:
            self._error(name, "is required")
            return None
        return self.text(name, max_length)

    def date(self, name: str, *, required: bool = False) -> date | None:
        text = self.text(name)
        if text is None:
            if required and self._raw(name) is None:
                self._error(name, "is required (YYYY-MM-DD)")
            return None
        match = _DATE.match(text)
        if match is None:
            self._error(name, f'"{text}" is not a date in YYYY-MM-DD format')
            return None
        try:
            return date(int(match.group(1)), int(match.group(2)), int(match.group(3)))
        except ValueError:
            self._error(name, f'"{text}" is not a real calendar date')
            return None

    def time(self, name: str) -> time | None:
        text = self.text(name)
        if text is None:
            return None
        match = _TIME.match(text)
        if match is None:
            self._error(name, f'"{text}" is not a time in HH:MM or HH:MM:SS format')
            return None
        hour, minute = int(match.group(1)), int(match.group(2))
        second = int(match.group(3) or 0)
        if hour > 23 or minute > 59 or second > 59:
            self._error(name, f'"{text}" is not a valid time of day')
            return None
        return time(hour, minute, second)

    def decimal(
        self,
        name: str,
        *,
        minimum: Decimal | None = None,
        positive: bool = False,
        required: bool = False,
    ) -> Decimal | None:
        value = self._raw(name)
        if value is None:
            if required:
                self._error(name, "is required")
            return None
        number: Decimal | None
        if isinstance(value, bool):
            number = None
        elif isinstance(value, Decimal):
            number = value if value.is_finite() else None
        else:
            number = Decimal(value) if _NUMBER.match(value) else None
        if number is None:
            self._error(
                name,
                f'"{_raw_text(value)}" is not a decimal number (use "." as decimal separator, '
                "no thousands separators)",
            )
            return None
        if positive and number <= 0:
            self._error(name, "must be greater than 0")
            return None
        if minimum is not None and number < minimum:
            self._error(name, f"must not be negative (got {_raw_text(value)})")
            return None
        return number

    def currency(self, name: str, *, required: bool = False) -> Currency | None:
        text = self.text(name)
        if text is None:
            if required and self._raw(name) is None:
                self._error(name, "is required (ISO 4217 code, e.g. PLN)")
            return None
        if not _CURRENCY.match(text):
            self._error(name, f'"{text}" is not an upper-case ISO 4217 code (e.g. PLN, USD)')
            return None
        return Currency(text)

    def isin(self, name: str) -> str | None:
        text = self.text(name, max_length=12)
        if text is None:
            return None
        if not _ISIN.match(text):
            self._error(
                name, f'"{text}" is not an ISIN (12 upper-case characters, e.g. IE00B4L5Y983)'
            )
            return None
        return text

    def boolean(self, name: str) -> bool:
        value = self._raw(name)
        if value is None:
            return False
        if isinstance(value, bool):
            return value
        if isinstance(value, str) and value.lower() in ("true", "false"):
            return value.lower() == "true"
        self._error(name, f'"{_raw_text(value)}" is not true or false')
        return False

    # --- records ---

    def read(
        self, raw: dict[str, str]
    ) -> ParsedTxn | ParsedPosition | ParsedCorporateAction | None:
        for name in self.values:
            if name not in RECORD_FIELDS:
                self._error(
                    name,
                    f"unknown field{did_you_mean(name, RECORD_FIELDS)}",
                    ImportWarningKind.UNKNOWN_FIELD,
                )
        kind_text = self.text("record")
        if kind_text is None:
            if self._raw("record") is None:
                self._error("record", "is required (txn, position, rename or delisting)")
            return None
        try:
            kind = RecordKind(kind_text)
        except ValueError:
            names = [k.value for k in RecordKind]
            self._error(
                "record",
                f'"{kind_text}" is not a record kind (txn, position, rename, delisting)'
                f"{did_you_mean(kind_text, names)}",
            )
            return None
        for name, value in self.values.items():
            allowed = RECORD_FIELDS.get(name)
            if allowed is not None and value is not None and kind not in allowed:
                self._error(
                    name, f"not allowed in a {kind.value} record", ImportWarningKind.UNKNOWN_FIELD
                )
        parsed: ParsedTxn | ParsedPosition | ParsedCorporateAction | None
        match kind:
            case RecordKind.TXN:
                parsed = self._txn(raw)
            case RecordKind.POSITION:
                parsed = self._position()
            case RecordKind.RENAME:
                parsed = self._rename()
            case RecordKind.DELISTING:
                parsed = self._delisting()
        return None if self._errors else parsed

    def _txn(self, raw: dict[str, str]) -> ParsedTxn | None:
        trade_date = self.date("date", required=True)
        trade_time = self.time("time")
        settle_date = self.date("settle_date")
        type_text = self.text("type")
        txn_type: TxnType | None = None
        if type_text is None:
            if self._raw("type") is None:
                self._error("type", "is required")
        else:
            try:
                txn_type = TxnType(type_text)
            except ValueError:
                names = [t.value for t in TxnType]
                self._error(
                    "type",
                    f'"{type_text}" is not a transaction type{did_you_mean(type_text, names)}',
                    ImportWarningKind.UNMAPPED_TYPE,
                )
        external_ref = self.text("external_ref", MAX_REF)
        symbol = self.text("symbol", MAX_SYMBOL)
        isin = self.isin("isin")
        name = self.text("name")
        exchange = self.text("exchange", MAX_SYMBOL)
        zero = Decimal(0)
        quantity = self.decimal("quantity", minimum=zero)
        price = self.decimal("price", minimum=zero)
        currency = self.currency("currency", required=True)
        gross = self.decimal("gross_amount", minimum=zero)
        fee = self.decimal("fee", minimum=zero) or zero
        tax = self.decimal("tax", minimum=zero) or zero
        cash = self.decimal("cash_amount")
        cash_currency = self.currency("cash_currency")
        fx_rate = self.decimal("fx_rate", positive=True)
        split_ratio = self.decimal("split_ratio", positive=True)
        note = self.text("note", MAX_NOTE)
        if txn_type is None or trade_date is None or currency is None:
            return None

        # Raw presence, so an invalid ISIN reports one problem, not also "needs an instrument".
        has_instrument = any(self._raw(f) is not None for f in ("symbol", "isin", "name"))
        if txn_type in INSTRUMENT_REQUIRED and not has_instrument:
            self._error(
                "symbol",
                f"{txn_type.value} needs an instrument (symbol, isin or name)",
                ImportWarningKind.MISSING_INSTRUMENT,
            )
        if txn_type in INSTRUMENT_FORBIDDEN:
            for instrument_field in ("symbol", "isin", "name", "exchange"):
                if self._raw(instrument_field) is not None:
                    self._error(
                        instrument_field,
                        f"must be empty for {txn_type.value}",
                        ImportWarningKind.MISSING_INSTRUMENT,
                    )
        if txn_type in QUANTITY_REQUIRED:
            if self._raw("quantity") is None:
                self._error(
                    "quantity",
                    f"is required for {txn_type.value}",
                    ImportWarningKind.MISSING_QUANTITY,
                )
            elif quantity is not None and quantity == 0:
                self._error(
                    "quantity", "must be greater than 0", ImportWarningKind.MISSING_QUANTITY
                )
        elif txn_type in QUANTITY_FORBIDDEN and self._raw("quantity") is not None:
            self._error(
                "quantity",
                f"must be empty for {txn_type.value}",
                ImportWarningKind.MISSING_QUANTITY,
            )
        if txn_type == TxnType.SPLIT:
            if self._raw("split_ratio") is None:
                self._error(
                    "split_ratio", "is required for split", ImportWarningKind.UNKNOWN_SPLIT_RATIO
                )
        elif self._raw("split_ratio") is not None:
            self._error("split_ratio", "only allowed for split")
        if txn_type == TxnType.FX_CONVERSION:
            if self._raw("cash_amount") is None:
                self._error(
                    "cash_amount", "is required for fx_conversion (signed amount of the leg)"
                )
            if cash_currency is not None and cash_currency != currency:
                self._error(
                    "cash_currency",
                    "each fx_conversion leg is booked in its own currency: leave it empty or equal "
                    "to currency",
                )
        self._check_cash_sign(txn_type, cash)
        if self._errors:
            return None

        settle_currency = cash_currency or currency
        try:
            amounts = derive_amounts(
                txn_type=txn_type,
                currency=currency,
                cash_currency=settle_currency,
                gross=gross,
                cash=cash,
                quantity=quantity,
                price=price,
                fee=fee,
                tax=tax,
                fx_rate=fx_rate,
            )
        except AmountError as error:
            self._error("cash_amount" if cash is None else "gross_amount", str(error), error.kind)
            return None
        if (
            gross is not None
            and cash is not None
            and settle_currency == currency
            and (txn_type in CASH_INFLOW_TYPES or txn_type in CASH_OUTFLOW_TYPES)
        ):
            with exact_decimals():
                expected = cash_from_gross(txn_type, gross, fee, tax)
                difference = abs(cash - expected)
            if difference > CONSISTENCY_TOLERANCE:
                self._warn(
                    "cash_amount",
                    f"{cash} does not match gross_amount {gross}, fee {fee} and tax {tax} "
                    f"(expected {expected}, difference {difference})",
                    ImportWarningKind.AMOUNT_MISMATCH,
                )
        if self._errors:
            return None
        return ParsedTxn(
            row_index=self.row,
            trade_date=trade_date,
            type=txn_type,
            currency=currency,
            gross_amount=amounts.gross_amount,
            cash_amount=amounts.cash_amount,
            cash_currency=settle_currency,
            external_ref=external_ref,
            trade_time=trade_time,
            settle_date=settle_date,
            symbol=symbol,
            isin=isin,
            name=name,
            exchange_hint=exchange,
            quantity=quantity,
            price=price,
            fee=fee,
            tax=tax,
            fx_rate=fx_rate,
            split_ratio=split_ratio,
            note=note,
            raw_row=raw,
        )

    def _check_cash_sign(self, txn_type: TxnType, cash: Decimal | None) -> None:
        """Sign rules of section 4 of the spec (given cash amounts only, never derived ones)."""
        if cash is None:
            return
        if cash > 0 and txn_type in _CASH_NOT_POSITIVE_ERROR:
            self._error(
                "cash_amount",
                f"{cash} must be <= 0 for {txn_type.value} (money leaves the account)",
                ImportWarningKind.CASH_SIGN,
            )
        elif cash < 0 and txn_type in _CASH_NOT_NEGATIVE_ERROR:
            self._error(
                "cash_amount",
                f"{cash} must be >= 0 for {txn_type.value} (money comes in)",
                ImportWarningKind.CASH_SIGN,
            )
        elif cash > 0 and txn_type in _CASH_NOT_POSITIVE_WARNING:
            self._warn(
                "cash_amount",
                f"{cash} is positive for {txn_type.value} (a refund?)",
                ImportWarningKind.CASH_SIGN,
            )
        elif cash < 0 and txn_type in _CASH_NOT_NEGATIVE_WARNING:
            self._warn(
                "cash_amount",
                f"{cash} is negative for {txn_type.value} (a correction?)",
                ImportWarningKind.CASH_SIGN,
            )
        elif cash != 0 and txn_type in CASH_NEUTRAL_TYPES:
            self._warn(
                "cash_amount",
                f"{txn_type.value} usually has no cash effect (got {cash})",
                ImportWarningKind.CASH_SIGN,
            )

    def _position(self) -> ParsedPosition | None:
        as_of = self.date("date", required=True)
        symbol = self.text("symbol", MAX_SYMBOL)
        isin = self.isin("isin")
        name = self.text("name")
        exchange = self.text("exchange", MAX_SYMBOL)
        quantity = self.decimal("quantity", minimum=Decimal(0), required=True)
        currency = self.currency("currency", required=True)
        avg_price = self.decimal("avg_price", minimum=Decimal(0))
        market_value = self.decimal("market_value", minimum=Decimal(0))
        self.text("note", MAX_NOTE)
        if all(self._raw(f) is None for f in ("symbol", "isin", "name")):
            self._error(
                "symbol",
                "a position needs an instrument (symbol, isin or name)",
                ImportWarningKind.MISSING_INSTRUMENT,
            )
        if as_of is None or quantity is None or currency is None:
            return None
        return ParsedPosition(
            quantity=quantity,
            currency=currency,
            as_of=as_of,
            symbol=symbol,
            isin=isin,
            name=name,
            exchange_hint=exchange,
            avg_price=avg_price,
            market_value=market_value,
        )

    def _rename(self) -> ParsedRename | None:
        effective = self.date("date", required=True)
        old_symbol = self.required_text("symbol", MAX_SYMBOL)
        old_isin = self.isin("isin")
        exchange = self.text("exchange", MAX_SYMBOL)
        new_symbol = self.required_text("new_symbol", MAX_SYMBOL)
        new_isin = self.isin("new_isin")
        new_exchange = self.text("new_exchange", MAX_SYMBOL)
        new_name = self.text("new_name")
        note = self.text("note", MAX_NOTE)
        if effective is None or old_symbol is None or new_symbol is None:
            return None
        if (
            old_symbol == new_symbol
            and (new_isin is None or new_isin == old_isin)
            and (new_exchange is None or new_exchange == exchange)
        ):
            self._error("new_symbol", "a rename must change the symbol, ISIN or exchange")
            return None
        return ParsedRename(
            date=effective,
            row_index=self.row,
            note=note,
            old_symbol=old_symbol,
            new_symbol=new_symbol,
            old_isin=old_isin,
            new_isin=new_isin,
            exchange_hint=exchange,
            new_exchange_hint=new_exchange,
            new_name=new_name,
        )

    def _delisting(self) -> ParsedDelisting | None:
        effective = self.date("date", required=True)
        symbol = self.required_text("symbol", MAX_SYMBOL)
        isin = self.isin("isin")
        exchange = self.text("exchange", MAX_SYMBOL)
        frozen = self.boolean("frozen")
        note = self.text("note", MAX_NOTE)
        if effective is None or symbol is None:
            return None
        return ParsedDelisting(
            date=effective,
            row_index=self.row,
            note=note,
            symbol=symbol,
            isin=isin,
            exchange_hint=exchange,
            frozen=frozen,
        )


# --- helpers -------------------------------------------------------------------------------------


def _blocking(
    row: int | None, message: str, kind: str = ImportWarningKind.INVALID_VALUE
) -> ImportWarning:
    return ImportWarning(message=message, row=row, blocking=True, kind=kind)


def _file_error(message: str) -> ImportParseResult:
    return ImportParseResult(warnings=[_blocking(None, message, ImportWarningKind.FILE_FORMAT)])


def _header_name(cell: str) -> str:
    return cell.replace("﻿", "").strip()


def _raw_text(value: Value) -> str:
    if value is None:
        return ""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, Decimal):
        try:
            return format(value, "f")
        except (ValueError, InvalidOperation):
            return str(value)
    return value


__all__ = [
    "CANONICAL_BROKER_ID",
    "CANONICAL_FORMAT",
    "CANONICAL_FORMAT_VERSION",
    "CSV_COLUMNS",
    "FILE_FIELDS",
    "JSON_TOP_LEVEL_KEYS",
    "LEGACY_BROKER_ID",
    "LEGACY_FORMAT",
    "RECORD_FIELDS",
    "REQUIRED_CSV_COLUMNS",
    "CanonicalImporter",
    "RecordKind",
    "canonical_importer_id",
    "parse_canonical_csv",
    "parse_canonical_json",
]
