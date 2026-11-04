"""Configuration of the generic CSV importer: file format plus column and type mapping, loaded from YAML.

``generic_csv_example.yaml`` (next to this module, see :func:`example_mapping_yaml`) documents every key.
Unknown keys are errors with a did-you-mean hint and a 1-based line / column, so a typo never silently
falls back to a default.
"""

from __future__ import annotations

import difflib
import re
from collections.abc import Iterable
from dataclasses import dataclass, field
from enum import StrEnum
from importlib.resources import files

import yaml
from yaml.nodes import MappingNode, Node, ScalarNode, SequenceNode

from ..domain import Currency, TxnType
from .csv_values import DatePattern, DecimalFormat
from .text import ImportTextEncoding, parse_encoding

GENERIC_CSV_BROKER_ID = "generic_csv"
"""Broker id (and alias namespace) of the generic CSV importer when a mapping sets no ``broker_id``."""

MAPPING_VERSION = 1
MAX_MAPPING_CHARS = 256_000
"""Largest mapping file accepted (a real one is a few kB)."""

IGNORE_TYPE = "ignore"
"""Value of a ``types:`` entry that skips the row (with a non-blocking warning)."""


class CsvField(StrEnum):
    """Target fields a CSV column can be mapped to (keys under ``columns:``)."""

    EXTERNAL_REF = "external_ref"
    TRADE_DATE = "trade_date"
    SETTLE_DATE = "settle_date"
    TYPE = "type"
    SYMBOL = "symbol"
    ISIN = "isin"
    NAME = "name"
    EXCHANGE = "exchange"
    QUANTITY = "quantity"
    PRICE = "price"
    CURRENCY = "currency"
    GROSS_AMOUNT = "gross_amount"
    FEE = "fee"
    TAX = "tax"
    CASH_AMOUNT = "cash_amount"
    CASH_CURRENCY = "cash_currency"
    FX_RATE = "fx_rate"
    SPLIT_RATIO = "split_ratio"
    NOTE = "note"


class AmountSign(StrEnum):
    """How amount columns carry their direction."""

    SIGNED = "signed"
    """``cash_amount`` is signed as the broker wrote it: negative = money leaves the account."""
    ABSOLUTE = "absolute"
    """Every amount is positive; the sign of ``cash_amount`` comes from the transaction type."""


class RowErrorPolicy(StrEnum):
    """What happens to a row that cannot be parsed (bad number, unknown type...)."""

    BLOCK = "block"
    """The row becomes a blocking warning: the import cannot be committed until fixed."""
    SKIP = "skip"
    """The row is skipped with a non-blocking warning."""


DEFAULT_DATE_FORMATS: tuple[str, ...] = ("yyyy-MM-dd",)
DEFAULT_EXTENSIONS: tuple[str, ...] = ("csv", "txt", "tsv")


@dataclass(frozen=True, slots=True, kw_only=True)
class CsvMapping:
    """Configuration of ``GenericCsvImporter``. Header names and type values match trimmed and
    case-insensitively. Build it with :meth:`from_yaml` (validated) or directly in code."""

    columns: dict[CsvField, str]
    """Target field -> header text in the file."""
    broker_id: str = GENERIC_CSV_BROKER_ID
    """Alias namespace of the file's symbols and the broker stored on the import batch."""
    display_name: str = "Generic CSV"
    encoding: ImportTextEncoding = ImportTextEncoding.UTF8
    delimiter: str = ","
    quote: str = '"'
    number_format: DecimalFormat = field(default_factory=DecimalFormat)
    date_formats: tuple[str, ...] = DEFAULT_DATE_FORMATS
    """Date patterns tried in order (see ``csv_values.DatePattern``)."""
    header_row: int = 0
    """0-based index of the CSV record holding the column headers; records before it are skipped."""
    types: dict[str, TxnType] = field(default_factory=dict)
    """Broker type string -> transaction type. Unlisted values fall back to the type wire names."""
    ignored_types: frozenset[str] = frozenset()
    """Broker type strings whose rows are skipped with a non-blocking warning."""
    amount_sign: AmountSign = AmountSign.SIGNED
    default_currency: Currency | None = None
    """Currency for rows without a currency cell value."""
    on_row_error: RowErrorPolicy = RowErrorPolicy.BLOCK
    extensions: tuple[str, ...] = DEFAULT_EXTENSIONS
    """File extensions (lower-case, no dot) the importer accepts."""

    @staticmethod
    def from_yaml(text: str) -> CsvMapping:
        """Parse and validate a mapping; raises :class:`CsvMappingError` listing every problem found."""
        return _MappingParser().parse(text)


