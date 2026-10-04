from datetime import date
from decimal import Decimal

from finanse.modules.budget.ingestion.csv_import import detect_importer, parse_file
from finanse.modules.budget.ingestion.csv_import.base import parse_pl_amount, parse_pl_date
from finanse.modules.budget.ingestion.normalize import merchant_key

MBANK_CSV = """mBank S.A.
Lista operacji
#Data operacji;#Opis operacji;#Kwota;#Waluta;#Saldo po operacji
2024-01-05;Sklep ABC;-49,99;PLN;1 950,01
2024-01-06;Wyplata gotowki;5 000,00;PLN;6 950,01
2024-01-06;Kawa;-12,50;PLN;6 937,51
"""


def test_parse_pl_amount():
    assert parse_pl_amount("-1 234,56 PLN") == Decimal("-1234.56")
    assert parse_pl_amount("1.234,56") == Decimal("1234.56")
    assert parse_pl_amount("123,45") == Decimal("123.45")
    assert parse_pl_amount("") is None
    assert parse_pl_amount("  ") is None


def test_parse_pl_date():
    assert parse_pl_date("2024-01-05") == date(2024, 1, 5)
    assert parse_pl_date("05.01.2024") == date(2024, 1, 5)
    assert parse_pl_date("garbage") is None


def test_merchant_key_strips_date_and_location():
    assert (
        merchant_key("CARREFOUR EXPRESS K/KRAKOW              DATA TRANSAKCJI: 2022-03-22")
        == "CARREFOUR EXPRESS K/KRAKOW"
    )
    # empty counterparty falls through to the title
    assert merchant_key("  ", "ANNA NOWAK  UL.PRZYKLADOWA 40") == "ANNA NOWAK"
    assert merchant_key(None, None) == ""


def test_mbank_detection_and_parse(tmp_path):
    f = tmp_path / "mbank.csv"
    f.write_text(MBANK_CSV, encoding="cp1250")

    importer = detect_importer(f)
    assert importer is not None and importer.bank == "mbank"

    stmt = parse_file(f)
    assert stmt.bank == "mbank"
    assert len(stmt.transactions) == 3

    amounts = {t.amount for t in stmt.transactions}
    assert amounts == {Decimal("-49.99"), Decimal("-12.50"), Decimal("5000.00")}
    # running balances captured
    assert len(stmt.balances) == 3
