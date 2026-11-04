"""Native parser of the ``cashu-budget-import`` format (format_version 1), JSON and CSV variants.

The specification for converter and connector authors is ``docs/budget-import-format.md`` in the
repository root; ``docs/schemas/cashu-budget-import.v1.json`` is generated from the models below
(``scripts/gen_connector_schemas.py``, ``--check`` in the tests). The document mirrors
``RawTransaction`` so it maps 1:1.

One strict validator serves both variants: the JSON document (or the CSV rows turned into the same
shape) is validated by the pydantic models, then a few cross-field checks run (decimal places per
currency, repeated transaction ids). Every problem becomes a :class:`BudgetIssue` with its kind, its
1-based transaction row and its field name, and a message that NEVER contains a value from the file:
issues may be shown to an agent (``cashu connectors test``, MCP), and a bank statement holds names,
account numbers and amounts. Blocking issues stop the import; warnings do not.

Public entry points:

- :func:`parse_budget_document` (bytes, file name, source) -> :class:`CanonicalResult` with a
  ``ParsedStatement`` when nothing blocks;
- :func:`validate_budget_document` (bytes, file name) -> :class:`BudgetValidationReport`, value-free,
  for the connector CLI (``cashu connectors test``) and tools;
- :func:`looks_like_budget_document` for importer auto-detection.
"""

from __future__ import annotations

import csv
import difflib
import io
import json
import re
from dataclasses import dataclass, field
from datetime import date
from decimal import Decimal
from enum import StrEnum
from typing import Annotated, Any, Literal

from pydantic import (
    BaseModel,
    BeforeValidator,
    ConfigDict,
    Field,
    StringConstraints,
    ValidationError,
    WithJsonSchema,
)
from pydantic_core import PydanticCustomError

from cashu.core.models import Source
from cashu.core.text import normalize_iban

from .csv_import.base import ParsedStatement
from .normalize import RawTransaction

FORMAT = "cashu-budget-import"
FORMAT_VERSION = 1
IMPORTER_ID = "cashu-budget"
"""Importer id of this format in the budget import (``bank`` / ``importer`` field)."""
# legacy name: the ids before the rename, still accepted (deprecated) and read as the new ones
LEGACY_FORMAT = "finanse-budget-import"
LEGACY_IMPORTER_ID = "finanse-budget"
DEFAULT_BANK = "other"
"""Institution id of a new account when the document names neither ``account.institution`` nor
``source`` (an id no registry entry knows: shown as is)."""

JSON_EXTENSIONS: tuple[str, ...] = ("json",)
CSV_EXTENSIONS: tuple[str, ...] = ("csv", "txt")
SNIFF_BYTES = 64 * 1024

MAX_TEXT = 500
MAX_ID = 200
MAX_ACCOUNT_NAME = 120
MAX_TRANSACTIONS = 200_000
MAX_BALANCES = 10_000

# Currencies with three minor digits (ISO 4217); every other currency allows at most two decimals.
THREE_DECIMAL_CURRENCIES = frozenset({"BHD", "IQD", "JOD", "KWD", "LYD", "OMR", "TND"})

_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_NUMBER = re.compile(r"^[+-]?\d+(\.\d+)?$")
_CURRENCY = re.compile(r"^[A-Za-z]{3}$")
SOURCE_PATTERN = r"^[a-z][a-z0-9_]{0,31}$"
INSTITUTION_PATTERN = r"^[a-z][a-z0-9_-]{0,31}$"
_IBAN_MIN, _IBAN_MAX = 8, 34