@dataclass(frozen=True, slots=True)
class CsvMappingIssue:
    """One problem in a mapping file. ``line`` and ``column`` are 1-based when known."""

    path: str
    """YAML path, e.g. ``columns.trade_dat``."""
    message: str
    line: int | None = None
    column: int | None = None

    def __str__(self) -> str:
        location = "" if self.line is None else f"line {self.line}:{self.column or 0}: "
        path = f"{self.path}: " if self.path else ""
        return f"{location}{path}{self.message}"


class CsvMappingError(ValueError):
    """Raised by :meth:`CsvMapping.from_yaml` when the mapping is invalid."""

    def __init__(self, issues: list[CsvMappingIssue]) -> None:
        self.issues: tuple[CsvMappingIssue, ...] = tuple(issues)
        super().__init__(
            "Invalid CSV mapping:\n" + "\n".join(f"  {issue}" for issue in self.issues)
        )


def example_mapping_yaml() -> str:
    """The shipped example mapping (documents every key)."""
    return files(__package__).joinpath("generic_csv_example.yaml").read_text(encoding="utf-8")


KNOWN_KEYS: tuple[str, ...] = (
    "version",
    "name",
    "broker_id",
    "encoding",
    "delimiter",
    "quote",
    "decimal_separator",
    "thousands_separator",
    "date_formats",
    "header_row",
    "default_currency",
    "amount_sign",
    "on_row_error",
    "extensions",
    "columns",
    "types",
)
"""Top-level keys of a mapping file."""

_BROKER_ID = re.compile(r"^[a-z][a-z0-9_]*$")
_NULL_TAG = "tag:yaml.org,2002:null"
_INT_TAG = "tag:yaml.org,2002:int"
_THOUSANDS_KEYWORDS = {"none": "", "space": " "}


