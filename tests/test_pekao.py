"""Bank Pekao CSV importer: header detection, own-account inference, and the
source/destination -> counterparty resolution."""

from decimal import Decimal

from finanse.modules.budget.ingestion.csv_import import detect_importer, parse_file

PEKAO_CSV = """Data księgowania;Data waluty;Nadawca / Odbiorca;Adres nadawcy / odbiorcy;Rachunek źródłowy;Rachunek docelowy;Tytułem;Kwota operacji;Waluta;Numer referencyjny;Typ operacji;Kategoria
14.01.2026;14.01.2026;JAN KOWALSKI;UL. X;'10000000000000000000000001;'10000000000000000000000002;KREDYT;50,00;PLN;'0AN0000009912030;PRZELEW KRAJOWY;Przelew
15.01.2026;15.01.2026;;;'10000000000000000000000002;'10000000000000000000000003;SPŁATA KREDYTU;-1 540,00;PLN;'146261FA74285006;SPŁATA KREDYTU;Spłata kredytu
16.01.2026;16.01.2026;ADAM;;'10000000000000000000000009;'10000000000000000000000002;joga;125,00;PLN;'M042000202707777;PRZELEW BLIK;Inne
"""


def test_detect_and_parse_pekao(tmp_path):
    f = tmp_path / "Lista_operacji.csv"
    f.write_text(PEKAO_CSV, encoding="utf-8")

    assert detect_importer(f).bank == "pekao"

    stmt = parse_file(f)
    assert stmt.bank == "pekao"
    # Own account = the one common to every row (the 38124… settlement account).
    assert stmt.account_number == "10000000000000000000000002"
    assert len(stmt.transactions) == 3

    incoming, repayment, blik = stmt.transactions
    # Incoming loan funding: +50, counterparty is the SOURCE (mBank).
    assert incoming.amount == Decimal("50.00")
    assert incoming.counterparty_iban == "10000000000000000000000001"
    # Outgoing repayment: -1540, counterparty is the DESTINATION (loan account).
    assert repayment.amount == Decimal("-1540.00")
    assert repayment.counterparty_iban == "10000000000000000000000003"
    assert blik.amount == Decimal("125.00")
    # No running-balance column -> no balance snapshots.
    assert stmt.balances == []