class IssueKind(StrEnum):
    """Stable kinds of :class:`BudgetIssue` (values are the wire names, ``import.<kind>`` labels)."""

    FILE_FORMAT = "file_format"
    """Undecodable text, broken CSV / JSON, wrong format name or version, wrong shape."""
    MISSING_COLUMN = "missing_column"
    """A required CSV column is missing from the header."""
    UNKNOWN_FIELD = "unknown_field"
    """An unknown key or column (strict: never ignored)."""
    MISSING_VALUE = "missing_value"
    """A required value is empty."""
    INVALID_VALUE = "invalid_value"
    """A value that cannot be read: date, number, currency, account number, text length."""
    INCONSISTENT_FILE = "inconsistent_file"
    """File-level CSV columns (account, source) differ between rows."""
    DUPLICATE_ID = "duplicate_id"
    """The same ``transaction_id`` on two rows."""
    CURRENCY_MISMATCH = "currency_mismatch"
    """A transaction in another currency than the account (warning)."""
    UNKNOWN_INSTITUTION = "unknown_institution"
    """``account.institution`` names no known institution (warning; the id is kept as is)."""
    EMPTY = "empty"
    """No transactions (warning: a document with balances only is still valid)."""
    OVERLAP = "overlap"
    """Import preview (not the parser): rows the account's stored history from another source already
    covers (the newest-day rule, warning)."""


@dataclass(frozen=True, slots=True)
class BudgetIssue:
    """One validation problem, value-free: ``row`` is the 1-based transaction (JSON array position
    + 1, CSV data row after the header), None for document-level problems; ``field`` the field
    name or path (``account.currency``, ``balances[2].amount``)."""

    kind: str
    message: str
    row: int | None = None
    field: str | None = None
    blocking: bool = True

    @property
    def code(self) -> str:
        return f"import.{self.kind}"

    def as_dict(self) -> dict:
        return {
            "kind": self.kind,
            "code": self.code,
            "row": self.row,
            "field": self.field,
            "message": self.message,
            "blocking": self.blocking,
        }

    def __str__(self) -> str:
        where = "" if self.row is None else f"row {self.row}: "
        name = "" if self.field is None else f"{self.field}: "
        return f"{where}{name}{self.message}{'' if self.blocking else ' (warning)'}"


# --- value types (strict, value-free errors) -------------------------------------------------------


def _err(kind: str, message: str) -> PydanticCustomError:
    return PydanticCustomError(kind, message)


def _required(value: Any) -> None:
    if value is None or (isinstance(value, str) and not value.strip()):
        raise _err("missing", "is required")


def _iso_date(value: Any) -> Any:
    _required(value)
    if isinstance(value, date):
        return value
    if not isinstance(value, str):
        raise _err("date_format", "must be a date string YYYY-MM-DD")
    text = value.strip()
    if not _DATE.match(text):
        raise _err("date_format", "is not a date in YYYY-MM-DD format")
    try:
        return date.fromisoformat(text)
    except ValueError:
        raise _err("date_format", "is not a real calendar date") from None


def _optional_date(value: Any) -> Any:
    if value is None or (isinstance(value, str) and not value.strip()):
        return None
    return _iso_date(value)


def _amount(value: Any) -> Any:
    _required(value)
    if isinstance(value, bool):
        raise _err("decimal_format", "must be a decimal number")
    if isinstance(value, Decimal):
        if not value.is_finite():
            raise _err("decimal_format", "must be a finite decimal number")
        return value
    if isinstance(value, int):
        return Decimal(value)
    if isinstance(value, float):
        number = Decimal(str(value))
        if not number.is_finite():
            raise _err("decimal_format", "must be a finite decimal number")
        return number
    if isinstance(value, str):
        text = value.strip()
        if _NUMBER.match(text):
            return Decimal(text)
        raise _err(
            "decimal_format",
            'is not a decimal number (use "." as the decimal separator, no thousands separators)',
        )
    raise _err("decimal_format", "must be a decimal number")


def _optional_amount(value: Any) -> Any:
    if value is None or (isinstance(value, str) and not value.strip()):
        return None
    return _amount(value)


def _currency(value: Any) -> Any:
    _required(value)
    if not isinstance(value, str) or not _CURRENCY.match(value.strip()):
        raise _err("currency_format", "must be a 3-letter ISO 4217 code")
    return value.strip().upper()


def _blank_none(value: Any) -> Any:
    if isinstance(value, str):
        text = value.strip()
        return text or None
    return value


def _iban(value: Any) -> Any:
    value = _blank_none(value)
    if value is None:
        return None
    if not isinstance(value, str):
        raise _err("iban_format", "must be a string")
    canon = normalize_iban(value)
    if not (_IBAN_MIN <= len(canon) <= _IBAN_MAX):
        raise _err("iban_format", "is not an account number (IBAN or NRB)")
    return canon