class _MappingParser:
    def __init__(self) -> None:
        self.issues: list[CsvMappingIssue] = []

    def parse(self, text: str) -> CsvMapping:
        root = self._compose(text)
        if not isinstance(root, MappingNode):
            node = root
            raise CsvMappingError(
                [_issue(node, "", "The mapping must be a YAML map")]
                if node is not None
                else [CsvMappingIssue("", "The mapping must be a YAML map")]
            )

        entries: dict[str, Node] = {}
        for key_node, value_node in root.value:
            key = _key_text(key_node)
            if key not in KNOWN_KEYS:
                self._error(key_node, key, f"Unknown key{did_you_mean(key, KNOWN_KEYS)}")
                continue
            if key in entries:
                self._error(key_node, key, "Duplicate key")
                continue
            entries[key] = value_node

        version = entries.get("version")
        if version is None or _is_null(version):
            self._error(root, "version", f"Missing required key (use version: {MAPPING_VERSION})")
        elif not (
            isinstance(version, ScalarNode)
            and version.tag == _INT_TAG
            and _int(version.value) == MAPPING_VERSION
        ):
            value = version.value if isinstance(version, ScalarNode) else "?"
            self._error(
                version,
                "version",
                f"Unsupported mapping version {value} (expected {MAPPING_VERSION})",
            )

        broker_node = entries.get("broker_id")
        broker_id = self._string(broker_node, "broker_id") or GENERIC_CSV_BROKER_ID
        if not _BROKER_ID.match(broker_id):
            self._error(
                broker_node or root,
                "broker_id",
                'Use lower-case letters, digits and "_" (e.g. mbank)',
            )
        display_name = self._string(entries.get("name"), "name") or "Generic CSV"
        encoding = self._encoding(entries.get("encoding"))
        delimiter = self._delimiter(entries.get("delimiter"))
        quote_node = entries.get("quote")
        quote = self._string(quote_node, "quote", trim=False)
        if quote is None:
            quote = '"'
        elif len(quote) != 1 or quote in "\r\n":
            self._error(quote_node or root, "quote", "Must be exactly one character")
            quote = '"'
        if quote == delimiter:
            self._error(quote_node or root, "quote", "Must differ from the delimiter")
        number_format = self._number_format(
            entries.get("decimal_separator"), entries.get("thousands_separator"), root
        )
        date_formats = self._date_formats(entries.get("date_formats"))
        header_row = self._header_row(entries.get("header_row"))
        default_currency = self._currency(entries.get("default_currency"))
        amount_sign = self._enum(entries.get("amount_sign"), "amount_sign", AmountSign)
        on_row_error = self._enum(entries.get("on_row_error"), "on_row_error", RowErrorPolicy)
        extensions = self._extensions(entries.get("extensions"))
        columns = self._columns(entries.get("columns"), root)
        types, ignored = self._types(entries.get("types"))

        if (
            columns is not None
            and CsvField.CURRENCY not in columns
            and default_currency is None
            and "columns" in entries
        ):
            self._error(
                entries["columns"], "columns", "Map a currency column or set default_currency"
            )

        if self.issues or columns is None:
            raise CsvMappingError(self.issues)
        return CsvMapping(
            columns=columns,
            broker_id=broker_id,
            display_name=display_name,
            encoding=encoding,
            delimiter=delimiter,
            quote=quote,
            number_format=number_format,
            date_formats=date_formats,
            header_row=header_row,
            types=types,
            ignored_types=frozenset(ignored),
            amount_sign=amount_sign or AmountSign.SIGNED,
            default_currency=default_currency,
            on_row_error=on_row_error or RowErrorPolicy.BLOCK,
            extensions=extensions,
        )

    # --- YAML ------------------------------------------------------------------------------------

    @staticmethod
    def _compose(text: str) -> Node | None:
        if len(text) > MAX_MAPPING_CHARS:
            raise CsvMappingError(
                [
                    CsvMappingIssue(
                        "",
                        f"Mapping is too large ({len(text)} characters, max {MAX_MAPPING_CHARS})",
                    )
                ]
            )
        try:
            return yaml.compose(text, Loader=yaml.SafeLoader)
        except yaml.MarkedYAMLError as error:
            mark = error.problem_mark or error.context_mark
            problem = error.problem or error.context or "syntax error"
            raise CsvMappingError(
                [
                    CsvMappingIssue(
                        "",
                        f"Invalid YAML: {problem}",
                        None if mark is None else mark.line + 1,
                        None if mark is None else mark.column + 1,
                    )
                ]
            ) from None
        except yaml.YAMLError as error:
            raise CsvMappingError([CsvMappingIssue("", f"Invalid YAML: {error}")]) from None

    # --- values ----------------------------------------------------------------------------------

    def _encoding(self, node: Node | None) -> ImportTextEncoding:
        text = self._string(node, "encoding")
        if text is None:
            return ImportTextEncoding.UTF8
        encoding = parse_encoding(text)
        if encoding is None:
            self._error(
                node, "encoding", f'Unknown encoding "{text}" (use utf-8, windows-1250 or auto)'
            )
            return ImportTextEncoding.UTF8
        return encoding

    def _delimiter(self, node: Node | None) -> str:
        text = self._string(node, "delimiter", trim=False)
        if text is None:
            return ","
        delimiter = "\t" if text in ("tab", "\\t") else text
        if len(delimiter) != 1 or delimiter in "\r\n":
            self._error(node, "delimiter", 'Must be one character (e.g. ",", ";", "tab")')
            return ","
        return delimiter

    def _number_format(
        self, decimal_node: Node | None, thousands_node: Node | None, root: Node
    ) -> DecimalFormat:
        decimal = self._string(decimal_node, "decimal_separator", trim=False)
        if decimal is None:
            decimal = "."
        if decimal not in (".", ","):
            self._error(decimal_node, "decimal_separator", 'Use "." or ","')
            return DecimalFormat()
        raw = self._string(thousands_node, "thousands_separator", trim=False)
        thousands = _THOUSANDS_KEYWORDS.get(raw, raw) if raw is not None else ""
        if thousands not in ("", " ", ".", ",", "'"):
            self._error(
                thousands_node,
                "thousands_separator",
                'Use "" (none), " " (or space), ".", "," or "\'"',
            )
            return DecimalFormat(decimal)
        if thousands == decimal:
            self._error(
                thousands_node or root, "thousands_separator", "Must differ from decimal_separator"
            )
            return DecimalFormat(decimal)
        return DecimalFormat(decimal, thousands)

    def _date_formats(self, node: Node | None) -> tuple[str, ...]:
        if node is None or _is_null(node):
            return DEFAULT_DATE_FORMATS
        if isinstance(node, SequenceNode):
            items: list[Node] = list(node.value)
        elif isinstance(node, ScalarNode):
            items = [node]
        else:
            self._error(node, "date_formats", "Must be a list of date patterns")
            return DEFAULT_DATE_FORMATS
        if not items:
            self._error(node, "date_formats", "List at least one date pattern")
        formats: list[str] = []
        for index, item in enumerate(items):
            path = f"date_formats[{index}]"
            pattern = self._string(item, path)
            if pattern is None:
                continue
            try:
                DatePattern(pattern)
            except ValueError as error:
                self._error(item, path, str(error))
                continue
            formats.append(pattern)
        return tuple(formats) or DEFAULT_DATE_FORMATS

    def _header_row(self, node: Node | None) -> int:
        if node is None or _is_null(node):
            return 0
        value = _int(node.value) if isinstance(node, ScalarNode) and node.tag == _INT_TAG else None
        if value is None or value < 0:
            self._error(node, "header_row", "Must be a non-negative integer (0 = first record)")
            return 0
        return value

    def _currency(self, node: Node | None) -> Currency | None:
        text = self._string(node, "default_currency")
        if text is None:
            return None
        try:
            return Currency(text)
        except ValueError:
            self._error(node, "default_currency", f'"{text}" is not an ISO 4217 code')
            return None

    def _enum[E: StrEnum](self, node: Node | None, path: str, enum: type[E]) -> E | None:
        text = self._string(node, path)
        if text is None:
            return None
        try:
            return enum(text.lower())
        except ValueError:
            names = ", ".join(member.value for member in enum)
            self._error(node, path, f'Unknown value "{text}" (use {names})')
            return None

    def _extensions(self, node: Node | None) -> tuple[str, ...]:
        if node is None or _is_null(node):
            return DEFAULT_EXTENSIONS
        if not isinstance(node, SequenceNode) or not node.value:
            self._error(node, "extensions", "Must be a non-empty list (e.g. [csv, txt])")
            return DEFAULT_EXTENSIONS
        extensions: list[str] = []
        for index, item in enumerate(node.value):
            text = self._string(item, f"extensions[{index}]")
            if text:
                extensions.append(text.lower().removeprefix("."))
        return tuple(extensions) or DEFAULT_EXTENSIONS

    def _columns(self, node: Node | None, root: Node) -> dict[CsvField, str] | None:
        if node is None or _is_null(node):
            self._error(
                root,
                "columns",
                "Missing required key (map at least trade_date, type and an amount)",
            )
            return None
        if not isinstance(node, MappingNode):
            self._error(node, "columns", 'Must be a map of field: "Header text"')
            return None
        names = [f.value for f in CsvField]
        columns: dict[CsvField, str] = {}
        for key_node, value_node in node.value:
            key = _key_text(key_node)
            path = f"columns.{key}"
            if key not in names:
                self._error(key_node, path, f"Unknown field{did_you_mean(key, names)}")
                continue
            target = CsvField(key)
            if target in columns:
                self._error(key_node, path, "Duplicate field")
                continue
            header = self._string(value_node, path)
            if not header:
                self._error(value_node, path, "Header text must not be empty")
                continue
            columns[target] = header
        for required in (CsvField.TRADE_DATE, CsvField.TYPE):
            if required not in columns:
                self._error(node, "columns", f"Missing required field {required.value}")
        has_amount = (
            CsvField.CASH_AMOUNT in columns
            or CsvField.GROSS_AMOUNT in columns
            or (CsvField.QUANTITY in columns and CsvField.PRICE in columns)
        )
        if not has_amount:
            self._error(node, "columns", "Map cash_amount, gross_amount, or quantity and price")
        return columns

    def _types(self, node: Node | None) -> tuple[dict[str, TxnType], set[str]]:
        types: dict[str, TxnType] = {}
        ignored: set[str] = set()
        if node is None or _is_null(node):
            return types, ignored
        if not isinstance(node, MappingNode):
            self._error(node, "types", 'Must be a map of "Broker type": txn_type')
            return types, ignored
        names = [t.value for t in TxnType] + [IGNORE_TYPE]
        seen: set[str] = set()
        for key_node, value_node in node.value:
            key = _key_text(key_node).strip()
            path = f"types.{key}"
            if not key:
                self._error(key_node, "types", "Broker type must not be empty")
                continue
            if key.lower() in seen:
                self._error(key_node, path, "Duplicate broker type")
                continue
            seen.add(key.lower())
            value = self._string(value_node, path)
            if value is None:
                self._error(value_node, path, f"Missing transaction type (use {', '.join(names)})")
                continue
            if value.lower() == IGNORE_TYPE:
                ignored.add(key)
                continue
            try:
                types[key] = TxnType(value.lower())
            except ValueError:
                self._error(
                    value_node,
                    path,
                    f'Unknown transaction type "{value}"{did_you_mean(value, names)}',
                )
        return types, ignored

    # --- helpers ---------------------------------------------------------------------------------

    def _string(self, node: Node | None, path: str, *, trim: bool = True) -> str | None:
        """The scalar text of ``node`` (as written: numbers stay their digits), or None when absent or
        null (``key:`` with no value)."""
        if node is None or _is_null(node):
            return None
        if not isinstance(node, ScalarNode):
            self._error(node, path, "Must be a single value")
            return None
        text = str(node.value)
        return text.strip() if trim else text

    def _error(self, node: Node | None, path: str, message: str) -> None:
        if node is None:
            self.issues.append(CsvMappingIssue(path, message))
        else:
            self.issues.append(_issue(node, path, message))


