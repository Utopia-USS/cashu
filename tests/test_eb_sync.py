"""Enable Banking field mapping: the human title must be the remittance, never
the opaque entry_reference (which belongs in bank_transaction_id)."""

from datetime import date
from decimal import Decimal

from sqlmodel import select

from finanse.core.accounts import get_or_create_account
from finanse.models import Source, Transaction
from finanse.modules.budget.ingestion.enable_banking.sync import (
    eb_transaction_to_raw,
    reprocess_open_banking_fields,
)

_CARD_TXN = {
    "entry_reference": "2026-07-22/99999999999/6",
    "transaction_amount": {"currency": "PLN", "amount": "82.54"},
    "credit_debit_indicator": "DBIT",
    "creditor": {"name": "LIDL KOBIERZYNSKA"},
    "creditor_account": {"iban": "PL10000000000000000000000011"},
    "booking_date": "2026-07-22",
    "remittance_information": [
        "VISA PLAT 400000******0000 PŁATNOŚĆ KARTĄ 82.54 PLN  LIDL KOBIERZYNSKA Krakow",
        "TRANSAKCJA KARTĄ",
    ],
}


def test_title_is_remittance_not_entry_reference():
    rt = eb_transaction_to_raw(_CARD_TXN)
    assert rt.bank_transaction_id == "2026-07-22/99999999999/6"
    # The opaque bank id must NOT be the title.
    assert rt.reference and "99999999999" not in rt.reference
    assert "LIDL KOBIERZYNSKA" in rt.reference
    assert rt.counterparty_name == "LIDL KOBIERZYNSKA"
    assert rt.amount == Decimal("-82.54")


def test_reprocess_fixes_legacy_rows(session):
    acc = get_or_create_account(session, bank="mbank", iban="99114000000000000000000009")
    # Simulate a row imported by the OLD mapping (bank id stored as the title).
    t = Transaction(
        account_id=acc.id,
        booking_date=date(2026, 7, 22),
        amount=Decimal("-82.54"),
        currency="PLN",
        counterparty_name="LIDL KOBIERZYNSKA",
        reference="2026-07-22/99999999999/6",  # WRONG: opaque id shown as title
        description="2026-07-22/99999999999/6",
        bank_transaction_id="2026-07-22/99999999999/6",
        source=Source.OPEN_BANKING,
        dedup_hash="eb-1",
        raw=_CARD_TXN,
    )
    session.add(t)
    session.flush()

    n = reprocess_open_banking_fields(session)
    assert n == 1

    fixed = session.exec(select(Transaction)).first()
    assert "99999999999" not in fixed.reference
    assert "LIDL KOBIERZYNSKA" in fixed.reference
    assert fixed.bank_transaction_id == "2026-07-22/99999999999/6"