_DATE_SCHEMA = {"type": "string", "format": "date", "pattern": _DATE.pattern}
_AMOUNT_SCHEMA = {
    "type": ["string", "number"],
    "pattern": _NUMBER.pattern,
    "description": 'Signed decimal, "." separator (a string is preferred: no float rounding).',
}
_CURRENCY_SCHEMA = {"type": "string", "pattern": _CURRENCY.pattern}


def _text(max_length: int) -> Any:
    return Annotated[
        Annotated[str, StringConstraints(max_length=max_length)] | None,
        BeforeValidator(_blank_none),
    ]


IsoDate = Annotated[date, BeforeValidator(_iso_date), WithJsonSchema(_DATE_SCHEMA)]
OptionalDate = Annotated[
    date | None,
    BeforeValidator(_optional_date),
    WithJsonSchema({"anyOf": [_DATE_SCHEMA, {"type": "null"}]}),
]
Amount = Annotated[Decimal, BeforeValidator(_amount), WithJsonSchema(_AMOUNT_SCHEMA)]
OptionalAmount = Annotated[
    Decimal | None,
    BeforeValidator(_optional_amount),
    WithJsonSchema({"anyOf": [_AMOUNT_SCHEMA, {"type": "null"}]}),
]
Currency = Annotated[str, BeforeValidator(_currency), WithJsonSchema(_CURRENCY_SCHEMA)]
Iban = Annotated[
    str | None,
    BeforeValidator(_iban),
    WithJsonSchema({
        "anyOf": [{"type": "string", "maxLength": 64}, {"type": "null"}],
        "description": "IBAN or Polish NRB; spaces and punctuation are ignored.",
    }),
]


Text = _text(MAX_TEXT)
ShortText = _text(MAX_ID)
AccountName = _text(MAX_ACCOUNT_NAME)
InstitutionId = Annotated[
    Annotated[str, StringConstraints(pattern=INSTITUTION_PATTERN)] | None,
    BeforeValidator(_blank_none),
]
SourceId = Annotated[
    Annotated[str, StringConstraints(pattern=SOURCE_PATTERN)] | None,
    BeforeValidator(_blank_none),
]


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class DocAccount(_Strict):
    """The account the statement belongs to."""

    currency: Currency = Field(description="ISO 4217 code of the account.")
    iban: Iban = Field(
        default=None,
        description="Matches an existing account of the profile (any bank); otherwise the owner "
        "picks the account in the preview.",
    )
    name: AccountName = Field(
        default=None, description="Name of a newly created account (never renames one)."
    )
    institution: InstitutionId = Field(
        default=None,
        description='Institution id of a newly created account ("mbank", "pekao", ...); '
        "default: the document's source.",
    )


class DocBalance(_Strict):
    """A closing balance of the account on a date (wins over ``balance_after`` of that date)."""

    date: IsoDate
    amount: Amount


class DocTransaction(_Strict):
    """One booked transaction (mirrors ``RawTransaction``)."""

    booking_date: IsoDate
    amount: Amount = Field(description="Signed: negative = outflow, positive = inflow.")
    currency: Currency
    value_date: OptionalDate = None
    counterparty_name: Text = None
    counterparty_iban: Iban = None
    description: Text = None
    reference: ShortText = None
    transaction_id: ShortText = Field(
        default=None, description="The bank's stable id of the transaction (deduplication)."
    )
    balance_after: OptionalAmount = Field(
        default=None, description="Account balance after this transaction (end-of-day snapshot)."
    )


class BudgetImportDocument(_Strict):
    """A ``cashu-budget-import`` v1 document (the JSON variant)."""

    format: Literal["cashu-budget-import"]
    format_version: Literal[1]
    account: DocAccount
    transactions: list[DocTransaction] = Field(max_length=MAX_TRANSACTIONS)
    source: SourceId = Field(default=None, description="Who produced the document (connector or converter).")
    balances: list[DocBalance] = Field(default_factory=list, max_length=MAX_BALANCES)


TRANSACTION_FIELDS: tuple[str, ...] = tuple(DocTransaction.model_fields)
ACCOUNT_FIELDS: tuple[str, ...] = tuple(DocAccount.model_fields)
TOP_LEVEL_KEYS: tuple[str, ...] = tuple(BudgetImportDocument.model_fields)

