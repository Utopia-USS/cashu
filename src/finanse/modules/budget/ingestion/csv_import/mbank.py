"""mBank (Poland) CSV / statement export importer.

Real format (verified): Windows-1250, ';'-delimited, a metadata preamble that
declares the account number (`#Numer rachunku`) and currency (`#Waluta` — mBank
has PLN, EUR, NOK, HUF "eKonto walutowe" accounts), then a transaction table:

    #Data księgowania;#Data operacji;#Opis operacji;#Tytuł;#Nadawca/Odbiorca;#Numer konta;#Kwota;#Saldo po operacji
"""

from __future__ import annotations

from finanse.core.models import Bank

from .base import ColumnMap, DelimitedImporter, find_account_number


class MBankImporter(DelimitedImporter):
    bank = Bank.MBANK
    encodings = ("cp1250", "utf-8-sig", "iso-8859-2", "utf-8")
    delimiters = (";", ",")
    signature = ("mbank s.a", "#data operacji", "elektroniczne zestawienie operacji")

    colmap = ColumnMap(
        booking_date=("data księgowania", "data operacji", "data transakcji"),
        value_date=("data operacji", "data waluty"),
        amount=("kwota operacji", "kwota"),
        counterparty=("nadawca/odbiorca", "kontrahent", "nadawca", "odbiorca"),
        # mBank labels the counterparty account "#Numer konta".
        counterparty_iban=("numer konta", "numer rachunku kontrahenta", "rachunek kontrahenta"),
        description=("opis operacji", "opis"),
        title=("tytuł", "tytul", "szczegóły", "szczegoly"),
        currency=("waluta",),
        balance=("saldo po operacji", "saldo"),
    )

    def extract_meta(self, text: str) -> tuple[str | None, str]:
        lines = text.splitlines()
        account: str | None = None
        currency = self.default_currency
        for i, line in enumerate(lines):
            s = line.strip()
            if s.startswith("#Numer rachunku") and i + 1 < len(lines):
                account = find_account_number(lines[i + 1]) or account
            elif s.startswith("#Waluta") and i + 1 < len(lines):
                cur = lines[i + 1].strip().strip(";").strip()
                if cur:
                    currency = cur
        return account, currency