def _issue(node: Node, path: str, message: str) -> CsvMappingIssue:
    mark = node.start_mark
    return CsvMappingIssue(path, message, mark.line + 1, mark.column + 1)


def _is_null(node: Node) -> bool:
    return isinstance(node, ScalarNode) and node.tag == _NULL_TAG


def _key_text(node: Node) -> str:
    return str(node.value) if isinstance(node, ScalarNode) else "?"


def did_you_mean(text: str, candidates: Iterable[str]) -> str:
    """`` (did you mean "x"?)`` for the closest candidate of ``text``, or an empty string."""
    by_lower = {candidate.lower(): candidate for candidate in candidates}
    match = difflib.get_close_matches(text.lower(), list(by_lower), n=1, cutoff=0.6)
    return f' (did you mean "{by_lower[match[0]]}"?)' if match else ""


def _int(text: str) -> int | None:
    try:
        return int(text.replace("_", ""), 10)
    except ValueError:
        return None


__all__ = [
    "DEFAULT_DATE_FORMATS",
    "DEFAULT_EXTENSIONS",
    "GENERIC_CSV_BROKER_ID",
    "IGNORE_TYPE",
    "KNOWN_KEYS",
    "MAPPING_VERSION",
    "AmountSign",
    "CsvField",
    "CsvMapping",
    "CsvMappingError",
    "CsvMappingIssue",
    "RowErrorPolicy",
    "example_mapping_yaml",
]