# CSV variant: one row per transaction; the file-level values are constant columns.
CSV_FILE_COLUMNS: dict[str, str] = {
    "account_iban": "iban",
    "account_currency": "currency",
    "account_name": "name",
    "account_institution": "institution",
}
REQUIRED_CSV_COLUMNS: tuple[str, ...] = ("format_version", "booking_date", "amount", "currency")
CSV_COLUMNS: tuple[str, ...] = (
    "format_version",
    *TRANSACTION_FIELDS,
    *CSV_FILE_COLUMNS,
    "source",
)


# --- results ---------------------------------------------------------------------------------------


@dataclass
class CanonicalResult:
    """What :func:`parse_budget_document` extracted: the statement (None when anything blocks), the
    value-free issues and the counts."""

    statement: ParsedStatement | None
    issues: list[BudgetIssue] = field(default_factory=list)
    variant: str = "json"  # json | csv
    source: str | None = None
    institution: str | None = None
    transactions: int = 0
    balances: int = 0

    @property
    def blocking(self) -> list[BudgetIssue]:
        return [i for i in self.issues if i.blocking]

    @property
    def warnings(self) -> list[BudgetIssue]:
        return [i for i in self.issues if not i.blocking]

    @property
    def ok(self) -> bool:
        return self.statement is not None and not self.blocking


@dataclass
class BudgetValidationReport:
    """Value-free validation report of a budget document (counts, issues by kind, row and field)."""

    ok: bool
    format: str
    variant: str
    transactions: int
    balances: int
    issues: list[BudgetIssue]
    date_range: tuple[date, date] | None = None
    currencies: list[str] = field(default_factory=list)

    def as_dict(self) -> dict:
        kinds: dict[str, int] = {}
        for issue in self.issues:
            kinds[issue.kind] = kinds.get(issue.kind, 0) + 1
        return {
            "ok": self.ok,
            "format": self.format,
            "variant": self.variant,
            "transactions": self.transactions,
            "balances": self.balances,
            "date_range": None
            if self.date_range is None
            else {"from": self.date_range[0].isoformat(), "to": self.date_range[1].isoformat()},
            "currencies": self.currencies,
            "issue_counts": kinds,
            "issues": [i.as_dict() for i in self.issues],
        }

    def summary(self) -> str:
        """Plain-text lines (value-free) for a CLI."""
        status = "OK" if self.ok else "BLOCKED"
        head = (
            f"{FORMAT} v{FORMAT_VERSION} ({self.variant}): {status}, "
            f"{self.transactions} transactions, {self.balances} balances"
        )
        lines = [head]
        lines += [f"  {'error' if i.blocking else 'warning'} [{i.kind}] {i}" for i in self.issues]
        return "\n".join(lines)


# --- detection --------------------------------------------------------------------------------------


def _extension(name: str) -> str:
    return name.rsplit(".", 1)[-1].lower() if "." in name else ""


def _decode(content: bytes) -> str:
    """UTF-8 (a BOM is allowed); UnicodeDecodeError otherwise."""
    return content.decode("utf-8-sig")


def _header_name(cell: str) -> str:
    return cell.strip().lstrip("﻿").strip().lower()


def looks_like_budget_document(content: bytes, name: str) -> bool:
    """JSON: an object naming the format near its start. CSV: the first line has the
    ``format_version`` and ``booking_date`` columns. Never raises."""
    head = content[:SNIFF_BYTES].decode("utf-8", errors="replace").lstrip("﻿")
    stripped = head.lstrip()
    if stripped.startswith("{"):
        return any(f'"{f}"' in stripped[:4096] for f in (FORMAT, LEGACY_FORMAT))
    if _extension(name) in JSON_EXTENSIONS:
        return False
    first_line = stripped.splitlines()[0] if stripped else ""
    try:
        header = next(csv.reader([first_line]), [])
    except csv.Error:
        return False
    names = {_header_name(cell) for cell in header}
    return "format_version" in names and "booking_date" in names


# --- parsing ------------------------------------------------------------------------------------------


