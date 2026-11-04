"""Importer for any delimited text export, driven by a :class:`CsvMapping`."""

from __future__ import annotations

import csv
import io
import re
from dataclasses import dataclass
from datetime import date, time
from decimal import Decimal

from ..domain import Currency, TxnType
from .cash import AmountError, derive_amounts, signed_cash
from .contract import ImportFile, ImportParseResult, ImportWarning, ImportWarningKind, ParsedTxn
from .csv_mapping import AmountSign, CsvField, CsvMapping, RowErrorPolicy
from .csv_values import DatePattern, parse_datetime_with_patterns
from .text import decode_import_text

ISIN_PATTERN = re.compile(r"^[A-Z]{2}[A-Z0-9]{9}[0-9]$")

SNIFF_BYTES = 64 * 1024
"""How many leading bytes :meth:`GenericCsvImporter.can_parse` decodes to find the header row."""


class _RowError(Exception):
    def __init__(self, message: str, kind: str = ImportWarningKind.INVALID_VALUE) -> None:
        super().__init__(message)
        self.message = message
        self.kind = kind


class GenericCsvImporter:
    """A :class:`~.contract.BrokerImporter` for delimited text driven by a :class:`CsvMapping`.

    It only produces transactions (no positions). Row problems become warnings (blocking or not per
    ``mapping.on_row_error``); file-level problems (encoding, missing columns) are always blocking.
    """

    PARSER_VERSION = 1
    """Version of the parsing logic (not of the mapping)."""

    def __init__(self, mapping: CsvMapping) -> None:
        self.mapping = mapping
        self._date_patterns = [DatePattern(fmt) for fmt in mapping.date_formats]
        self._types = {_normalize(key): value for key, value in mapping.types.items()}
        self._ignored = {_normalize(key) for key in mapping.ignored_types}

    @property
    def broker_id(self) -> str:
        return self.mapping.broker_id

    @property
    def display_name(self) -> str:
        return self.mapping.display_name

    @property
    def version(self) -> int:
        return self.PARSER_VERSION

    def can_parse(self, file: ImportFile) -> bool:
        """True when the extension is accepted and the header row contains every mapped column."""
        if file.extension not in self.mapping.extensions:
            return False
        data = file.content
        if len(data) > SNIFF_BYTES:
            # Cut at a line break: 0x0A never occurs inside a multi-byte UTF-8 sequence.
            cut = data.rfind(b"\n", 0, SNIFF_BYTES)
            data = data[: cut + 1] if cut > 0 else data[:SNIFF_BYTES]
        try:
            records = self._records(decode_import_text(data, self.mapping.encoding, lenient=True))
        except (ValueError, csv.Error):
            return False
        if len(records) <= self.mapping.header_row:
            return False
        header = records[self.mapping.header_row]
        return all(_header_index(header, name) >= 0 for name in self.mapping.columns.values())

    def parse(self, file: ImportFile) -> ImportParseResult:
        mapping = self.mapping
        try:
            text = decode_import_text(file.content, mapping.encoding)
        except UnicodeDecodeError as error:
            return _blocked(
                f"File is not valid UTF-8 ({error.reason} at byte {error.start}); "
                "set encoding to windows-1250 or auto in the mapping"
            )
        try:
            records = self._records(text)
        except csv.Error as error:
            return _blocked(f"File is not readable as CSV: {error}")
        if len(records) <= mapping.header_row:
            return _blocked(f"File has no header row at record {mapping.header_row}")
        header = records[mapping.header_row]
        index: dict[CsvField, int] = {}
        missing: list[str] = []
        for target, name in mapping.columns.items():
            position = _header_index(header, name)
            if position < 0:
                missing.append(name)
            else:
                index[target] = position
        if missing:
            return _blocked(
                "Missing columns: " + ", ".join(f'"{name}"' for name in missing),
                ImportWarningKind.MISSING_COLUMN,
            )

        txns: list[ParsedTxn] = []
        warnings: list[ImportWarning] = []
        skip = mapping.on_row_error == RowErrorPolicy.SKIP
        for r in range(mapping.header_row + 1, len(records)):
            cells = records[r]
            if all(not cell.strip() for cell in cells):
                continue
            row_index = r - mapping.header_row - 1
            raw = {header[i]: cells[i] if i < len(cells) else "" for i in range(len(header))}
            row = _Row(row_index, cells, index, raw)
            try:
                txn = self._parse_row(row, warnings)
            except _RowError as error:
                message = f"{error.message}; row skipped" if skip else error.message
                warnings.append(
                    ImportWarning(
                        message=message,
                        row=row_index,
                        blocking=not skip,
                        kind=ImportWarningKind.IGNORED_ROW if skip else error.kind,
                    )
                )
                continue
            if txn is not None:
                txns.append(txn)
        return ImportParseResult(txns=txns, warnings=warnings)

    # --- rows ------------------------------------------------------------------------------------

    def _records(self, text: str) -> list[list[str]]:
        reader = csv.reader(
            io.StringIO(text, newline=""),
            delimiter=self.mapping.delimiter,
            quotechar=self.mapping.quote,
        )
        return [list(record) for record in reader]

    def _parse_row(self, row: _Row, warnings: list[ImportWarning]) -> ParsedTxn | None:
        type_text = row.cell(CsvField.TYPE)
        date_text = row.cell(CsvField.TRADE_DATE)
        if type_text is None and date_text is None:
            warnings.append(
                ImportWarning(
                    message="Row has no date and no type; skipped",
                    row=row.index,
                    kind=ImportWarningKind.IGNORED_ROW,
                )
            )
            return None
        if type_text is None:
            raise _RowError("type is empty", ImportWarningKind.MISSING_VALUE)
        type_key = _normalize(type_text)
        if type_key in self._ignored:
            warnings.append(
                ImportWarning(
                    message=f'Type "{type_text}" is ignored by the mapping',
                    row=row.index,
                    kind=ImportWarningKind.IGNORED_ROW,
                )
            )
            return None
        txn_type = self._types.get(type_key) or _wire_type(type_key)
        if txn_type is None:
            raise _RowError(
                f'unknown type "{type_text}" (add it under types: in the mapping)',
                ImportWarningKind.UNMAPPED_TYPE,
            )

        parsed_date = self._date_time(row, CsvField.TRADE_DATE)
        if parsed_date is None:
            raise _RowError("trade_date is empty", ImportWarningKind.MISSING_VALUE)
        trade_date, trade_time = parsed_date
        currency = self._currency(row, CsvField.CURRENCY) or self.mapping.default_currency
        if currency is None:
            raise _RowError(
                "no currency in the row and no default_currency in the mapping",
                ImportWarningKind.MISSING_VALUE,
            )
        cash_currency = self._currency(row, CsvField.CASH_CURRENCY) or currency

        quantity = _abs(self._number(row, CsvField.QUANTITY))
        price = _abs(self._number(row, CsvField.PRICE))
        fee = _abs(self._number(row, CsvField.FEE)) or Decimal(0)
        tax = _abs(self._number(row, CsvField.TAX)) or Decimal(0)
        fx_rate = _abs(self._number(row, CsvField.FX_RATE))
        raw_cash = self._number(row, CsvField.CASH_AMOUNT)
        try:
            cash = (
                None
                if raw_cash is None
                else signed_cash(
                    txn_type, raw_cash, absolute=self.mapping.amount_sign == AmountSign.ABSOLUTE
                )
            )
            amounts = derive_amounts(
                txn_type=txn_type,
                currency=currency,
                cash_currency=cash_currency,
                gross=self._number(row, CsvField.GROSS_AMOUNT),
                cash=cash,
                quantity=quantity,
                price=price,
                fee=fee,
                tax=tax,
                fx_rate=fx_rate,
            )
        except AmountError as error:
            raise _RowError(str(error), error.kind) from None

        isin = row.cell(CsvField.ISIN)
        if isin is not None:
            isin = isin.upper()
            if not ISIN_PATTERN.match(isin):
                warnings.append(
                    ImportWarning(
                        message=f'Ignored invalid ISIN "{isin}"',
                        row=row.index,
                        kind=ImportWarningKind.INVALID_VALUE,
                    )
                )
                isin = None

        settle = self._date_time(row, CsvField.SETTLE_DATE)
        return ParsedTxn(
            row_index=row.index,
            external_ref=row.cell(CsvField.EXTERNAL_REF),
            trade_date=trade_date,
            trade_time=trade_time,
            settle_date=None if settle is None else settle[0],
            type=txn_type,
            symbol=row.cell(CsvField.SYMBOL),
            isin=isin,
            name=row.cell(CsvField.NAME),
            exchange_hint=row.cell(CsvField.EXCHANGE),
            quantity=quantity,
            price=price,
            currency=currency,
            gross_amount=amounts.gross_amount,
            fee=fee,
            tax=tax,
            cash_amount=amounts.cash_amount,
            cash_currency=cash_currency,
            fx_rate=fx_rate,
            split_ratio=_abs(self._number(row, CsvField.SPLIT_RATIO)),
            note=row.cell(CsvField.NOTE),
            raw_row=row.raw,
        )

    def _number(self, row: _Row, target: CsvField) -> Decimal | None:
        text = row.cell(target)
        if text is None:
            return None
        number_format = self.mapping.number_format
        try:
            return number_format.parse(text)
        except ValueError:
            raise _RowError(
                f'{target.value}: "{text}" is not a number (decimal '
                f'"{number_format.decimal_separator}", thousands '
                f'"{number_format.thousands_separator}")'
            ) from None

    def _date_time(self, row: _Row, target: CsvField) -> tuple[date, time | None] | None:
        text = row.cell(target)
        if text is None:
            return None
        try:
            return parse_datetime_with_patterns(text, self._date_patterns)
        except ValueError as error:
            raise _RowError(f'{target.value}: "{text}" - {error}') from None

    @staticmethod
    def _currency(row: _Row, target: CsvField) -> Currency | None:
        text = row.cell(target)
        if text is None:
            return None
        try:
            return Currency(text)
        except ValueError:
            raise _RowError(f'{target.value}: "{text}" is not an ISO 4217 currency code') from None


@dataclass(frozen=True, slots=True)
class _Row:
    index: int
    cells: list[str]
    columns: dict[CsvField, int]
    raw: dict[str, str]

    def cell(self, target: CsvField) -> str | None:
        """Trimmed cell of ``target``, or None when unmapped, missing or blank."""
        position = self.columns.get(target)
        if position is None or position >= len(self.cells):
            return None
        value = self.cells[position].strip()
        return value or None


def _blocked(message: str, kind: str = ImportWarningKind.FILE_FORMAT) -> ImportParseResult:
    return ImportParseResult(warnings=[ImportWarning(message=message, blocking=True, kind=kind)])


def _wire_type(key: str) -> TxnType | None:
    try:
        return TxnType(key)
    except ValueError:
        return None


def _abs(value: Decimal | None) -> Decimal | None:
    return None if value is None else value.copy_abs()


def _normalize(value: str) -> str:
    return value.replace("﻿", "").strip().lower()


def _header_index(header: list[str], name: str) -> int:
    wanted = _normalize(name)
    for i, cell in enumerate(header):
        if _normalize(cell) == wanted:
            return i
    return -1


__all__ = ["ISIN_PATTERN", "SNIFF_BYTES", "GenericCsvImporter"]
