"""Helpers shared by the import tests. All data is synthetic (no real accounts, people or trades)."""

from __future__ import annotations

from datetime import date
from decimal import Decimal
from itertools import count

from cashu.modules.investments.domain import (
    AssetClass,
    Currency,
    Instrument,
    InstrumentAlias,
    TxnType,
)
from cashu.modules.investments.importing import (
    CsvField,
    CsvMapping,
    ImportFile,
    ParsedTxn,
)

PL_MAPPING_YAML = """\
# Synthetic Polish broker export mapping used by the import tests (no real data).
version: 1
name: "Synthetic PL broker"
broker_id: generic_csv
encoding: utf-8
delimiter: ";"
decimal_separator: ","
thousands_separator: " "
date_formats: ["dd.MM.yyyy"]
default_currency: PLN
amount_sign: signed
columns:
  trade_date: "Data"
  type: "Typ"
  symbol: "Symbol"
  isin: "ISIN"
  name: "Nazwa"
  exchange: "Giełda"
  quantity: "Ilość"
  price: "Cena"
  currency: "Waluta"
  fee: "Prowizja"
  cash_amount: "Kwota"
  note: "Opis"
types:
  "Kupno": buy
  "Sprzedaż": sell
  "Dywidenda": dividend
  "Wpłata": deposit
  "Opłata": fee
  "Blokada środków": ignore
"""

PL_EXPORT_LINES = [
    "Data;Typ;Symbol;ISIN;Nazwa;Giełda;Ilość;Cena;Waluta;Prowizja;Kwota;Opis",
    "05.01.2026;Wpłata;;;;;;;PLN;;10 000,00;Wpłata własna",
    "07.01.2026;Kupno;ZGJ;PLZGJ0000010;Zażółć Gęślą Jaźń SA;GPW;10;62,50;PLN;3,13;-628,13;",
    "07.01.2026;Kupno;ZGJ;PLZGJ0000010;Zażółć Gęślą Jaźń SA;GPW;10;62,50;PLN;3,13;-628,13;",
    "12.01.2026;Kupno;ETFW;IE00TEST0001;Świat Akcji UCITS ETF;GPW;3;1 234,50;PLN;5,00;-3 708,50;",
    (
        "20.01.2026;Sprzedaż;ZGJ;PLZGJ0000010;Zażółć Gęślą Jaźń SA;GPW;5;70,00;PLN;1,75;348,25;"
        "Częściowa sprzedaż"
    ),
    (
        "25.01.2026;Dywidenda;ZGJ;PLZGJ0000010;Zażółć Gęślą Jaźń SA;GPW;;;PLN;;12,15;"
        "DYWIDENDA ŹRÓDŁO ŁÓDŹ ĄĆĘŃÓŚŻ"
    ),
    "31.01.2026;Opłata;;;;;;;PLN;;-9,99;Opłata za prowadzenie rachunku",
    "31.01.2026;Blokada środków;;;;;;;PLN;;-100,00;",
]


def pl_export_utf8_bom() -> bytes:
    """The synthetic export as UTF-8 with a byte order mark and CRLF line endings."""
    return ("\r\n".join(PL_EXPORT_LINES) + "\r\n").encode("utf-8-sig")


def pl_export_cp1250() -> bytes:
    """The same rows as Windows-1250 with LF line endings."""
    return ("\n".join(PL_EXPORT_LINES) + "\n").encode("cp1250")


def pl_mapping_yaml(encoding: str = "utf-8") -> str:
    return PL_MAPPING_YAML.replace("encoding: utf-8", f"encoding: {encoding}")


def pl_mapping(encoding: str = "utf-8") -> CsvMapping:
    return CsvMapping.from_yaml(pl_mapping_yaml(encoding))


SIMPLE_HEADER = "ref,date,type,symbol,isin,exchange,qty,price,ccy,fee,cash"
SIMPLE_HEADER_NO_REF = "date,type,symbol,isin,exchange,qty,price,ccy,fee,cash"


def simple_mapping(*, broker_id: str = "generic_csv", with_ref: bool = True) -> CsvMapping:
    """A comma / dot mapping for in-memory CSVs (header :data:`SIMPLE_HEADER`); dates accept a time."""
    columns = {
        CsvField.TRADE_DATE: "date",
        CsvField.TYPE: "type",
        CsvField.SYMBOL: "symbol",
        CsvField.ISIN: "isin",
        CsvField.EXCHANGE: "exchange",
        CsvField.QUANTITY: "qty",
        CsvField.PRICE: "price",
        CsvField.CURRENCY: "ccy",
        CsvField.FEE: "fee",
        CsvField.CASH_AMOUNT: "cash",
    }
    if with_ref:
        columns = {CsvField.EXTERNAL_REF: "ref", **columns}
    return CsvMapping(broker_id=broker_id, default_currency=Currency.PLN, columns=columns)


def csv_file(content: str, name: str = "export.csv") -> ImportFile:
    """An in-memory UTF-8 file."""
    return ImportFile(name, content.encode("utf-8"))


def d(text: str) -> Decimal:
    return Decimal(text)


def day(text: str) -> date:
    return date.fromisoformat(text)


def counter_ids(prefix: str):
    """A deterministic id factory: ``prefix-1``, ``prefix-2``..."""
    numbers = count(1)
    return lambda: f"{prefix}-{next(numbers)}"


def instrument(
    instrument_id: str,
    *,
    name: str = "Orlen",
    symbol: str | None = "PKN",
    isin: str | None = None,
    mic: str | None = "XWAR",
    currency: Currency = Currency.PLN,
    asset_class: AssetClass = AssetClass.EQUITY,
    aliases: tuple[InstrumentAlias, ...] = (),
) -> Instrument:
    return Instrument(
        id=instrument_id,
        name=name,
        currency=currency,
        asset_class=asset_class,
        symbol=symbol,
        isin=isin,
        mic=mic,
        aliases=aliases,
    )


def parsed_txn(
    txn_type: TxnType,
    *,
    row: int = 0,
    trade_date: str = "2026-01-05",
    symbol: str | None = "X",
    currency: Currency = Currency.USD,
    quantity: str | None = "1",
    price: str | None = None,
    gross: str = "1",
    cash: str = "-1",
    trade_time=None,
    external_ref: str | None = None,
) -> ParsedTxn:
    return ParsedTxn(
        row_index=row,
        trade_date=day(trade_date),
        type=txn_type,
        symbol=symbol,
        currency=currency,
        quantity=None if quantity is None else d(quantity),
        price=None if price is None else d(price),
        gross_amount=d(gross),
        cash_amount=d(cash),
        cash_currency=currency,
        trade_time=trade_time,
        external_ref=external_ref,
    )