class _DuplicateKey(ValueError):
    pass


def _object_hook(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise _DuplicateKey(key)
        result[key] = value
    return result


def _reject_constant(_name: str) -> object:
    raise ValueError("not a number")


def _file_error(message: str, variant: str) -> CanonicalResult:
    return CanonicalResult(None, [BudgetIssue(IssueKind.FILE_FORMAT, message)], variant=variant)


_FIELD_LIKE = re.compile(r"^[a-z][a-z0-9_ ]{0,40}$")


def _column_label(name: str, index: int) -> str:
    """An unknown column as reported: its name when it looks like a column name, else its position
    (``column 3``): a name, a title, an amount or an account number from a data row never shows."""
    from cashu.core.mcp.names import looks_like_person

    if (
        _FIELD_LIKE.match(name)
        and sum(ch.isdigit() for ch in name) < 4
        and len(name.split()) <= 3
        and not looks_like_person(name)
    ):
        return name
    return f"column {index + 1}"


def _did_you_mean(name: str, known: tuple[str, ...]) -> str:
    match = difflib.get_close_matches(name, known, n=1, cutoff=0.75)
    return f' (did you mean "{match[0]}"?)' if match else ""


def parse_budget_document(
    content: bytes, name: str, *, source: Source = Source.CSV
) -> CanonicalResult:
    """Parse and validate a budget document (JSON when it starts with ``{`` or is named ``.json``,
    else CSV). ``source`` marks the transactions (``Source.CONNECTOR`` for a connector's output,
    ``Source.CSV`` for a file the owner uploads)."""
    head = content[:SNIFF_BYTES].lstrip(b"\xef\xbb\xbf").lstrip()
    if head.startswith(b"{") or _extension(name) in JSON_EXTENSIONS:
        return _parse_json(content, source)
    return _parse_csv(content, source)


def _parse_json(content: bytes, source: Source) -> CanonicalResult:
    try:
        text = _decode(content)
    except UnicodeDecodeError as error:
        return _file_error(f"file is not valid UTF-8 (byte {error.start})", "json")
    try:
        document = json.loads(
            text,
            parse_float=Decimal,
            parse_constant=_reject_constant,
            object_pairs_hook=_object_hook,
        )
    except json.JSONDecodeError as error:
        return _file_error(
            f"file is not valid JSON (line {error.lineno}, column {error.colno})", "json"
        )
    except _DuplicateKey:
        return _file_error("file is not valid JSON (a key repeats within one object)", "json")
    except (ValueError, RecursionError):
        return _file_error("file is not valid JSON", "json")
    if not isinstance(document, dict):
        return _file_error("the JSON document must be an object", "json")
    return _validate(document, source, variant="json")


def _parse_csv(content: bytes, source: Source) -> CanonicalResult:
    try:
        text = _decode(content)
    except UnicodeDecodeError as error:
        return _file_error(f"file is not valid UTF-8 (byte {error.start})", "csv")
    reader = csv.reader(io.StringIO(text, newline=""), delimiter=",", quotechar='"', strict=True)
    try:
        records = [list(r) for r in reader]
    except csv.Error:
        return _file_error(f"file is not valid CSV (line {reader.line_num})", "csv")
    if not records or all(not c.strip() for c in records[0]):
        return _file_error("file is empty (expected a header line)", "csv")

    header = [_header_name(c) for c in records[0]]
    if not set(header) & set(REQUIRED_CSV_COLUMNS):
        # A raw export or a header-less file: its first line is data, never echoed as column names.
        return _file_error(
            "no cashu-budget-import header line (expected the columns "
            + ", ".join(REQUIRED_CSV_COLUMNS) + ")",
            "csv",
        )
    issues: list[BudgetIssue] = []
    seen: set[str] = set()
    for index, column in enumerate(header):
        if column not in CSV_COLUMNS:
            label = _column_label(column, index)
            hint = _did_you_mean(column, CSV_COLUMNS) if label == column else ""
            issues.append(BudgetIssue(IssueKind.UNKNOWN_FIELD, f"unknown column{hint}", field=label))
        elif column in seen:
            issues.append(BudgetIssue(IssueKind.FILE_FORMAT, "duplicate column", field=column))
        seen.add(column)
    for required in REQUIRED_CSV_COLUMNS:
        if required not in seen:
            issues.append(BudgetIssue(
                IssueKind.MISSING_COLUMN, "required column is missing", field=required
            ))
    if issues:
        return CanonicalResult(None, issues, variant="csv")

    transactions: list[dict] = []
    file_values: dict[str, str | None] = {}
    row_numbers: list[int] = []
    for r, cells in enumerate(records[1:], start=1):
        if all(not c.strip() for c in cells):
            continue
        if len(cells) != len(header):
            issues.append(BudgetIssue(
                IssueKind.FILE_FORMAT, "row has a different number of cells than the header", row=r
            ))
            continue
        values = dict(zip(header, (c.strip() for c in cells), strict=True))
        if values.pop("format_version") != str(FORMAT_VERSION):
            issues.append(BudgetIssue(
                IssueKind.FILE_FORMAT, f"must be {FORMAT_VERSION}", row=r, field="format_version"
            ))
            continue
        for column in (*CSV_FILE_COLUMNS, "source"):
            if column not in values:
                continue
            value = values.pop(column) or None
            if column in file_values and file_values[column] != value:
                issues.append(BudgetIssue(
                    IssueKind.INCONSISTENT_FILE, "differs from the first row", row=r, field=column
                ))
            file_values.setdefault(column, value)
        transactions.append({k: (v or None) for k, v in values.items()})
        row_numbers.append(r)

    account: dict[str, Any] = {
        target: file_values.get(column)
        for column, target in CSV_FILE_COLUMNS.items()
        if file_values.get(column) is not None
    }
    if "currency" not in account:
        currencies = {str(t.get("currency") or "").strip().upper() for t in transactions} - {""}
        if len(currencies) == 1:
            account["currency"] = currencies.pop()
        elif transactions:
            issues.append(BudgetIssue(
                IssueKind.MISSING_COLUMN,
                "required when the rows use more than one currency",
                field="account_currency",
            ))
    document = {
        "format": FORMAT,
        "format_version": FORMAT_VERSION,
        "account": account,
        "transactions": transactions,
    }
    if file_values.get("source") is not None:
        document["source"] = file_values["source"]
    result = _validate(document, source, variant="csv", rows=row_numbers)
    result.issues[:0] = issues
    if issues and any(i.blocking for i in issues):
        result.statement = None
    return result


def _loc_to_place(loc: tuple, rows: list[int] | None) -> tuple[int | None, str | None]:
    """Pydantic error location -> (1-based transaction row, field path)."""
    parts = list(loc)
    if len(parts) >= 2 and parts[0] == "transactions" and isinstance(parts[1], int):
        index = parts[1]
        row = rows[index] if rows is not None and index < len(rows) else index + 1
        name = ".".join(str(p) for p in parts[2:]) or None
        return row, name
    if len(parts) >= 2 and parts[0] == "balances" and isinstance(parts[1], int):
        tail = "".join(f".{p}" for p in parts[2:])
        return None, f"balances[{parts[1] + 1}]{tail}"
    return None, ".".join(str(p) for p in parts) or None


_KNOWN_BY_PARENT = {
    "": TOP_LEVEL_KEYS,
    "account": ACCOUNT_FIELDS,
    "transactions": TRANSACTION_FIELDS,
    "balances": tuple(DocBalance.model_fields),
}


def _issue_from_error(error: dict, rows: list[int] | None, variant: str) -> BudgetIssue:
    kind_name = error["type"]
    loc = tuple(error["loc"])
    row, name = _loc_to_place(loc, rows)
    if variant == "csv" and name and name.startswith("account."):
        attr = name.split(".", 1)[1]
        name = next((c for c, t in CSV_FILE_COLUMNS.items() if t == attr), name)
    ctx = error.get("ctx") or {}
    if kind_name == "missing":
        return BudgetIssue(IssueKind.MISSING_VALUE, "is required", row, name)
    if kind_name == "extra_forbidden":
        parent = str(loc[0]) if len(loc) > 1 else ""
        known = _KNOWN_BY_PARENT.get(parent, ())
        return BudgetIssue(
            IssueKind.UNKNOWN_FIELD,
            f"unknown field{_did_you_mean(str(loc[-1]), known)}",
            row,
            name,
        )
    if kind_name == "literal_error":
        if loc == ("format",):
            return BudgetIssue(IssueKind.FILE_FORMAT, f'must be "{FORMAT}"', None, "format")
        if loc == ("format_version",):
            return BudgetIssue(
                IssueKind.FILE_FORMAT, f"must be the number {FORMAT_VERSION}", None, "format_version"
            )
    if kind_name in ("model_type", "model_attributes_type", "dict_type"):
        kind = IssueKind.FILE_FORMAT if row is None else IssueKind.INVALID_VALUE
        return BudgetIssue(kind, "must be an object", row, name)
    if kind_name == "list_type":
        return BudgetIssue(IssueKind.FILE_FORMAT, "must be an array", row, name)
    if kind_name == "too_long" and ctx.get("max_length") is not None:
        return BudgetIssue(
            IssueKind.FILE_FORMAT, f"more than {ctx['max_length']} entries", row, name
        )
    if kind_name == "string_too_long":
        return BudgetIssue(
            IssueKind.INVALID_VALUE, f"longer than {ctx.get('max_length')} characters", row, name
        )
    if kind_name == "string_pattern_mismatch":
        return BudgetIssue(
            IssueKind.INVALID_VALUE, f"must match {ctx.get('pattern')}", row, name
        )
    if kind_name in ("string_type", "str_type"):
        return BudgetIssue(IssueKind.INVALID_VALUE, "must be a string", row, name)
    if kind_name in ("date_format", "decimal_format", "currency_format", "iban_format"):
        return BudgetIssue(IssueKind.INVALID_VALUE, error["msg"], row, name)
    return BudgetIssue(IssueKind.INVALID_VALUE, "invalid value", row, name)


def _minor_digits(currency: str) -> int:
    return 3 if currency in THREE_DECIMAL_CURRENCIES else 2


def _decimals(value: Decimal) -> int:
    exponent = value.normalize().as_tuple().exponent
    return max(0, -exponent) if isinstance(exponent, int) else 0


def _validate(
    document: dict, source: Source, *, variant: str, rows: list[int] | None = None
) -> CanonicalResult:
    if isinstance(document.get("format_version"), bool):  # JSON true == 1 for a lax Literal[1]
        document = {**document, "format_version": None}
    if document.get("format") == LEGACY_FORMAT:  # the pre-rename id (deprecated)
        document = {**document, "format": FORMAT}
    try:
        doc = BudgetImportDocument.model_validate(document)
    except ValidationError as exc:
        issues = [_issue_from_error(e, rows, variant) for e in exc.errors(include_input=False)]
        txns, balances = document.get("transactions"), document.get("balances")
        return CanonicalResult(
            None,
            _dedupe(issues),
            variant=variant,
            transactions=len(txns) if isinstance(txns, list) else 0,
            balances=len(balances) if isinstance(balances, list) else 0,
        )

    def row_of(index: int) -> int:
        return rows[index] if rows is not None else index + 1

    issues: list[BudgetIssue] = []
    account_currency = doc.account.currency
    seen_ids: dict[str, int] = {}
    other_currency = 0
    for index, t in enumerate(doc.transactions):
        limit = _minor_digits(t.currency)
        if _decimals(t.amount) > limit:
            issues.append(BudgetIssue(
                IssueKind.INVALID_VALUE,
                f"more than {limit} decimal places for its currency",
                row_of(index),
                "amount",
            ))
        if t.balance_after is not None and _decimals(t.balance_after) > _minor_digits(
            account_currency
        ):
            issues.append(BudgetIssue(
                IssueKind.INVALID_VALUE,
                "more decimal places than the account currency allows",
                row_of(index),
                "balance_after",
            ))
        if t.transaction_id is not None:
            first = seen_ids.setdefault(t.transaction_id, row_of(index))
            if first != row_of(index):
                issues.append(BudgetIssue(
                    IssueKind.DUPLICATE_ID,
                    f"the same id as row {first}",
                    row_of(index),
                    "transaction_id",
                ))
        if t.currency != account_currency:
            other_currency += 1
            if other_currency <= 20:
                issues.append(BudgetIssue(
                    IssueKind.CURRENCY_MISMATCH,
                    "differs from the account currency",
                    row_of(index),
                    "currency",
                    blocking=False,
                ))
    for index, b in enumerate(doc.balances):
        if _decimals(b.amount) > _minor_digits(account_currency):
            issues.append(BudgetIssue(
                IssueKind.INVALID_VALUE,
                "more decimal places than the account currency allows",
                None,
                f"balances[{index + 1}].amount",
            ))
    institution = doc.account.institution
    if institution is not None and not _known_institution(institution):
        issues.append(BudgetIssue(
            IssueKind.UNKNOWN_INSTITUTION,
            "names no known institution; kept as the new account's institution id",
            None,
            "account_institution" if variant == "csv" else "account.institution",
            blocking=False,
        ))
    if not doc.transactions:
        issues.append(BudgetIssue(IssueKind.EMPTY, "no transactions", None, "transactions", False))

    result = CanonicalResult(
        None,
        issues,
        variant=variant,
        source=doc.source,
        institution=institution,
        transactions=len(doc.transactions),
        balances=len(doc.balances),
    )
    if result.blocking:
        return result
    result.statement = _statement(doc, source)
    return result


def _known_institution(institution_id: str) -> bool:
    from cashu.core import institutions

    try:
        institutions.get(institution_id)
    except institutions.UnknownInstitution:
        return False
    return True


def _statement(doc: BudgetImportDocument, source: Source) -> ParsedStatement:
    bank = doc.account.institution or doc.source or DEFAULT_BANK
    stmt = ParsedStatement(
        bank=bank,
        account_number=doc.account.iban,
        account_name=doc.account.name,
        currency=doc.account.currency,
    )
    for index, t in enumerate(doc.transactions):
        stmt.transactions.append(
            RawTransaction(
                booking_date=t.booking_date,
                value_date=t.value_date,
                amount=t.amount,
                currency=t.currency,
                counterparty_name=t.counterparty_name,
                counterparty_iban=t.counterparty_iban,
                description=t.description,
                reference=t.reference,
                bank_transaction_id=t.transaction_id,
                source=source,
                raw={"format": FORMAT, "row": index + 1, "source": doc.source},
            )
        )
        if t.balance_after is not None:
            stmt.balances.append((t.booking_date, t.balance_after))
    stmt.closing_balances = [(b.date, b.amount) for b in doc.balances]
    return stmt


def _dedupe(issues: list[BudgetIssue]) -> list[BudgetIssue]:
    seen: set[tuple] = set()
    out: list[BudgetIssue] = []
    for issue in issues:
        key = (issue.kind, issue.row, issue.field, issue.message)
        if key not in seen:
            seen.add(key)
            out.append(issue)
    return out


# --- the public validation entry point (connector CLI, tools) --------------------------------------


def validate_budget_document(data: bytes, name: str) -> BudgetValidationReport:
    """Validate a ``cashu-budget-import`` document without touching any database: a value-free
    report (counts, date range, currencies, issues by kind with row numbers and field names).
    Imported lazily by ``cashu connectors test`` (budget connectors)."""
    result = parse_budget_document(data, name)
    stmt = result.statement
    date_range = None
    currencies: list[str] = []
    if stmt is not None and stmt.transactions:
        dates = [t.booking_date for t in stmt.transactions]
        date_range = (min(dates), max(dates))
        currencies = sorted({t.currency.upper() for t in stmt.transactions})
    return BudgetValidationReport(
        ok=result.ok,
        format=FORMAT,
        variant=result.variant,
        transactions=result.transactions,
        balances=result.balances,
        issues=result.issues,
        date_range=date_range,
        currencies=currencies,
    )


__all__ = [
    "FORMAT",
    "FORMAT_VERSION",
    "IMPORTER_ID",
    "LEGACY_FORMAT",
    "LEGACY_IMPORTER_ID",
    "BudgetImportDocument",
    "BudgetIssue",
    "BudgetValidationReport",
    "CanonicalResult",
    "IssueKind",
    "looks_like_budget_document",
    "parse_budget_document",
    "validate_budget_document",
]
